import type { AttachmentFacts } from "../lib/entitlements"
import { attachmentContext, listAttachments, scanBundleEvents } from "./entitlements.server"
import { generateLicenseKey, normalizeDomain, parseDomains } from "../lib/license"
import { defaultStatusKey, effectiveStatusKey, expirySources, findStatus, graceEndsAt, MAX_GRACE_DAYS, statusLabel, type StatusSet } from "../lib/statuses"
import { deleteLicenseFiles } from "./files.server"
import { getStatusSetForLicense, loadStatusSets, setForApp, setForLicense, type StatusSets } from "./statuses.server"
import { inView, LAPSED_ATTENTION_DAYS, SILENT_AFTER_DAYS } from "../lib/views"
import { emitLicenseEvent } from "./webhooks.server"
import { newId } from "./util.server"

export type License = {
  id: string
  apps?: AttachmentFacts[]
  expiry_mode?: "legacy" | "shared" | "separate"
  attachment_id?: string
  tag?: string
  name: string
  customer_name: string
  customer_email: string
  license_key: string
  /** Key of the licence's status, within the status set of its app (or the default set). */
  status: string
  expires_at: number | null
  domains: string
  /** Maximum number of distinct sites (domains) the licence may be used on. Null means unlimited. */
  max_sites: number | null
  message: string
  notes: string
  app_id: string | null
  created_at: number
  updated_at: number
  last_check_at: number | null
  last_check_domain: string | null
  check_count: number
  external_ref: string | null
  /** Days the licence stays valid after its expiry date. Null: its app's setting; 0: none. */
  grace_days: number | null
  /** Expiry date (grace period) and last check (no recent check) last reported to webhooks. */
  grace_notified_for?: number | null
  expired_notified_for?: number | null
  silent_notified_for?: number | null
  /** Joined from the app, when the licence belongs to one. */
  app_slug?: string | null
  app_name?: string | null
  app_grace_days?: number | null
  /** Number of sites the licence has been used on. */
  sites_used?: number
}

export type Activity = { app_id?: string | null; tag?: string | null; id: number; at: number; event: "check" | "change" | "download"; status: string | null; domain: string | null; detail: string; /** Caller of a check or a download. */ ip: string | null }

export type Activation = {
  domain: string
  first_seen_at: number
  last_seen_at: number
  check_count: number
  /** The version the site last reported with its check, or null. */
  version: string | null
  /** The address the site last checked from, or null. */
  last_ip: string | null
}

export type LicenseInput = {
  name: string
  customer_name: string
  customer_email: string
  app_id: string | null
  max_sites: number | null
  status: string
  expires_at: number | null
  domains: string
  message: string
  notes: string
  external_ref?: string | null
  /** Days the licence stays valid after its expiry date. Null: its app's setting; 0: none. Left out: unchanged (null on create). */
  grace_days?: number | null
}

export const MAX_SITES_LIMIT = 100_000

/** Parses an optional positive whole number. Empty input means "no value" (null). Returns "invalid" for anything else. */
export function parseOptionalCount(raw: unknown, max = MAX_SITES_LIMIT): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === "") return null
  const n = typeof raw === "number" ? raw : Number(String(raw).trim())
  return Number.isInteger(n) && n >= 1 && n <= max ? n : "invalid"
}

export function validEmail(value: string): boolean {
  return value === "" || (value.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
}

/** Parses a number of grace days: empty is null, otherwise a whole number from `min` to 365. */
export function parseGraceDays(raw: unknown, min: 0 | 1): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === "") return null
  const n = typeof raw === "number" ? raw : Number(String(raw).trim())
  return Number.isInteger(n) && n >= min && n <= MAX_GRACE_DAYS ? n : "invalid"
}

/** Validates the dashboard form and returns the cleaned input, or an error message. */
/** `licenseId` is given when editing an existing licence, which may have statuses of its own. `ownStatuses` are the statuses drafted in the create form, if any. */
export function readLicenseForm(form: FormData, sets: StatusSets, licenseId = "", ownStatuses?: StatusSet): { input: LicenseInput } | { error: string } {
  const name = String(form.get("name") ?? "").trim()
  if (!name) return { error: "Enter a name for the licence." }
  if (name.length > 120) return { error: "The name must be 120 characters or fewer." }
  const appId = String(form.get("app_id") ?? "").trim() || null
  const set = ownStatuses ?? setForLicense(sets, { id: licenseId, app_id: appId })
  const status = String(form.get("status") ?? defaultStatusKey(set))
  if (!findStatus(set, status)) return { error: "Choose a status that exists for this licence's app." }

  const expiresRaw = String(form.get("expires_at") ?? "").trim()
  let expires_at: number | null = null
  if (expiresRaw) {
    // The date picker submits YYYY-MM-DD. The licence stays valid through the end of that day (UTC).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresRaw)) return { error: "Enter the expiry date as YYYY-MM-DD." }
    expires_at = Date.parse(`${expiresRaw}T23:59:59.999Z`)
    if (Number.isNaN(expires_at)) return { error: "That expiry date is not a valid date." }
  }

  const domainText = String(form.get("domains") ?? "")
  const invalidDomain = domainText.split(/[\s,]+/).filter(Boolean).find((d) => !normalizeDomain(d))
  if (invalidDomain) return { error: `"${invalidDomain}" is not a valid domain.` }

  const maxSites = parseOptionalCount(form.get("max_sites"))
  if (maxSites === "invalid") return { error: "Maximum sites must be a whole number of 1 or more, or empty for unlimited." }

  const customerEmail = String(form.get("customer_email") ?? "").trim()
  if (!validEmail(customerEmail)) return { error: "Enter a valid customer email address." }

  const graceDays = parseGraceDays(form.get("grace_days"), 0)
  if (graceDays === "invalid") return { error: `The grace period must be a whole number of days from 0 to ${MAX_GRACE_DAYS}, or empty.` }

  return {
    input: {
      name,
      customer_name: String(form.get("customer_name") ?? "").trim().slice(0, 120),
      customer_email: customerEmail,
      app_id: appId,
      max_sites: maxSites,
      status,
      expires_at,
      domains: parseDomains(domainText).join(", "),
      message: String(form.get("message") ?? "").trim().slice(0, 300),
      notes: String(form.get("notes") ?? "").trim().slice(0, 4000),
      grace_days: graceDays,
    },
  }
}

const SELECT_LICENSES = `SELECT l.*, a.slug AS app_slug, a.name AS app_name, a.grace_days AS app_grace_days,
  (SELECT COUNT(*) FROM activations x WHERE x.license_id = l.id) AS sites_used
  FROM licenses l LEFT JOIN apps a ON a.id = l.app_id`

export async function createLicense(env: Env, input: LicenseInput): Promise<License> {
  const now = Date.now()
  const id = newId("lic")
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO licenses (id, name, customer_name, customer_email, license_key, app_id, max_sites, status, expires_at, domains, message, notes, external_ref, grace_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, input.name, input.customer_name, input.customer_email, generateLicenseKey(), input.app_id, input.max_sites, input.status, input.expires_at, input.domains, input.message, input.notes, input.external_ref ?? null, input.grace_days ?? null, now, now),
    logChange(env, id, now, input.status, "Licence created"),
  ])
  const license = (await getLicense(env, id))!
  await emitLicenseEvent(env, "license.created", license)
  return license
}

export function getLicense(env: Env, id: string): Promise<License | null> {
  return env.DB.prepare(`${SELECT_LICENSES} WHERE l.id = ?`).bind(id).first<License>()
}

export function getLicenseByKey(env: Env, key: string): Promise<License | null> {
  return env.DB.prepare(`${SELECT_LICENSES} WHERE l.license_key = ?`).bind(key).first<License>()
}

export function getLicenseByRef(env: Env, ref: string): Promise<License | null> {
  return env.DB.prepare(`${SELECT_LICENSES} WHERE l.external_ref = ?`).bind(ref).first<License>()
}

export type LicenseFilters = {
  /** A licence status. "active" and "expired" use the effective status (the expiry date is taken into account). */
  status?: string
  q?: string
  externalRef?: string
  appId?: string
  /** Return licences older than this licence id (for paging). */
  before?: string
  limit: number
}

/** Licences read per query while filtering by status. */
const STATUS_SCAN_BATCH = 200

/**
 * Lists licences, newest first. The status filter uses the status reported to sites, which depends on each licence's
 * statuses and expiry date, so it is applied in code: licences are read in batches until enough match. (Building it
 * into SQL would need one bound value per customised app or licence, and D1 accepts at most 100 per query.)
 */
export async function queryLicenses(env: Env, filters: LicenseFilters, now = Date.now()): Promise<License[]> {
  const where: string[] = []
  const args: (string | number)[] = []
  const search = filters.q?.trim()
  if (search) {
    const like = `%${search.replace(/[%_\\]/g, "\\$&")}%`
    const columns = ["l.name", "l.customer_name", "l.customer_email", "l.license_key", "l.domains", "l.external_ref", "a.name"]
    where.push(`(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")} OR EXISTS (SELECT 1 FROM license_apps e JOIN apps ap ON ap.id=e.app_id WHERE e.license_id=l.id AND (ap.name LIKE ? ESCAPE '\\' OR e.tag LIKE ? ESCAPE '\\')))`)
    args.push(...columns.map(() => like),like,like)
  }
  if (filters.externalRef) {
    where.push("l.external_ref = ?")
    args.push(filters.externalRef)
  }
  if (filters.appId) {
    where.push("(l.app_id = ? OR EXISTS (SELECT 1 FROM license_apps e WHERE e.license_id = l.id AND e.app_id = ?))")
    args.push(filters.appId, filters.appId)
  }
  const page = async (before: string | undefined, limit: number) => {
    const conditions = before ? [...where, "l.id < ?"] : where
    const sql = `${SELECT_LICENSES} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY l.id DESC LIMIT ?`
    return hydrateLicenses(env, (await env.DB.prepare(sql).bind(...args, ...(before ? [before] : []), limit).all<License>()).results, now)
  }

  if (!filters.status) return page(filters.before, filters.limit)

  const sets = await loadStatusSets(env)
  const matches: License[] = []
  let before = filters.before
  while (matches.length < filters.limit) {
    const batch = await page(before, STATUS_SCAN_BATCH)
    for (const license of batch) {
      if (license.apps?.length ? !license.apps.some((e) => e.effective_status === filters.status && (!filters.appId || e.app_id === filters.appId)) : effectiveStatusKey(license, setForLicense(sets, license), now) !== filters.status) continue
      matches.push(license)
      if (matches.length === filters.limit) break
    }
    if (batch.length < STATUS_SCAN_BATCH) break
    before = batch[batch.length - 1].id
  }
  return matches
}

export async function hydrateLicenses(env: Env, licenses: License[], now=Date.now()): Promise<License[]> {
  if (!licenses.length) return licenses
  const [sets, rows] = await Promise.all([loadStatusSets(env),env.DB.prepare(`SELECT e.*, a.name AS app_name,a.slug AS app_slug,a.grace_days AS app_grace_days FROM license_apps e JOIN apps a ON a.id=e.app_id WHERE e.license_id IN (SELECT value FROM json_each(?)) ORDER BY e.position`).bind(JSON.stringify(licenses.map((l) => l.id))).all<import("./entitlements.server").Attachment>()])
  return licenses.map((l) => ({...l,apps:rows.results.filter((e) => e.license_id === l.id).map((e) => {
    const c=attachmentContext(l,e), set=sets.byApp[e.app_id] ?? []
    const actual=set.length ? set : setForLicense(sets,{id:l.id,app_id:e.app_id})
    const status=effectiveStatusKey(c,actual,now)
    return {tag:e.tag,app_id:e.app_id,app_name:e.app_name,app_slug:e.app_slug,status:e.status,effective_status:status,valid:inView(c,actual,"valid",now),expires_at:c.expires_at,grace_ends_at:graceEndsAt(c,actual,now),last_check_at:e.last_check_at,created_at:l.created_at,expiring:inView(c,actual,"expiring",now),silent:inView(c,actual,"silent",now)}
  })}))
}

function logChange(env: Env, id: string, at: number, status: string | null, detail: string) {
  return env.DB.prepare("INSERT INTO activity (license_id, at, event, status, detail) VALUES (?, ?, 'change', ?, ?)").bind(id, at, status, detail)
}

export async function updateLicense(env: Env, before: License, input: LicenseInput): Promise<void> {
  const now = Date.now()
  const set = await getStatusSetForLicense(env, { id: before.id, app_id: input.app_id })
  const changes: string[] = []
  if (before.status !== input.status) changes.push(`Status ${statusLabel(set, before.status)} -> ${statusLabel(set, input.status)}`)
  if (before.expires_at !== input.expires_at) changes.push(`Expiry ${formatDate(before.expires_at)} -> ${formatDate(input.expires_at)}`)
  if (before.app_id !== input.app_id) changes.push("App changed")
  const graceDays = input.grace_days === undefined ? before.grace_days : input.grace_days
  if (before.grace_days !== graceDays) changes.push(`Grace period ${describeGrace(before.grace_days)} -> ${describeGrace(graceDays)}`)
  if (before.max_sites !== input.max_sites) changes.push(`Site limit ${before.max_sites ?? "unlimited"} -> ${input.max_sites ?? "unlimited"}`)
  if (before.domains !== input.domains) changes.push("Allowed domains changed")
  if (before.message !== input.message) changes.push("Public message changed")
  if (before.name !== input.name || before.customer_name !== input.customer_name || before.customer_email !== input.customer_email || before.notes !== input.notes) changes.push("Details edited")
  const statements = [
    env.DB.prepare(
      `UPDATE licenses SET name = ?, customer_name = ?, customer_email = ?, app_id = ?, max_sites = ?, status = ?, expires_at = ?, domains = ?, message = ?, notes = ?, grace_days = ?, updated_at = ? WHERE id = ?`
    ).bind(input.name, input.customer_name, input.customer_email, input.app_id, input.max_sites, input.status, input.expires_at, input.domains, input.message, input.notes, graceDays, now, before.id),
  ]
  if (changes.length) statements.push(logChange(env, before.id, now, input.status, changes.join("; ")))
  // A licence that joins an app uses the app's statuses from then on, so statuses of its own are removed.
  if (input.app_id) statements.push(env.DB.prepare("DELETE FROM statuses WHERE license_id = ?").bind(before.id))
  await env.DB.batch(statements)
  if (changes.length === 0) return
  const after = (await getLicense(env, before.id))!
  await emitLicenseEvent(env, "license.updated", after, { changes })
  if (before.status !== input.status) await emitLicenseEvent(env, "license.status_changed", after, { previous_status: before.status })
}

function describeGrace(days: number | null): string {
  return days === null ? "app setting" : days === 0 ? "none" : `${days} days`
}

function formatDate(ts: number | null): string {
  return ts ? new Date(ts).toISOString().slice(0, 10) : "none"
}

export async function setStatus(env: Env, license: License, status: string): Promise<void> {
  if (license.status === status) return
  const now = Date.now()
  const set = await getStatusSetForLicense(env, license)
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, license.id),
    logChange(env, license.id, now, status, `Status ${statusLabel(set, license.status)} -> ${statusLabel(set, status)}`),
  ])
  await emitLicenseEvent(env, "license.status_changed", (await getLicense(env, license.id))!, { previous_status: license.status })
}

/** Webhook events of a renewal: always license.renewed, and license.status_changed when the stored status changed. */
async function emitRenewal(env: Env, before: License) {
  const after = (await getLicense(env, before.id))!
  await emitLicenseEvent(env, "license.renewed", after, { previous_expires_at: before.expires_at ? new Date(before.expires_at).toISOString() : null })
  if (after.status !== before.status) await emitLicenseEvent(env, "license.status_changed", after, { previous_status: before.status })
}

/**
 * The status a licence keeps when it is renewed. A licence stored with a status that other statuses expire into
 * (for example Expired) returns to the default status of its set; any other status is kept.
 */
function renewedStatus(set: StatusSet, current: string): string {
  return expirySources(set, current).length > 0 ? defaultStatusKey(set) : current
}

/**
 * Moves the expiry date forward by `days`: from the expiry date while it has not passed or the licence is in its grace
 * period (the days of grace used are not given again), otherwise from today.
 */
export async function extendLicense(env: Env, license: License, days: number): Promise<void> {
  const now = Date.now()
  const set = await getStatusSetForLicense(env, license)
  const from = license.expires_at && (license.expires_at > now || graceEndsAt(license, set, now) !== null) ? license.expires_at : now
  const to = from + days * 86_400_000
  const status = renewedStatus(set, license.status)
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET expires_at = ?, status = ?, updated_at = ? WHERE id = ?").bind(to, status, now, license.id),
    logChange(env, license.id, now, status, `Extended by ${days} days, now expires ${formatDate(to)}`),
  ])
  await emitRenewal(env, license)
}

/** Sets the expiry date. See `renewedStatus` for how the status is kept. */
export async function renewUntil(env: Env, license: License, until: number): Promise<void> {
  const now = Date.now()
  const status = renewedStatus(await getStatusSetForLicense(env, license), license.status)
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET expires_at = ?, status = ?, updated_at = ? WHERE id = ?").bind(until, status, now, license.id),
    logChange(env, license.id, now, status, `Renewed, now expires ${formatDate(until)}`),
  ])
  await emitRenewal(env, license)
}

export async function regenerateKey(env: Env, license: License): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET license_key = ?, updated_at = ? WHERE id = ?").bind(generateLicenseKey(), now, license.id),
    logChange(env, license.id, now, license.status, "Key regenerated. The previous key and check URL no longer work."),
  ])
  await emitLicenseEvent(env, "license.updated", (await getLicense(env, license.id))!, { changes: ["Key regenerated"] })
}

export async function deleteLicense(env: Env, id: string): Promise<void> {
  // The event carries the licence as it was, so it is written before the licence is gone.
  const license = await getLicense(env, id)
  if (license) await emitLicenseEvent(env, "license.deleted", license)
  await deleteLicenseFiles(env, id)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM license_apps WHERE license_id = ?").bind(id),
    env.DB.prepare("DELETE FROM files WHERE license_id = ?").bind(id),
    env.DB.prepare("DELETE FROM source_imports WHERE source_id IN (SELECT id FROM release_sources WHERE license_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM release_sources WHERE license_id = ?").bind(id),
    env.DB.prepare("UPDATE files SET track_id = NULL WHERE track_id IN (SELECT id FROM release_tracks WHERE license_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM release_tracks WHERE license_id = ?").bind(id),
    env.DB.prepare("DELETE FROM activations WHERE license_id = ?").bind(id),
    env.DB.prepare("DELETE FROM statuses WHERE license_id = ?").bind(id),
    env.DB.prepare("DELETE FROM activity WHERE license_id = ?").bind(id),
    env.DB.prepare("DELETE FROM licenses WHERE id = ?").bind(id),
  ])
}

// ---- site activations -----------------------------------------------------------

export async function listActivations(env: Env, licenseId: string): Promise<Activation[]> {
  return (await env.DB.prepare("SELECT domain, first_seen_at, last_seen_at, check_count, version, last_ip FROM activations WHERE license_id = ? ORDER BY first_seen_at").bind(licenseId).all<Activation>()).results
}

/**
 * Records that a site checked the licence. A known domain is updated. A new domain is registered, but only
 * while the licence is below its site limit; the limit is enforced in the INSERT itself. `version` is the version the
 * site reported; a check without one keeps the version recorded before.
 */
export async function recordActivation(env: Env, license: Pick<License, "id" | "max_sites">, domain: string, now: number, version: string | null = null, ip: string | null = null): Promise<void> {
  const updated = await env.DB.prepare("UPDATE activations SET last_seen_at = ?, check_count = check_count + 1, version = COALESCE(?, version), last_ip = COALESCE(?, last_ip) WHERE license_id = ? AND domain = ?")
    .bind(now, version, ip, license.id, domain)
    .run()
  if (updated.meta.changes > 0) return
  if (license.max_sites === null) {
    await env.DB.prepare("INSERT OR IGNORE INTO activations (license_id, domain, first_seen_at, last_seen_at, check_count, version, last_ip) VALUES (?, ?, ?, ?, 1, ?, ?)").bind(license.id, domain, now, now, version, ip).run()
    return
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO activations (license_id, domain, first_seen_at, last_seen_at, check_count, version, last_ip)
     SELECT ?, ?, ?, ?, 1, ?, ? WHERE (SELECT COUNT(*) FROM activations WHERE license_id = ?) < ?`
  ).bind(license.id, domain, now, now, version, ip, license.id, license.max_sites).run()
}

/** Frees a site slot. The site can register again on its next check, if the licence has room. */
export async function releaseActivation(env: Env, license: License, domain: string): Promise<boolean> {
  const now = Date.now()
  const res = await env.DB.prepare("DELETE FROM activations WHERE license_id = ? AND domain = ?").bind(license.id, domain).run()
  if (res.meta.changes === 0) return false
  await env.DB.prepare("DELETE FROM activation_versions WHERE domain = ? AND attachment_id IN (SELECT id FROM license_apps WHERE license_id = ?)").bind(domain, license.id).run()
  await logChange(env, license.id, now, license.status, `Site released: ${domain}`).run()
  return true
}

// ---- activity and statistics ----------------------------------------------------

/** A licence's activity, newest first. `after` continues a list after that entry (its `at` and `id`). */
export async function recentActivity(env: Env, id: string, limit = 50, after?: { at: number; id: number }): Promise<Activity[]> {
  const res = after
    ? await env.DB.prepare("SELECT id, at, event, status, domain, detail, ip, app_id, tag FROM activity WHERE license_id = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?")
        .bind(id, after.at, after.at, after.id, limit)
        .all<Activity>()
    : await env.DB.prepare("SELECT id, at, event, status, domain, detail, ip, app_id, tag FROM activity WHERE license_id = ? ORDER BY at DESC, id DESC LIMIT ?").bind(id, limit).all<Activity>()
  return res.results
}

export type OverviewStats = {
  total: number
  /** Licences for which a check currently returns valid: true (the status grants access and its expiry rule has not triggered). */
  valid: number
  invalid: number
  /** Valid licences whose expiry date falls within the next 14 days (the "expiring" view). */
  endingSoon: number
  /** Valid licences that no site has checked for 3 days (the "silent" view). */
  silent: number
  /** Number of licences per effective status key. */
  byStatus: Record<string, number>
}

export async function overviewStats(env: Env, now = Date.now()): Promise<OverviewStats> {
  const [sets, { results: rows }] = await Promise.all([
    loadStatusSets(env),
    env.DB.prepare("SELECT l.id, l.expiry_mode, l.status, l.expires_at, l.last_check_at, l.created_at, l.app_id, l.grace_days, a.grace_days AS app_grace_days FROM licenses l LEFT JOIN apps a ON a.id = l.app_id").all<
      Pick<License, "id" | "status" | "expires_at" | "last_check_at" | "created_at" | "app_id" | "grace_days" | "app_grace_days">
    >(),
  ])
  const hydrated = await hydrateLicenses(env, rows as License[], now)
  const stats: OverviewStats = { total: rows.length, valid: 0, invalid: 0, endingSoon: 0, silent: 0, byStatus: {} }
  for (const row of hydrated) {
    const set = setForLicense(sets, row)
    const effective = effectiveStatusKey(row, set, now)
    for (const status of row.apps?.length ? row.apps.map((e) => e.effective_status) : [effective]) stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1
    if (inView(row, set, "expiring", now)) stats.endingSoon++
    if (inView(row, set, "silent", now)) stats.silent++
    if (!inView(row, set, "valid", now)) {
      stats.invalid++
      continue
    }
    stats.valid++
  }
  return stats
}

export type LapsedLicense = License & { lapsed_at: number; lapsed_tags: string[] }

/**
 * The expiry that made a licence invalid in the last LAPSED_ATTENTION_DAYS, or null. Only a status that other statuses
 * expire into counts: a licence set to Suspended or Disabled is invalid by decision, and renewing it changes nothing.
 */
function lapsedFacts(license: License, sets: StatusSets, now: number): { lapsed_at: number; lapsed_tags: string[] } | null {
  const recent = (ts: number | null): ts is number => ts !== null && ts < now && ts > now - LAPSED_ATTENTION_DAYS * 86_400_000
  if (license.apps?.length) {
    const lapsed = license.apps.filter((a) => !a.valid && recent(a.expires_at) && expirySources(setForApp(sets, a.app_id), a.effective_status).length > 0)
    return lapsed.length ? { lapsed_at: Math.max(...lapsed.map((a) => a.expires_at!)), lapsed_tags: lapsed.map((a) => a.tag) } : null
  }
  const set = setForLicense(sets, license)
  if (!recent(license.expires_at) || inView(license, set, "valid", now)) return null
  return expirySources(set, effectiveStatusKey(license, set, now)).length > 0 ? { lapsed_at: license.expires_at, lapsed_tags: [] } : null
}

/** Licences that need a decision: expiring soon (soonest first), lapsed recently (latest first), and silent (longest first). */
export async function attentionLists(env: Env, limit = 8, now = Date.now()): Promise<{ expiring: License[]; silent: License[]; lapsed: LapsedLicense[] }> {
  const [sets, { results: rows }] = await Promise.all([
    loadStatusSets(env),
    env.DB.prepare(`${SELECT_LICENSES} WHERE l.expires_at IS NOT NULL OR l.expiry_mode = 'separate' OR l.last_check_at IS NULL OR l.last_check_at < ?`).bind(now - SILENT_AFTER_DAYS * 86_400_000).all<License>(),
  ])
  const hydrated = await hydrateLicenses(env, rows, now)
  const expiring = hydrated.filter((l) => inView(l, setForLicense(sets, l), "expiring", now)).sort((a, b) => (a.expires_at ?? 0) - (b.expires_at ?? 0))
  const silent = hydrated.filter((l) => inView(l, setForLicense(sets, l), "silent", now)).sort((a, b) => (a.last_check_at ?? a.created_at) - (b.last_check_at ?? b.created_at))
  const lapsed = hydrated.flatMap((l) => {
    const facts = lapsedFacts(l, sets, now)
    return facts ? [{ ...l, ...facts }] : []
  }).sort((a, b) => b.lapsed_at - a.lapsed_at)
  return { expiring: expiring.slice(0, limit), silent: silent.slice(0, limit), lapsed: lapsed.slice(0, limit) }
}

export type RecentEvent = { id: number; at: number; event: Activity["event"]; status: string | null; domain: string | null; detail: string; ip: string | null; license_id: string; name: string; app_id: string | null }

/** The latest activity across all licences, newest first, optionally of one kind. */
export async function recentEvents(env: Env, limit = 15, event?: Activity["event"]): Promise<RecentEvent[]> {
  const where = event ? "WHERE a.event = ?" : ""
  const res = await env.DB.prepare(
    `SELECT a.id, a.at, a.event, a.status, a.domain, a.detail, a.ip, l.id AS license_id, l.name, COALESCE(a.app_id,l.app_id) AS app_id FROM activity a JOIN licenses l ON l.id = a.license_id ${where} ORDER BY a.at DESC, a.id DESC LIMIT ?`
  )
    .bind(...(event ? [event, limit] : [limit]))
    .all<RecentEvent>()
  return res.results
}

export type SearchHit = { apps?: AttachmentFacts[]; id: string; name: string; customer_name: string; license_key: string; app_name: string | null; status: string; expires_at: number | null; app_id: string | null; matched_site: string | null }

/**
 * Finds licences by name, customer, email, key, allowed domains, external reference or app name, and also by the
 * domain of a site registered with them. Used by the dashboard's quick search.
 */
export async function searchLicenses(env: Env, query: string, limit = 8): Promise<SearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const byFields = await queryLicenses(env, { q, limit })
  const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`
  const bySite = (
    await env.DB.prepare(`SELECT license_id, domain FROM activations WHERE domain LIKE ? ESCAPE '\\' OR last_ip LIKE ? ESCAPE '\\' ORDER BY last_seen_at DESC LIMIT ?`).bind(like, like, limit).all<{ license_id: string; domain: string }>()
  ).results
  const hits: SearchHit[] = byFields.map((l) => ({ id: l.id, apps:l.apps, name: l.name, customer_name: l.customer_name, license_key: l.license_key, app_name: l.app_name ?? null, status: l.status, expires_at: l.expires_at, app_id: l.app_id, matched_site: null }))
  for (const site of bySite) {
    if (hits.length >= limit) break
    if (hits.some((h) => h.id === site.license_id)) continue
    const l = await getLicense(env, site.license_id)
    if (l) hits.push({ id: l.id, apps:l.apps, name: l.name, customer_name: l.customer_name, license_key: l.license_key, app_name: l.app_name ?? null, status: l.status, expires_at: l.expires_at, app_id: l.app_id, matched_site: site.domain })
  }
  return hits
}

export const CHECK_RETENTION_DAYS = 90

export async function pruneActivity(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM activity WHERE event = 'check' AND at < ?").bind(now - CHECK_RETENTION_DAYS * 86_400_000).run()
  // Downloads stay on record, without the caller's address after the same period.
  await env.DB.prepare("UPDATE activity SET ip = NULL WHERE event = 'download' AND ip IS NOT NULL AND at < ?").bind(now - CHECK_RETENTION_DAYS * 86_400_000).run()
  await env.DB.prepare("DELETE FROM login_attempts WHERE created_at < ?").bind(now - 86_400_000).run()
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run()
}

// ---- time-based webhook events ------------------------------------------------------

/**
 * Finds the events that come from the passing of time and writes them: a grace period that started, an expiry rule that
 * took effect, a valid licence that no site has checked for SILENT_AFTER_DAYS days. Run by the scheduled job. Each
 * licence remembers the value it was reported for (its expiry date, its last check), so each event fires once, and
 * again only after a renewal or a new check. Returns the number of events written.
 */
export async function scanLicenseEvents(env: Env, now = Date.now(), limit = 500): Promise<number> {
  const sets = await loadStatusSets(env)
  const marks: D1PreparedStatement[] = []
  let events = await scanBundleEvents(env,now,limit)

  const expired = (
    await env.DB.prepare(
      // Only licences with an event due: the grace event not sent yet, or the expiry event once the grace period is
      // over. A licence in its grace period, already reported, is not read again until then.
      `${SELECT_LICENSES} WHERE l.expiry_mode = 'legacy' AND l.expires_at IS NOT NULL AND l.expires_at <= ? AND (l.grace_notified_for IS NOT l.expires_at
         OR (l.expired_notified_for IS NOT l.expires_at AND l.expires_at + COALESCE(l.grace_days, a.grace_days, 0) * 86400000 <= ?)) ORDER BY l.expires_at LIMIT ?`,
    )
      .bind(now, now, limit)
      .all<License>()
  ).results
  for (const license of expired) {
    const set = setForLicense(sets, license)
    const def = findStatus(set, license.status)
    const mark = (column: "grace_notified_for" | "expired_notified_for" | "both") =>
      marks.push(
        column === "both"
          ? env.DB.prepare("UPDATE licenses SET grace_notified_for = expires_at, expired_notified_for = expires_at WHERE id = ?").bind(license.id)
          : env.DB.prepare(`UPDATE licenses SET ${column} = expires_at WHERE id = ?`).bind(license.id),
      )
    // A status without an expiry rule (such as Completed) ignores the date: nothing to report.
    if (!def?.on_expiry || !findStatus(set, def.on_expiry)) {
      mark("both")
      continue
    }
    if (graceEndsAt(license, set, now) !== null) {
      if (license.grace_notified_for !== license.expires_at) {
        events += await emitLicenseEvent(env, "license.grace_period_started", license, {}, now)
        mark("grace_notified_for")
      }
      continue
    }
    if (license.expired_notified_for !== license.expires_at) events += await emitLicenseEvent(env, "license.expired", license, { previous_status: license.status }, now)
    mark("both")
  }

  const quietSince = now - SILENT_AFTER_DAYS * 86_400_000
  const silent = (
    await env.DB.prepare(
      `${SELECT_LICENSES} WHERE l.expiry_mode = 'legacy' AND COALESCE(l.last_check_at, l.created_at) < ? AND l.silent_notified_for IS NOT COALESCE(l.last_check_at, l.created_at) ORDER BY COALESCE(l.last_check_at, l.created_at) LIMIT ?`,
    )
      .bind(quietSince, limit)
      .all<License>()
  ).results
  for (const license of silent) {
    // Only valid licences are reported; an invalid one is not expected to be checked.
    if (inView(license, setForLicense(sets, license), "silent", now)) events += await emitLicenseEvent(env, "license.silent", license, {}, now)
    marks.push(env.DB.prepare("UPDATE licenses SET silent_notified_for = COALESCE(last_check_at, created_at) WHERE id = ?").bind(license.id))
  }

  for (let i = 0; i < marks.length; i += 50) await env.DB.batch(marks.slice(i, i + 50))
  return events
}
