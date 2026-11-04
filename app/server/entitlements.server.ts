import { MAX_LICENSE_APPS, isExpiryMode, validTag, type LicenseTemplate, type TemplateSlot } from "../lib/entitlements"
import { generateLicenseKey, parseDomains } from "../lib/license"
import type { Channel } from "../lib/releases"
import { defaultStatusKey, effectiveStatusKey, graceDays, graceEndsAt, grantsAccess } from "../lib/statuses"
import { applyLicenseBody } from "./api-input.server"
import { fail, iso, parseExpiry } from "./api-http.server"
import { findApp } from "./apps.server"
import { getLicense, getLicenseByRef, type License, type LicenseInput } from "./licenses.server"
import { getStatusSetForApp } from "./statuses.server"
import { emitLicenseEvent } from "./webhooks.server"
import { newId } from "./util.server"

export type Attachment = {
  id: string
  license_id: string
  app_id: string
  tag: string
  status: string
  expires_at: number | null
  grace_days: number | null
  message: string
  position: number
  app_name: string
  app_slug: string
  app_grace_days: number | null
  last_check_at: number | null
  check_count: number
  grace_notified_for: number | null
  expired_notified_for: number | null
  silent_notified_for: number | null
}
export type AppContext = License & { attachment_id?: string; tag?: string }
export function listAttachments(env: Env, licenseId: string): Promise<Attachment[]> {
  return env.DB.prepare(
    `SELECT e.*, a.name AS app_name, a.slug AS app_slug, a.grace_days AS app_grace_days
    FROM license_apps e JOIN apps a ON a.id = e.app_id WHERE e.license_id = ? ORDER BY e.position, e.id`,
  )
    .bind(licenseId)
    .all<Attachment>()
    .then((r) => r.results)
}
export type AttachmentVersion = { attachment_id: string; domain: string; version: string | null; channel: Channel; last_seen_at: number }

/** Versions reported by each site, per attachment, for every app of a licence (one query). */
export function listAttachmentVersions(env: Env, licenseId: string): Promise<AttachmentVersion[]> {
  return env.DB.prepare(
    `SELECT v.attachment_id, v.domain, v.version, v.channel, v.last_seen_at
    FROM activation_versions v JOIN license_apps e ON e.id = v.attachment_id WHERE e.license_id = ? ORDER BY v.domain`,
  )
    .bind(licenseId)
    .all<AttachmentVersion>()
    .then((r) => r.results)
}

export function attachmentContext(license: License, e: Attachment): AppContext {
  return {
    ...license,
    attachment_id: e.id,
    tag: e.tag,
    app_id: e.app_id,
    app_name: e.app_name,
    app_slug: e.app_slug,
    status: e.status,
    expires_at: license.expiry_mode === "shared" ? license.expires_at : e.expires_at,
    grace_days: license.grace_days ?? e.grace_days,
    app_grace_days: e.app_grace_days,
    message: license.message || e.message,
    last_check_at: e.last_check_at,
    check_count: e.check_count,
    grace_notified_for: e.grace_notified_for,
    expired_notified_for: e.expired_notified_for,
    silent_notified_for: e.silent_notified_for,
  }
}
export async function contextsForLicense(env: Env, license: License): Promise<AppContext[]> {
  const attachments = await listAttachments(env, license.id)
  return attachments.length ? attachments.map((e) => attachmentContext(license, e)) : [license]
}
export async function serializeBundle(env: Env, license: License, origin: string) {
  const attachments = await listAttachments(env, license.id)
  const apps = await Promise.all(
    attachments.map(async (e) => {
      const c = attachmentContext(license, e)
      const set = await getStatusSetForApp(env, e.app_id)
      const status = effectiveStatusKey(c, set)
      return {
        id: e.id,
        tag: e.tag,
        app: { id: e.app_id, slug: e.app_slug, name: e.app_name },
        status,
        stored_status: e.status,
        valid: grantsAccess(set, status),
        expires_at: iso(c.expires_at),
        grace_days: e.grace_days,
        effective_grace_days: graceDays(c),
        grace_ends_at: iso(graceEndsAt(c, set)),
        message: e.message,
        last_check_at: iso(e.last_check_at),
        check_count: e.check_count,
        check_url: `${origin}/check/${license.license_key}?tag=${encodeURIComponent(e.tag)}`,
      }
    }),
  )
  return {
    id: license.id,
    name: license.name,
    customer_name: license.customer_name,
    customer_email: license.customer_email,
    key: license.license_key,
    check_url: `${origin}/check/${license.license_key}`,
    expiry_mode: license.expiry_mode,
    expires_at: license.expiry_mode === "shared" ? iso(license.expires_at) : null,
    grace_days: license.grace_days,
    domains: parseDomains(license.domains),
    max_sites: license.max_sites,
    sites_used: license.sites_used ?? 0,
    message: license.message,
    notes: license.notes,
    external_ref: license.external_ref,
    created_at: iso(license.created_at),
    updated_at: iso(license.updated_at),
    last_check_at: iso(license.last_check_at),
    last_check_domain: license.last_check_domain,
    check_count: license.check_count,
    apps,
  }
}

type Failure = { response: Response }
const invalid = (message: string, code = "invalid_apps"): Failure => ({ response: fail(422, code, message) })

export async function saveBundle(env: Env, body: Record<string, unknown>, before: License | null): Promise<{ license: License; replayed?: boolean } | Failure> {
  if ("status" in body || "app" in body) return invalid("Use apps[].app and apps[].status for tagged-app licences.")
  if (!before && body.external_ref) {
    if (typeof body.external_ref !== "string" || body.external_ref.length > 120) return invalid("external_ref must be a string of 1 to 120 characters.", "invalid_external_ref")
    const existing = await getLicenseByRef(env, body.external_ref)
    if (existing) return { license: existing, replayed: true }
  }
  let template: LicenseTemplate | null = null
  if (!before && body.template !== undefined) {
    if (typeof body.template !== "string" || !(template = await getTemplate(env, body.template))) return invalid("Choose an existing licence template.", "invalid_template")
  }
  const mode = "expiry_mode" in body ? body.expiry_mode : (before?.expiry_mode ?? template?.expiry_mode ?? "shared")
  if (!isExpiryMode(mode)) return invalid("expiry_mode must be shared or separate.", "invalid_expiry_mode")
  if (mode === "separate" && ("duration_days" in body || (body.expires_at !== undefined && body.expires_at !== null)))
    return invalid("Set expires_at on each apps entry in separate expiry mode.", "invalid_expires_at")
  if (before?.expiry_mode === "separate" && mode === "shared" && !("expires_at" in body))
    return invalid("Send expires_at (or null for no expiry) when switching to shared expiry.", "invalid_expires_at")
  const previous = before ? await listAttachments(env, before.id) : []
  const rawApps =
    "apps" in body
      ? body.apps
      : before
        ? previous.map((e) => ({
            tag: e.tag,
            app: e.app_id,
            status: e.status,
            expires_at: iso(before.expiry_mode === "shared" ? before.expires_at : e.expires_at),
            grace_days: e.grace_days,
            message: e.message,
          }))
        : template?.slots.filter((s) => s.app).map((s) => ({ tag: s.tag, app: s.app }))
  if (!Array.isArray(rawApps) || rawApps.length < 1 || rawApps.length > MAX_LICENSE_APPS) return invalid(`apps must contain 1 to ${MAX_LICENSE_APPS} tagged app attachments.`)
  if (template)
    for (const slot of template.slots) {
      if (slot.required && !rawApps.some((r) => r && typeof r === "object" && r.tag === slot.tag)) return invalid(`The template requires the tag "${slot.tag}".`)
    }
  const tags = new Set<string>()
  const rows: { id: string; app_id: string; tag: string; status: string; expires_at: number | null; grace_days: number | null; message: string; changedApp: boolean }[] = []
  for (const raw of rawApps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !validTag(raw.tag))
      return invalid("Each tag must start with a lowercase letter and contain up to 48 lowercase letters, digits, underscores or hyphens.")
    if (tags.has(raw.tag)) return invalid(`The tag "${raw.tag}" is used twice.`)
    tags.add(raw.tag)
    const slot = template?.slots.find((s) => s.tag === raw.tag)
    const ref = raw.app === undefined ? slot?.app : raw.app
    const app = typeof ref === "string" ? await findApp(env, ref) : null
    if (!app) return invalid(`Choose an existing app for "${raw.tag}".`)
    const old = previous.find((e) => e.tag === raw.tag)
    const unchanged = old?.app_id === app.id
    const set = await getStatusSetForApp(env, app.id)
    const status = raw.status !== undefined ? raw.status : unchanged ? old.status : app.default_status || defaultStatusKey(set)
    if (typeof status !== "string" || !set.some((s) => s.key === status)) return invalid(`Choose a status of ${app.name} for "${raw.tag}".`, "invalid_status")
    const date =
      "expires_at" in raw
        ? parseExpiry(raw.expires_at)
        : unchanged
          ? before?.expiry_mode === "shared"
            ? before.expires_at
            : old.expires_at
          : app.default_duration_days
            ? Date.now() + app.default_duration_days * 86400000
            : null
    if (date === "invalid") return invalid(`Invalid expiry date for "${raw.tag}".`, "invalid_expires_at")
    const days = "grace_days" in raw ? raw.grace_days : unchanged ? old.grace_days : null
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365)) return invalid("grace_days must be null or a whole number from 0 to 365.", "invalid_grace_days")
    const message = raw.message !== undefined ? raw.message : unchanged ? old.message : app.default_message
    if (typeof message !== "string" || message.length > 300) return invalid("Each app message must be a string of at most 300 characters.")
    rows.push({ id: unchanged ? old.id : newId("ent"), app_id: app.id, tag: raw.tag, status, expires_at: date, grace_days: days, message, changedApp: Boolean(old && !unchanged) })
  }
  const base: LicenseInput = before
    ? { ...before }
    : { name: "", customer_name: "", customer_email: "", app_id: rows[0].app_id, status: rows[0].status, max_sites: null, expires_at: null, domains: "", message: "", notes: "", grace_days: null }
  // Status belongs to each attachment. Only shared licence fields are accepted here.
  const { apps: _apps, status: _status, ...shared } = body
  const parsed = applyLicenseBody(shared, base, await getStatusSetForApp(env, rows[0].app_id))
  if ("response" in parsed) return parsed
  if (!parsed.input.name || parsed.input.name.length > 120) return invalid("A licence name of 1 to 120 characters is required.", "invalid_name")
  const input = parsed.input
  const now = Date.now()
  const id = before?.id ?? newId("lic")
  const ref = before?.external_ref ?? (typeof body.external_ref === "string" ? body.external_ref.trim() : null)
  if (body.external_ref !== undefined && body.external_ref !== null && (!ref || ref.length > 120))
    return invalid("external_ref must be a non-empty string of at most 120 characters.", "invalid_external_ref")
  const statements: D1PreparedStatement[] = []
  if (before)
    statements.push(
      env.DB.prepare(
        `UPDATE licenses SET name=?, customer_name=?, customer_email=?, app_id=?, status=?, expiry_mode=?, expires_at=?, max_sites=?, domains=?, message=?, notes=?, grace_days=?, updated_at=? WHERE id=?`,
      ).bind(
        input.name,
        input.customer_name,
        input.customer_email,
        rows[0].app_id,
        rows[0].status,
        mode,
        mode === "shared" ? input.expires_at : null,
        input.max_sites,
        input.domains,
        input.message,
        input.notes,
        input.grace_days ?? null,
        now,
        id,
      ),
    )
  else
    statements.push(
      env.DB.prepare(
        `INSERT INTO licenses (id,name,customer_name,customer_email,license_key,app_id,status,expiry_mode,expires_at,max_sites,domains,message,notes,grace_days,external_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        input.name,
        input.customer_name,
        input.customer_email,
        generateLicenseKey(),
        rows[0].app_id,
        rows[0].status,
        mode,
        mode === "shared" ? input.expires_at : null,
        input.max_sites,
        input.domains,
        input.message,
        input.notes,
        input.grace_days ?? null,
        ref,
        now,
        now,
      ),
    )
  for (const old of previous) if (!rows.some((e) => e.id === old.id)) statements.push(env.DB.prepare("DELETE FROM license_apps WHERE id=?").bind(old.id))
  rows.forEach((e, position) =>
    statements.push(
      env.DB.prepare(
        `INSERT INTO license_apps (id,license_id,app_id,tag,status,expires_at,grace_days,message,position) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, expires_at=excluded.expires_at, grace_days=excluded.grace_days, message=excluded.message, position=excluded.position`,
      ).bind(e.id, id, e.app_id, e.tag, e.status, e.expires_at, e.grace_days, e.message, position),
    ),
  )
  statements.push(env.DB.prepare("INSERT INTO activity (license_id,at,event,detail) VALUES (?,?,'change',?)").bind(id, now, before ? "Licence and app access updated" : "Licence created"))
  try {
    await env.DB.batch(statements)
  } catch (error) {
    const replay = !before && ref ? await getLicenseByRef(env, ref) : null
    if (replay) return { license: replay, replayed: true }
    throw error
  }
  const license = (await getLicense(env, id))!
  await emitLicenseEvent(env, before ? "license.updated" : "license.created", license)
  if (before)
    for (const e of rows) {
      const old = previous.find((p) => p.id === e.id)
      if (old && old.status !== e.status) await emitLicenseEvent(env, "license.status_changed", license, { tag: e.tag, app_id: e.app_id, previous_status: old.status, status: e.status })
    }
  return { license }
}

export async function renewBundle(env: Env, license: License, body: Record<string, unknown>): Promise<Response | null> {
  const contexts = await contextsForLicense(env, license)
  const tag = body.tag
  if (license.expiry_mode === "separate" && typeof tag !== "string") return fail(422, "tag_required", "Send the tag of the app to renew in separate expiry mode.")
  if (license.expiry_mode === "shared" && tag !== undefined) return fail(422, "shared_expiry", "Shared expiry renews every attached app. Omit tag.")
  const selected = tag === undefined ? contexts : contexts.filter((c) => c.tag === tag)
  if (!selected.length) return fail(404, "attachment_not_found", "No app has that tag on this licence.")
  const now = Date.now()
  let until = "until" in body ? parseExpiry(body.until) : undefined
  if (until === "invalid" || until === null || (until !== undefined && until <= now)) return fail(422, "invalid_until", "until must be a date in the future.")
  const days = Number(body.days)
  if (until === undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) return fail(422, "invalid_days", "Send days (1 to 3650) or until.")
  const statements: D1PreparedStatement[] = []
  const statusChanges: { tag: string; app_id: string | null; previous_status: string; status: string }[] = []
  // Shared renewal uses the shared date. Any app still in grace preserves that original renewal base.
  const inGrace = (await Promise.all(selected.map(async (c) => graceEndsAt(c, await getStatusSetForApp(env, c.app_id), now)))).some(Boolean)
  if (until === undefined) {
    const date = license.expiry_mode === "shared" ? license.expires_at : selected[0].expires_at
    until = (date && (date > now || inGrace) ? date : now) + days * 86400000
  }
  if (license.expiry_mode === "shared") statements.push(env.DB.prepare("UPDATE licenses SET expires_at=?,updated_at=? WHERE id=?").bind(until, now, license.id))
  else statements.push(env.DB.prepare("UPDATE license_apps SET expires_at=? WHERE id=?").bind(until, selected[0].attachment_id!))
  for (const c of selected) {
    const set = await getStatusSetForApp(env, c.app_id)
    if (set.some((s) => s.on_expiry === c.status)) {
      const status = defaultStatusKey(set)
      statements.push(env.DB.prepare("UPDATE license_apps SET status=? WHERE id=?").bind(status, c.attachment_id!))
      statusChanges.push({ tag: c.tag!, app_id: c.app_id, previous_status: c.status, status })
    }
  }
  statements.push(env.DB.prepare("UPDATE licenses SET updated_at=? WHERE id=?").bind(now, license.id))
  statements.push(
    env.DB.prepare("INSERT INTO activity (license_id,at,event,tag,detail) VALUES (?,?,'change',?,?)").bind(
      license.id,
      now,
      typeof tag === "string" ? tag : null,
      `Renewed until ${new Date(until).toISOString()}`,
    ),
  )
  await env.DB.batch(statements)
  const after = (await getLicense(env, license.id))!
  await emitLicenseEvent(env, "license.renewed", after, { tag: tag ?? null, expires_at: iso(until) })
  for (const change of statusChanges) await emitLicenseEvent(env, "license.status_changed", after, change)
  return null
}

export async function listTemplates(env: Env): Promise<LicenseTemplate[]> {
  return (await env.DB.prepare("SELECT * FROM license_templates ORDER BY name COLLATE NOCASE").all<Omit<LicenseTemplate, "slots"> & { slots: string }>()).results.map((r) => ({
    ...r,
    slots: JSON.parse(r.slots),
  }))
}
export async function getTemplate(env: Env, id: string): Promise<LicenseTemplate | null> {
  return (await listTemplates(env)).find((t) => t.id === id) ?? null
}
export async function saveTemplate(env: Env, body: Record<string, unknown>, before: LicenseTemplate | null): Promise<{ template: LicenseTemplate } | Failure> {
  const name = "name" in body ? body.name : before?.name
  const description = "description" in body ? body.description : (before?.description ?? "")
  const mode = body.expiry_mode ?? before?.expiry_mode ?? "shared"
  const slots = "slots" in body ? body.slots : before?.slots
  if (typeof name !== "string" || !name.trim() || name.length > 80 || typeof description !== "string" || description.length > 500 || !isExpiryMode(mode))
    return invalid("Supply a name (1 to 80 characters), description (up to 500) and expiry_mode (shared or separate).", "invalid_template")
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_LICENSE_APPS) return invalid(`A template needs 1 to ${MAX_LICENSE_APPS} slots.`, "invalid_template")
  const tags = new Set<string>()
  const clean: TemplateSlot[] = []
  for (const slot of slots) {
    if (!slot || typeof slot !== "object" || !validTag(slot.tag) || tags.has(slot.tag) || (slot.required !== undefined && typeof slot.required !== "boolean"))
      return invalid("Every slot needs a unique valid tag and a boolean required flag.", "invalid_template")
    tags.add(slot.tag)
    const app = slot.app == null || slot.app === "" ? null : typeof slot.app === "string" ? await findApp(env, slot.app) : null
    if (slot.app && !app) return invalid(`The app for "${slot.tag}" does not exist.`, "invalid_template")
    clean.push({ tag: slot.tag, app: app?.id ?? null, required: slot.required ?? true })
  }
  const id = before?.id ?? newId("tpl"),
    now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO license_templates (id,name,description,expiry_mode,slots,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,expiry_mode=excluded.expiry_mode,slots=excluded.slots,updated_at=excluded.updated_at`,
    )
      .bind(id, name.trim(), description, mode, JSON.stringify(clean), now, now)
      .run()
  } catch (error) {
    if (/UNIQUE/.test(String(error))) return { response: fail(409, "template_name_taken", "Another template uses that name.") }
    throw error
  }
  return { template: (await getTemplate(env, id))! }
}

/** Time events are evaluated independently for each tagged app, including shared-date licences. */
export async function scanBundleEvents(env: Env, now: number, limit = 500): Promise<number> {
  const due = (
    await env.DB.prepare(
      `SELECT e.id,e.license_id FROM license_apps e JOIN licenses l ON l.id=e.license_id JOIN apps a ON a.id=e.app_id
    WHERE ((CASE WHEN l.expiry_mode='shared' THEN l.expires_at ELSE e.expires_at END) <= ? AND
      (e.grace_notified_for IS NOT (CASE WHEN l.expiry_mode='shared' THEN l.expires_at ELSE e.expires_at END) OR
       (e.expired_notified_for IS NOT (CASE WHEN l.expiry_mode='shared' THEN l.expires_at ELSE e.expires_at END) AND
        (CASE WHEN l.expiry_mode='shared' THEN l.expires_at ELSE e.expires_at END)+COALESCE(l.grace_days,e.grace_days,a.grace_days,0)*86400000 <= ?)))
      OR (COALESCE(e.last_check_at,l.created_at) < ? AND e.silent_notified_for IS NOT COALESCE(e.last_check_at,l.created_at))
    ORDER BY e.id LIMIT ?`,
    )
      .bind(now, now, now - 3 * 86400000, limit)
      .all<{ id: string; license_id: string }>()
  ).results
  const cache = new Map<string, License>()
  let events = 0
  for (const row of due) {
    let license = cache.get(row.license_id)
    if (!license) {
      license = (await getLicense(env, row.license_id))!
      cache.set(row.license_id, license)
    }
    const e = (await listAttachments(env, license.id)).find((e) => e.id === row.id)!
    const c = attachmentContext(license, e),
      set = await getStatusSetForApp(env, e.app_id),
      def = set.find((s) => s.key === e.status)
    const extra = { tag: e.tag, app_id: e.app_id, status: effectiveStatusKey(c, set, now) }
    const marks: D1PreparedStatement[] = []
    if (c.expires_at !== null && c.expires_at <= now) {
      if (!def?.on_expiry || !set.some((s) => s.key === def.on_expiry))
        marks.push(env.DB.prepare("UPDATE license_apps SET grace_notified_for=?,expired_notified_for=? WHERE id=?").bind(c.expires_at, c.expires_at, e.id))
      else if (graceEndsAt(c, set, now)) {
        if (e.grace_notified_for !== c.expires_at) {
          events += await emitLicenseEvent(env, "license.grace_period_started", license, extra, now)
          marks.push(env.DB.prepare("UPDATE license_apps SET grace_notified_for=? WHERE id=?").bind(c.expires_at, e.id))
        }
      } else if (e.expired_notified_for !== c.expires_at) {
        events += await emitLicenseEvent(env, "license.expired", license, { ...extra, previous_status: e.status }, now)
        marks.push(env.DB.prepare("UPDATE license_apps SET grace_notified_for=?,expired_notified_for=? WHERE id=?").bind(c.expires_at, c.expires_at, e.id))
      }
    }
    const last = e.last_check_at ?? license.created_at
    if (last < now - 3 * 86400000 && e.silent_notified_for !== last) {
      if (grantsAccess(set, effectiveStatusKey(c, set, now))) events += await emitLicenseEvent(env, "license.silent", license, extra, now)
      marks.push(env.DB.prepare("UPDATE license_apps SET silent_notified_for=? WHERE id=?").bind(last, e.id))
    }
    if (marks.length) await env.DB.batch(marks)
  }
  return events
}
