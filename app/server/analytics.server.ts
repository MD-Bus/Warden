import { DAY_MS, emptySeries, LIST_LIMIT, periodStart, type FileTraffic, type IpTraffic, type LicenseTraffic, type InvalidReason, type TrafficReport, type TrafficTotals } from "../lib/analytics"
import { DEFAULT_STATUSES, grantsAccess, statusLabel, type StatusSet } from "../lib/statuses"
import { findBlock } from "./ip-blocks.server"
import { loadStatusSets, setForApp, type StatusSets } from "./statuses.server"

/**
 * Traffic analytics, computed from the activity log when asked (no counters to keep in sync).
 *
 * Whether a check was valid is decided by the status recorded with it, read against the licence's statuses as they
 * are today: changing whether a status is valid changes how its past checks are counted. Each figure reads the
 * rows of one kind of event over the period (index on event, at); checks older than 90 days are deleted daily, which
 * bounds that work.
 */

/** What the report covers: everything, one app, the standalone licences, or one licence. */
export type TrafficScope = { app?: string } | { standalone: true } | { license: string } | Record<string, never>

/** Refusals decided before the status is read. The site is not registered, so it is not counted as an active site. */
const SITE_NOT_REGISTERED = ["domain_mismatch", "site_limit_reached"]

/** Which set of statuses a licence's checks are read against: "a:<app>", "l:<licence>" (own statuses) or "" (defaults). */
const OWNER = `CASE WHEN COALESCE(a.app_id,l.app_id) IS NOT NULL THEN 'a:' || COALESCE(a.app_id,l.app_id) WHEN EXISTS (SELECT 1 FROM statuses s WHERE s.license_id = l.id) THEN 'l:' || l.id ELSE '' END`

/** The scope as a condition on `l` (the licence); `licenseColumn` is the licence id column of the table read. */
function scopeSql(scope: TrafficScope, licenseColumn = "a.license_id"): { sql: string; binds: string[] } {
  if ("license" in scope && scope.license) return { sql: ` AND ${licenseColumn} = ?`, binds: [scope.license] }
  if ("app" in scope && scope.app) return { sql: licenseColumn === "ac.license_id" ? " AND (l.app_id = ? OR EXISTS (SELECT 1 FROM license_apps e WHERE e.license_id=l.id AND e.app_id=?))" : " AND COALESCE(a.app_id,l.app_id) = ?", binds: licenseColumn === "ac.license_id" ? [scope.app,scope.app] : [scope.app] }
  if ("standalone" in scope && scope.standalone) return { sql: " AND l.app_id IS NULL", binds: [] }
  return { sql: "", binds: [] }
}

function setOfOwner(sets: StatusSets, owner: string): StatusSet {
  if (owner.startsWith("a:")) return setForApp(sets, owner.slice(2))
  if (owner.startsWith("l:")) return sets.byLicense[owner.slice(2)] ?? DEFAULT_STATUSES
  return DEFAULT_STATUSES
}

type CheckRow = { day: number; status: string; owner: string; n: number }

/** The checks of the period grouped by day, status and status set: the base of the daily series and the reasons. */
async function checksByDay(env: Env, scope: TrafficScope, from: number): Promise<CheckRow[]> {
  const s = scopeSql(scope)
  return (
    await env.DB.prepare(
      `SELECT CAST(a.at / ${DAY_MS} AS INTEGER) AS day, a.status AS status, ${OWNER} AS owner, COUNT(*) AS n
       FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event = 'check' AND a.at >= ?${s.sql} GROUP BY day, a.status, owner`
    )
      .bind(from, ...s.binds)
      .all<CheckRow>()
  ).results
}

/**
 * The checks of each day split into valid and invalid, plus sites and downloads per day. With `parts = "checks"`
 * only the checks are read, for the small charts of the overview and licence pages.
 */
export async function dailyTraffic(env: Env, scope: TrafficScope, days: number, now = Date.now(), parts: "checks" | "all" = "all") {
  const from = periodStart(days, now)
  const s = scopeSql(scope)
  const none = Promise.resolve({ results: [] as { day: number; n: number }[] })
  const [checks, sites, downloads, statusSets] = await Promise.all([
    checksByDay(env, scope, from),
    parts === "checks" ? none : env.DB.prepare(
      `SELECT CAST(a.at / ${DAY_MS} AS INTEGER) AS day, COUNT(DISTINCT a.license_id || ' ' || a.domain) AS n
       FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event = 'check' AND a.at >= ? AND a.domain IS NOT NULL AND a.status NOT IN ('domain_mismatch', 'site_limit_reached')${s.sql} GROUP BY day`
    )
      .bind(from, ...s.binds)
      .all<{ day: number; n: number }>(),
    parts === "checks" ? none : env.DB.prepare(
      `SELECT CAST(a.at / ${DAY_MS} AS INTEGER) AS day, COUNT(*) AS n
       FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event = 'download' AND a.at >= ? AND a.detail LIKE 'Downloaded: %'${s.sql} GROUP BY day`
    )
      .bind(from, ...s.binds)
      .all<{ day: number; n: number }>(),
    loadStatusSets(env),
  ])

  const series = emptySeries(days, now)
  const at = (day: number) => series[day - from / DAY_MS]
  for (const row of checks) {
    const entry = at(row.day)
    if (!entry) continue
    if (isValid(statusSets, row)) entry.valid += row.n
    else entry.invalid += row.n
  }
  for (const row of sites.results) if (at(row.day)) at(row.day).sites = row.n
  for (const row of downloads.results) if (at(row.day)) at(row.day).downloads = row.n
  return { from, series, checks, sets: statusSets }
}

const isValid = (sets: StatusSets, row: { status: string; owner: string }) => !SITE_NOT_REGISTERED.includes(row.status) && grantsAccess(setOfOwner(sets, row.owner), row.status)

/** The full report of the Analytics page and of GET /api/v1/analytics. */
export async function trafficReport(env: Env, scope: TrafficScope, days: number, now = Date.now()): Promise<TrafficReport> {
  const from = periodStart(days, now)
  const s = scopeSql(scope)

  const whole = Object.keys(scope).length === 0
  // The daily series and the totals are independent queries: they are sent together.
  const [daily, siteTotals, refusedDownloads, perLicense, files, perIp, licensesPerIp, guarded, newSites] = await Promise.all([
    dailyTraffic(env, scope, days, now),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT a.license_id || ' ' || a.domain) AS sites
       FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event = 'check' AND a.at >= ? AND a.domain IS NOT NULL AND a.status NOT IN ('domain_mismatch', 'site_limit_reached')${s.sql}`
    )
      .bind(from, ...s.binds)
      .first<{ sites: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event = 'download' AND a.at >= ? AND (a.detail LIKE 'Download denied: %' OR a.detail LIKE 'Download refused: %')${s.sql}`
    )
      .bind(from, ...s.binds)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT a.license_id AS id, l.name AS name, ap.name AS app_name, l.last_check_at AS last_check_at, a.status AS status, ${OWNER} AS owner, COUNT(*) AS n
       FROM activity a JOIN licenses l ON l.id = a.license_id LEFT JOIN apps ap ON ap.id = COALESCE(a.app_id,l.app_id)
       WHERE a.event = 'check' AND a.at >= ?${s.sql} GROUP BY a.license_id, a.status`
    )
      .bind(from, ...s.binds)
      .all<{ id: string; name: string; app_name: string | null; last_check_at: number | null; status: string; owner: string; n: number }>(),
    env.DB.prepare(
      `SELECT substr(a.detail, 13) AS name, COUNT(*) AS downloads
       FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event = 'download' AND a.at >= ? AND a.detail LIKE 'Downloaded: %'${s.sql} GROUP BY a.detail ORDER BY downloads DESC, name LIMIT ${LIST_LIMIT}`
    )
      .bind(from, ...s.binds)
      .all<FileTraffic>(),
    env.DB.prepare(
      `SELECT a.ip AS ip, a.event AS event, a.status AS status, ${OWNER} AS owner, COUNT(*) AS n
       FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event IN ('check', 'download') AND a.at >= ? AND a.ip IS NOT NULL${s.sql} GROUP BY a.ip, a.event, a.status, owner`
    )
      .bind(from, ...s.binds)
      .all<{ ip: string; event: "check" | "download"; status: string; owner: string; n: number }>(),
    env.DB.prepare(
      `SELECT a.ip AS ip, COUNT(DISTINCT a.license_id) AS n FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.event IN ('check', 'download') AND a.at >= ? AND a.ip IS NOT NULL${s.sql} GROUP BY a.ip`
    )
      .bind(from, ...s.binds)
      .all<{ ip: string; n: number }>(),
    whole
      ? env.DB.prepare("SELECT kind, SUM(count) AS n FROM refused_requests WHERE day >= ? GROUP BY kind").bind(from / DAY_MS).all<{ kind: string; n: number }>()
      : Promise.resolve(null),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM activations ac JOIN licenses l ON l.id = ac.license_id WHERE ac.first_seen_at >= ?${scopeSql(scope, "ac.license_id").sql}`)
      .bind(from, ...scopeSql(scope, "ac.license_id").binds)
      .first<{ n: number }>(),
  ])
  const { series, checks, sets } = daily

  // Refusals by reason. The same key can be labelled differently by two sets; the first label seen is kept.
  const reasons = new Map<string, InvalidReason>()
  for (const row of checks) {
    if (isValid(sets, row)) continue
    const reason = reasons.get(row.status) ?? { key: row.status, label: statusLabel(setOfOwner(sets, row.owner), row.status), checks: 0 }
    reason.checks += row.n
    reasons.set(row.status, reason)
  }

  const licenses = new Map<string, LicenseTraffic>()
  for (const row of perLicense.results) {
    const entry = licenses.get(row.id) ?? { id: row.id, name: row.name, app_name: row.app_name, checks: 0, invalid: 0, last_check_at: row.last_check_at }
    entry.checks += row.n
    if (!isValid(sets, row)) entry.invalid += row.n
    licenses.set(row.id, entry)
  }

  const ips = new Map<string, IpTraffic>()
  for (const row of perIp.results) {
    const entry = ips.get(row.ip) ?? { ip: row.ip, checks: 0, invalid: 0, downloads: 0, licenses: 0, blocked: false }
    if (row.event === "check") {
      entry.checks += row.n
      if (!isValid(sets, row)) entry.invalid += row.n
    } else entry.downloads += row.n
    ips.set(row.ip, entry)
  }
  for (const row of licensesPerIp.results) {
    const entry = ips.get(row.ip)
    if (entry) entry.licenses = row.n
  }
  const topIps = [...ips.values()].sort((a, b) => b.checks + b.downloads - (a.checks + a.downloads) || a.ip.localeCompare(b.ip)).slice(0, LIST_LIMIT)
  for (const entry of topIps) entry.blocked = (await findBlock(env, entry.ip, now)) !== null
  const guardedCount = (kind: string) => guarded?.results.find((r) => r.kind === kind)?.n ?? 0

  const valid = series.reduce((n, d) => n + d.valid, 0)
  const invalid = series.reduce((n, d) => n + d.invalid, 0)
  const totals: TrafficTotals = {
    checks: valid + invalid,
    valid,
    invalid,
    sites: siteTotals?.sites ?? 0,
    new_sites: newSites?.n ?? 0,
    downloads: series.reduce((n, d) => n + d.downloads, 0),
    denied_downloads: refusedDownloads?.n ?? 0,
    blocked: whole ? guardedCount("blocked") : null,
    rate_limited: whole ? guardedCount("rate_limited") : null,
  }
  return {
    days,
    from,
    to: now,
    series,
    totals,
    reasons: [...reasons.values()].sort((a, b) => b.checks - a.checks),
    licenses: [...licenses.values()].sort((a, b) => b.checks - a.checks || a.name.localeCompare(b.name)).slice(0, LIST_LIMIT),
    files: files.results,
    ips: topIps,
  }
}
