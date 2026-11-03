import { LIMIT_KEYS, readProtection, RULE_INFO, RULE_KEYS, windowLabel, DEFAULT_PROTECTION, type ProtectionSettings, type RuleKey } from "../lib/protection"
import { grantsAccess, DEFAULT_STATUSES } from "../lib/statuses"
import { parseIp, parseRange, rangeContains } from "../lib/ip"
import { createBlock, findBlock } from "./ip-blocks.server"
import { loadStatusSets, setForApp } from "./statuses.server"

/**
 * Protection settings (rate limits, automatic blocking rules, never-block list) and the rules themselves.
 *
 * The rules run after the answer has been sent (in waitUntil), so they never slow a check down. Each rule counts the
 * address's recent events with one indexed query and, past its threshold, adds an automatic block.
 */

const KEY = "protection"
/** Settings are read on every check, so each Worker instance keeps them for a short time, like the blocklist. */
const CACHE_MS = 30_000
let cache: { at: number; settings: ProtectionSettings } | null = null

export function clearProtectionCache() {
  cache = null
}

export async function getProtection(env: Env, now = Date.now()): Promise<ProtectionSettings> {
  if (cache && now - cache.at <= CACHE_MS) return cache.settings
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>()
  let settings = DEFAULT_PROTECTION
  if (row) {
    try {
      // Stored settings are read through the same validation, so a value saved by an older version falls back to
      // the default for whatever is no longer valid.
      const parsed = readProtection(knownParts(JSON.parse(row.value)))
      if ("settings" in parsed) settings = parsed.settings
    } catch {
      settings = DEFAULT_PROTECTION
    }
  }
  cache = { at: now, settings }
  return settings
}

/** Stored settings keep only the limits and rules this version knows, so a renamed or removed key is ignored. */
function knownParts(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null) return stored
  const value = stored as Record<string, unknown>
  const pick = (part: unknown, keys: readonly string[]) =>
    typeof part === "object" && part !== null ? Object.fromEntries(Object.entries(part).filter(([k]) => keys.includes(k))) : part
  return { ...value, limits: pick(value.limits, LIMIT_KEYS), rules: pick(value.rules, RULE_KEYS) }
}

export async function saveProtection(env: Env, input: unknown): Promise<{ settings: ProtectionSettings } | { error: string }> {
  clearProtectionCache()
  const parsed = readProtection(input, await getProtection(env))
  if ("error" in parsed) return parsed
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(KEY, JSON.stringify(parsed.settings), Date.now())
    .run()
  cache = { at: Date.now(), settings: parsed.settings }
  return parsed
}

/** True if the address is on the never-block list. */
export function isTrusted(settings: ProtectionSettings, ip: string | null): boolean {
  const parsed = ip ? parseIp(ip) : null
  if (!parsed) return false
  return settings.never_block.some((entry) => {
    const range = parseRange(entry)
    return "range" in range && rangeContains(range.range, parsed)
  })
}

// ---- events and rules ------------------------------------------------------------------

export type IpEventKind = "invalid_key" | "rate_limited"

/** What just happened, for the rules to look at. */
export type RuleTrigger = { kind: "invalid_key" } | { kind: "rate_limited" } | { kind: "check"; invalid: boolean }

const RULE_FOR: Record<IpEventKind, RuleKey> = { invalid_key: "invalid_keys", rate_limited: "rate_limit_violations" }

async function countEvents(env: Env, ip: string, kind: IpEventKind, since: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM ip_events WHERE ip = ? AND kind = ? AND at >= ?").bind(ip, kind, since).first<{ n: number }>()
  return row?.n ?? 0
}

async function countRefusedChecks(env: Env, ip: string, since: number): Promise<number> {
  const rows = (
    await env.DB.prepare(
      `SELECT a.status AS status, COALESCE(a.app_id,l.app_id) AS app_id, l.id AS license_id, COUNT(*) AS n FROM activity a JOIN licenses l ON l.id = a.license_id
       WHERE a.ip = ? AND a.at >= ? AND a.event = 'check' GROUP BY a.status, COALESCE(a.app_id,l.app_id), l.id`
    )
      .bind(ip, since)
      .all<{ status: string; app_id: string | null; license_id: string; n: number }>()
  ).results
  if (rows.length === 0) return 0
  const sets = await loadStatusSets(env)
  return rows.reduce((n, r) => {
    const set = r.app_id ? setForApp(sets, r.app_id) : (sets.byLicense[r.license_id] ?? DEFAULT_STATUSES)
    return grantsAccess(set, r.status) ? n : n + r.n
  }, 0)
}

async function countLicenses(env: Env, ip: string, since: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(DISTINCT license_id) AS n FROM activity WHERE ip = ? AND at >= ? AND event = 'check'").bind(ip, since).first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Records what an address did (for the event-based rules) and applies the rules that apply to it. Returns the rule
 * that blocked the address, if one did. Trusted and already blocked addresses are left alone.
 */
export async function applyRules(env: Env, ip: string | null, trigger: RuleTrigger, now = Date.now()): Promise<RuleKey | null> {
  if (!ip) return null
  const settings = await getProtection(env, now)
  if (isTrusted(settings, ip)) return null

  // An event is only recorded while its rule is on: nothing is written for a rule nobody uses.
  if (trigger.kind !== "check") {
    if (!settings.rules[RULE_FOR[trigger.kind]].enabled) return null
    await env.DB.prepare("INSERT INTO ip_events (ip, kind, at) VALUES (?, ?, ?)").bind(ip, trigger.kind, now).run()
  }

  const candidates: RuleKey[] =
    trigger.kind === "check" ? [...(trigger.invalid ? (["invalid_checks"] as const) : []), "licenses_per_ip"] : [RULE_FOR[trigger.kind]]
  for (const key of candidates) {
    const rule = settings.rules[key]
    if (!rule.enabled) continue
    const since = now - rule.minutes * 60_000
    const count =
      key === "invalid_checks" ? await countRefusedChecks(env, ip, since) : key === "licenses_per_ip" ? await countLicenses(env, ip, since) : await countEvents(env, ip, trigger.kind as IpEventKind, since)
    if (count < rule.count) continue
    if (await findBlock(env, ip, now)) return null
    const reason = `Rule "${RULE_INFO[key].label}": ${count} ${RULE_INFO[key].unit} in ${windowLabel(rule.minutes)}.`
    await createBlock(env, { value: ip, reason, expires_at: rule.block_hours === 0 ? null : now + rule.block_hours * 3_600_000, source: "auto" }, now)
    return key
  }
  return null
}

/** Events are only read over the last day. */
export async function pruneIpEvents(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM ip_events WHERE at < ?").bind(now - 86_400_000).run()
}
