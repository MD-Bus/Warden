import type { AttachmentFacts } from "./entitlements"
import { effectiveStatusKey, findStatus, type ExpiryFacts, type StatusSet } from "./statuses"

/** Licences whose expiry date falls within this many days count as expiring soon. */
export const EXPIRING_WINDOW_DAYS = 14
/** Valid licences that no site has checked for this many days count as silent. */
export const SILENT_AFTER_DAYS = 3

const DAY = 86_400_000

/**
 * Saved filters of the licence list, also used by the overview counts so both always agree.
 *   valid     a check currently returns valid: true (the effective status grants access)
 *   invalid   a check currently returns valid: false (for example suspended, disabled or expired)
 *   expiring  valid, with an expiry date within EXPIRING_WINDOW_DAYS that its status reacts to
 *   silent    valid, but no check for SILENT_AFTER_DAYS (the site may be offline or no longer call Warden)
 */
export const LICENSE_VIEWS = ["valid", "invalid", "expiring", "silent"] as const
export type LicenseView = (typeof LICENSE_VIEWS)[number]

export const VIEW_LABELS: Record<LicenseView, string> = {
  valid: "Valid",
  invalid: "Invalid",
  expiring: `Expiring within ${EXPIRING_WINDOW_DAYS} days`,
  silent: `No check in ${SILENT_AFTER_DAYS}+ days`,
}

export function isLicenseView(value: unknown): value is LicenseView {
  return typeof value === "string" && (LICENSE_VIEWS as readonly string[]).includes(value)
}

type LicenseFacts = ExpiryFacts & { last_check_at: number | null; created_at: number; apps?: AttachmentFacts[] }

export function inView(license: LicenseFacts, set: StatusSet, view: LicenseView, now = Date.now()): boolean {
  if (license.apps?.length) {
    if (view === "valid") return license.apps.every((e) => e.valid)
    if (view === "invalid") return license.apps.some((e) => !e.valid)
    return license.apps.some((e) => view === "expiring" ? e.expiring : e.silent)
  }
  const valid = findStatus(set, effectiveStatusKey(license, set, now))?.grants_access ?? false
  if (view === "valid") return valid
  if (view === "invalid") return !valid
  if (!valid) return false
  if (view === "expiring") return license.expires_at !== null && license.expires_at <= now + EXPIRING_WINDOW_DAYS * DAY && Boolean(findStatus(set, license.status)?.on_expiry)
  return now - (license.last_check_at ?? license.created_at) > SILENT_AFTER_DAYS * DAY
}

/** Calendar days (UTC) from `now` to `ts`: 0 the same day, negative once that day has passed. Expiry dates are end-of-day UTC. */
export function daysUntil(ts: number, now = Date.now()): number {
  return Math.floor(ts / DAY) - Math.floor(now / DAY)
}

/** "today", "in 3 days", "2 days ago" for an expiry date. */
export function describeExpiry(ts: number | null, now = Date.now()): string {
  if (ts === null) return "Never"
  const days = daysUntil(ts, now)
  if (days === 0) return "today"
  if (days > 0) return days === 1 ? "tomorrow" : `in ${days} days`
  return days === -1 ? "yesterday" : `${-days} days ago`
}

/** The filters of the licence list. They live in the address so a filtered list can be bookmarked or linked. */
export type LicenseFilter = {
  q: string
  /** A status key, matched on the status reported to sites. Empty: any. */
  status: string
  /** An app id, "none" for standalone licences, or empty for any. */
  app: string
  view: LicenseView | ""
}

export function readLicenseFilter(params: URLSearchParams): LicenseFilter {
  const view = params.get("view") ?? ""
  return { q: params.get("q") ?? "", status: params.get("status") ?? "", app: params.get("app") ?? "", view: isLicenseView(view) ? view : "" }
}

type Filterable = LicenseFacts & {
  app_id: string | null
  name: string
  customer_name: string
  customer_email: string
  license_key: string
  domains: string
  app_name?: string | null
  external_ref?: string | null
}

/** Applies a filter. `setOf` returns the status set of a licence. */
export function filterLicenses<T extends Filterable>(licenses: T[], filter: LicenseFilter, setOf: (license: T) => StatusSet, now = Date.now()): T[] {
  const q = filter.q.trim().toLowerCase()
  return licenses.filter((l) => {
    if (filter.app === "none" ? l.app_id !== null : filter.app !== "" && l.app_id !== filter.app && !l.apps?.some((e) => e.app_id === filter.app)) return false
    if (filter.status && (l.apps?.length ? !l.apps.some((e) => e.effective_status === filter.status && (!filter.app || e.app_id === filter.app)) : effectiveStatusKey(l, setOf(l), now) !== filter.status)) return false
    if (filter.view && !inView(l, setOf(l), filter.view, now)) return false
    return !q || `${l.name} ${l.customer_name} ${l.customer_email} ${l.license_key} ${l.domains} ${l.app_name ?? ""} ${l.apps?.map((e) => `${e.tag} ${e.app_name}`).join(" ") ?? ""} ${l.external_ref ?? ""}`.toLowerCase().includes(q)
  })
}
