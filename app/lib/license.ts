import { effectiveStatusKey, findStatus, graceEndsAt, grantsAccess, type ExpiryFacts, type StatusSet } from "./statuses"

/** Uppercase letters and digits without the look-alikes 0, O, 1, I and L. */
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
const KEY_PREFIX = "WRD"

/** Generates a key in the format WRD-XXXXX-XXXXX-XXXXX-XXXXX (20 random characters, about 98 bits of entropy). */
export function generateLicenseKey(random: Crypto = globalThis.crypto): string {
  const limit = 256 - (256 % KEY_ALPHABET.length)
  let chars = ""
  while (chars.length < 20) {
    for (const byte of random.getRandomValues(new Uint8Array(40))) {
      if (byte >= limit) continue
      chars += KEY_ALPHABET[byte % KEY_ALPHABET.length]
      if (chars.length === 20) break
    }
  }
  return [KEY_PREFIX, ...chars.match(/.{5}/g)!].join("-")
}

export const KEY_PATTERN = /^WRD(-[A-Z0-9]{5}){4}$/

export function parseDomains(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(normalizeDomain)
    .filter((d): d is string => Boolean(d))
}

/** Reduces a URL or host to a bare lowercase domain without scheme, path, port or leading "www.". Returns null if invalid. */
export function normalizeDomain(raw: string): string | null {
  let host = raw.trim().toLowerCase()
  if (!host) return null
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^www\./, "")
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null
}

/** True if the licence has no domain restriction, or the domain is an allowed domain or a subdomain of one. */
export function domainAllowed(allowed: string[], domain: string | null): boolean {
  if (allowed.length === 0) return true
  if (!domain) return false
  const d = normalizeDomain(domain)
  if (!d) return false
  return allowed.some((a) => d === a || d.endsWith(`.${a}`))
}

export type CheckResponse = {
  valid: boolean
  tag?: string | null
  /** A licence status key, or one of "unknown", "domain_mismatch" and "site_limit_reached". */
  status: string
  message: string
  name?: string
  app?: { slug: string; name: string } | null
  expires_at?: string | null
  /** Set while the licence is in its grace period (expiry date passed, still valid): when the grace period ends. Null otherwise. */
  grace_ends_at?: string | null
  checked_at: string
  /** Set by the check endpoint: the licence key that was checked, so a response cannot be passed off as another licence's. */
  license_key?: string
  /** Set by the check endpoint: the site's domain as Warden read it, or null when none was sent. */
  domain?: string | null
  /** Set by the check endpoint: the nonce the site sent, echoed so the site can tell a fresh response from a replayed one. */
  nonce?: string | null
  /** Present when the site sent its version: the newest release this licence can download, and whether it is newer. */
  update?: UpdateInfo
}

/** A release offered to a site. `download_url` already carries the site's domain when it sent one. */
export type ReleaseInfo = {
  id: string
  name: string
  version: string
  channel: string
  changelog: string
  size: number
  sha256: string | null
  /** Ed25519 signature of `sha256` (the 64 hex characters), base64. Null when the release has no checksum. */
  signature: string | null
  released_at: string
  download_url: string
}

export type UpdateInfo = {
  /** The version the site reported. */
  current: string
  /** True when `latest` is newer than `current`. */
  available: boolean
  /** The newest release the licence can download in the site's channel, or null if there is none. */
  latest: ReleaseInfo | null
}

type LicenseForCheck = ExpiryFacts & {
  name: string
  domains: string
  message: string
  max_sites?: number | null
  app_slug?: string | null
  app_name?: string | null
}

const MESSAGE: Record<string, string> = {
  domain_mismatch: "This licence is not valid for this domain.",
  unknown: "Unknown licence.",
}

/**
 * Builds the JSON response of the check endpoint. Pure function.
 * `activatedDomains` are the domains the licence has already been used on; they matter only when the licence
 * has a site limit. `statuses` is the status set of the licence's app (or the default set).
 */
export function buildCheckResponse(license: LicenseForCheck | null, domain: string | null, now: number, activatedDomains: string[], statuses: StatusSet): CheckResponse {
  const checked_at = new Date(now).toISOString()
  if (!license) return { valid: false, status: "unknown", message: MESSAGE.unknown, checked_at }
  const status = effectiveStatusKey(license, statuses, now)
  const graceEnd = graceEndsAt(license, statuses, now)
  const base = {
    name: license.name,
    app: license.app_slug ? { slug: license.app_slug, name: license.app_name ?? license.app_slug } : null,
    expires_at: license.expires_at ? new Date(license.expires_at).toISOString() : null,
    grace_ends_at: graceEnd ? new Date(graceEnd).toISOString() : null,
    checked_at,
  }
  if (grantsAccess(statuses, status)) {
    if (!domainAllowed(parseDomains(license.domains), domain)) {
      return { ...base, valid: false, status: "domain_mismatch", message: MESSAGE.domain_mismatch }
    }
    const limit = license.max_sites ?? null
    if (limit !== null) {
      const normalized = domain ? normalizeDomain(domain) : null
      if (!normalized) {
        return { ...base, valid: false, status: "domain_mismatch", message: `This licence is limited to ${limit} site${limit === 1 ? "" : "s"}. Send the site's domain with the request (?domain=).` }
      }
      if (!activatedDomains.includes(normalized) && activatedDomains.length >= limit) {
        return { ...base, valid: false, status: "site_limit_reached", message: `This licence is already in use on the maximum number of sites (${limit}).` }
      }
    }
  }
  const fallback = graceEnd ? graceMessage(license.expires_at!, graceEnd) : (findStatus(statuses, status)?.check_message ?? "")
  return { ...base, valid: grantsAccess(statuses, status), status, message: license.message.trim() || fallback }
}

/** The message of a licence in its grace period, when it has no public message of its own. Dates in UTC. */
export function graceMessage(expiresAt: number, graceEnd: number): string {
  const day = (ts: number) => new Date(ts).toISOString().slice(0, 10)
  return `This licence expired on ${day(expiresAt)}. It remains valid until ${day(graceEnd)}; renew it to keep using it.`
}

/** API key permission levels, lowest first: read (GET only), manage (also create, edit, set status, renew), full (also delete licences and regenerate keys). */
export const SCOPES = ["read", "manage", "full"] as const
export type Scope = (typeof SCOPES)[number]
