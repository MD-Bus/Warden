import type { IpBlock } from "./ip-blocks.server"
import { evaluateFileAccess } from "../lib/files"
import { parseDomains } from "../lib/license"
import { effectiveStatusKey, graceDays, graceEndsAt, grantsAccess, type StatusDef, type StatusSet } from "../lib/statuses"
import type { AppSummary } from "./apps.server"
import { releaseRule, type LicenseFile } from "./files.server"
import type { Activation, Activity, License } from "./licenses.server"
import { iso } from "./api-http.server"

export function serializeLicense(l: License, origin: string, set: StatusSet) {
  const status = effectiveStatusKey(l, set)
  return {
    id: l.id,
    name: l.name,
    customer_name: l.customer_name,
    customer_email: l.customer_email,
    app: l.app_id ? { id: l.app_id, slug: l.app_slug ?? null, name: l.app_name ?? null } : null,
    key: l.license_key,
    check_url: `${origin}/check/${l.license_key}`,
    status,
    stored_status: l.status,
    valid: grantsAccess(set, status),
    expires_at: iso(l.expires_at),
    grace_days: l.grace_days,
    effective_grace_days: graceDays(l),
    grace_ends_at: iso(graceEndsAt(l, set)),
    domains: parseDomains(l.domains),
    max_sites: l.max_sites,
    sites_used: l.sites_used ?? 0,
    message: l.message,
    notes: l.notes,
    external_ref: l.external_ref,
    created_at: iso(l.created_at),
    updated_at: iso(l.updated_at),
    last_check_at: iso(l.last_check_at),
    last_check_domain: l.last_check_domain,
    check_count: l.check_count,
  }
}

export function serializeApp(a: AppSummary) {
  return {
    id: a.id,
    name: a.name,
    slug: a.slug,
    description: a.description,
    default_duration_days: a.default_duration_days,
    default_status: a.default_status,
    default_max_sites: a.default_max_sites,
    default_message: a.default_message,
    grace_days: a.grace_days,
    notes: a.notes,
    licenses: a.licenses,
    licenses_valid: a.valid,
    sites: a.sites,
    files: a.files,
    latest_version: a.latest_version,
    created_at: iso(a.created_at),
    updated_at: iso(a.updated_at),
  }
}

/**
 * A file. For a licence's own file, `available` and `download_url` are included. A file shared by an app has no
 * single download URL (the URL contains a licence key), so those fields are omitted. `signature` is the Ed25519
 * signature of the checksum (signRelease), computed by the caller.
 */
export function serializeFile(f: LicenseFile, license: License | null, origin: string, set: StatusSet, signature: string | null) {
  const rule = releaseRule(f, set)
  return {
    id: f.id,
    name: f.name,
    version: f.version,
    channel: f.channel,
    changelog: f.changelog,
    notes: f.notes,
    size: f.size,
    content_type: f.content_type,
    sha256: f.sha256 || null,
    signature,
    withdrawn: f.withdrawn_at !== null,
    withdrawn_at: iso(f.withdrawn_at),
    // A release's statuses and domain check are its track's; an attachment (no version) has no track.
    track: f.track_id,
    statuses: rule.statuses,
    check_domain: rule.check_domain,
    ...(license ? { available: f.withdrawn_at === null && evaluateFileAccess(license, rule, null, Date.now(), true, set).allowed, download_url: `${origin}/download/${license.license_key}/${f.id}` } : {}),
    uploaded_at: iso(f.uploaded_at),
    download_count: f.download_count,
    last_download_at: iso(f.last_download_at),
  }
}

export const serializeStatus = (s: StatusDef) => ({
  key: s.key,
  label: s.label,
  description: s.description,
  color: s.color,
  grants_access: s.grants_access,
  on_expiry: s.on_expiry,
  check_message: s.check_message,
  is_default: s.is_default,
})

export const serializeActivity = (a: Activity) => ({ app_id: a.app_id ?? null, tag: a.tag ?? null, at: iso(a.at), event: a.event, status: a.status, domain: a.domain, ip: a.ip, detail: a.detail })

export const serializeActivation = (a: Activation) => ({ domain: a.domain, version: a.version, first_seen_at: iso(a.first_seen_at), last_seen_at: iso(a.last_seen_at), check_count: a.check_count, last_ip: a.last_ip })

export const serializeBlock = (b: IpBlock) => ({
  id: b.id, ip: b.value, source: b.source, reason: b.reason, created_at: iso(b.created_at), expires_at: iso(b.expires_at), hits: b.hits, last_hit_at: iso(b.last_hit_at),
})
