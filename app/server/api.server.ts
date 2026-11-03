import { getTemplate, listTemplates, saveTemplate, saveBundle, serializeBundle, renewBundle, listAttachments } from "./entitlements.server"
import { KEY_PATTERN } from "../lib/license"
import { DEFAULT_STATUSES, defaultStatusKey, findStatus, type StatusSet } from "../lib/statuses"
import { applyAppBody, applyLicenseBody } from "./api-input.server"
import { authenticate, type ApiKeyRow } from "./api-keys.server"
import { CORS, fail, iso, pageOf, parseExpiry, readJson, readLimit, reply, requirePermission, trimmed, unknownEndpoint } from "./api-http.server"
import { serializeActivation, serializeActivity, serializeApp, serializeBlock, serializeFile, serializeLicense, serializeStatus } from "./api-serializers.server"
import { readRange, TRAFFIC_RANGES } from "../lib/analytics"
import { trafficReport, type TrafficScope } from "./analytics.server"
import { apiWithinLimit } from "./guard.server"
import { createBlock, deleteBlock, listBlocks } from "./ip-blocks.server"
import { getProtection, saveProtection } from "./protection.server"
import { appDefaults, createApp, deleteApp, findApp, getAppSummary, listApps, updateApp, versionsInUse, type App, type AppInput } from "./apps.server"
import { deleteFile, getFile, listFiles, statusSetForOwner, storeFile, updateFile, type FileOwner } from "./files.server"
import {
  createLicense, deleteLicense, extendLicense, getLicense, getLicenseByKey, getLicenseByRef, listActivations, overviewStats, queryLicenses, recentActivity,
  regenerateKey, releaseActivation, renewUntil, setStatus, updateLicense, type License, type LicenseInput,
} from "./licenses.server"
import { getGitHubApp, listAppRepositories, listInstallations, publicGitHubApp } from "./github-app.server"
import { openApiSpec } from "./openapi.server"
import { getSigningKey, publicSigningKey, signRelease } from "./signing.server"
import {
  createWebhook, deleteWebhook, getWebhook, listDeliveries, listWebhooks, readWebhookInput, retryDelivery, sendTest, serializeDelivery, serializeWebhook, updateWebhook,
} from "./webhooks.server"
import { deleteSource, getImport, getSourceForTrack, listImports, listSources, publicSource, regenerateWebhookSecret, retryImport, saveSource, startImport, type ReleaseSource, type SourceImport } from "./sources.server"
import { createTrack, deleteTrack, findTrack, listAppTracks, listTracks, updateTrack, type ReleaseTrack } from "./tracks.server"
import { statusConflicts, trackForStatus } from "../lib/tracks"
import { effectiveStatusKey } from "../lib/statuses"
import {
  createStatus, customizeStatuses, deleteStatus, getStatusSetForApp, getStatusSetForLicense, hasCustomSet, loadStatusSets, readStatusInput, resetStatuses, setForLicense,
  setStatusOrder, statusSource, updateStatus, type StatusInput, type StatusScope,
} from "./statuses.server"

async function serializeManagedLicense(env: Env, l: License, origin: string, set: StatusSet) {
  return l.expiry_mode && l.expiry_mode !== "legacy" ? serializeBundle(env,l,origin) : serializeLicense(l,origin,set)
}

type Context = { env: Env; request: Request; url: URL; origin: string; key: ApiKeyRow; execution: ExecutionContext }

const need = (ctx: Context, scope: "read" | "manage" | "full") => requirePermission(ctx.key.scope, scope)

const LICENSE_DEFAULTS: Omit<LicenseInput, "status"> = {
  name: "", customer_name: "", customer_email: "", app_id: null, max_sites: null, expires_at: null, domains: "", message: "", notes: "",
}

const APP_DEFAULTS: AppInput = {
  name: "", slug: "", description: "", default_duration_days: null, default_status: "", default_max_sites: null, default_message: "", notes: "",
}

const toInput = (l: License): LicenseInput => ({
  name: l.name, customer_name: l.customer_name, customer_email: l.customer_email, app_id: l.app_id, max_sites: l.max_sites, status: l.status,
  expires_at: l.expires_at, domains: l.domains, message: l.message, notes: l.notes, grace_days: l.grace_days,
})

const toAppInput = (a: App): AppInput => ({
  name: a.name, slug: a.slug, description: a.description, default_duration_days: a.default_duration_days, default_status: a.default_status,
  default_max_sites: a.default_max_sites, default_message: a.default_message, notes: a.notes, grace_days: a.grace_days,
})

/** Finds a licence by its id (lic_...) or its licence key (WRD-...). */
async function findLicense(env: Env, idOrKey: string): Promise<License | null> {
  const upper = idOrKey.toUpperCase()
  if (KEY_PATTERN.test(upper)) return getLicenseByKey(env, upper)
  return /^lic_[a-z0-9]+$/.test(idOrKey) ? getLicense(env, idOrKey) : null
}

/** Resolves the `app` field of a request body: undefined (absent), null (no app) or an app. */
async function resolveAppField(env: Env, body: Record<string, unknown>): Promise<App | null | undefined | Response> {
  if (!("app" in body)) return undefined
  if (body.app === null) return null
  const ref = trimmed(body.app, 60)
  if (!ref) return fail(422, "invalid_app", "app must be an app id, an app slug or null.")
  return (await findApp(env, ref)) ?? fail(422, "invalid_app", `No app matches "${ref}".`)
}

// ---- licences ---------------------------------------------------------------------

async function listLicensesResponse(ctx: Context, appId?: string): Promise<Response> {
  const q = ctx.url.searchParams
  const limit = readLimit(q)
  // `before` is the earlier name of `cursor`, accepted until 1.0.0.
  const cursor = q.get("cursor") ?? q.get("before") ?? undefined
  if (cursor && !/^lic_[a-z0-9]+$/.test(cursor)) return fail(422, "invalid_cursor", "cursor must be the next value of a previous page of this list.")
  const sets = await loadStatusSets(ctx.env)
  const status = q.get("status") ?? undefined
  if (status && ![DEFAULT_STATUSES, ...Object.values(sets.byApp), ...Object.values(sets.byLicense)].some((set) => findStatus(set, status))) {
    return fail(422, "invalid_status", `status must be one of: ${DEFAULT_STATUSES.map((s) => s.key).join(", ")}, or a status that an app or licence has defined.`)
  }
  let filterApp = appId
  const appRef = q.get("app")
  if (!filterApp && appRef) {
    const app = await findApp(ctx.env, appRef)
    if (!app) return fail(422, "invalid_app", `No app matches "${appRef}".`)
    filterApp = app.id
  }
  const rows = await queryLicenses(ctx.env, { status, q: q.get("q") ?? undefined, externalRef: q.get("external_ref") ?? undefined, appId: filterApp, before: cursor, limit: limit + 1 })
  const page = rows.slice(0, limit)
  return reply({ data: await Promise.all(page.map((l) => serializeManagedLicense(ctx.env, l, ctx.origin, setForLicense(sets, l)))), next: rows.length > limit ? page[page.length - 1].id : null })
}

/** Creates a licence from a JSON body. Under an app, the app's defaults apply to every field the body leaves out. */
async function createLicenseResponse(ctx: Context, forcedApp?: App): Promise<Response> {
  const denied = need(ctx, "manage")
  if (denied) return denied
  const body = await readJson(ctx.request)
  if (body instanceof Response) return body

  if ("apps" in body || "template" in body || "expiry_mode" in body) {
    if (forcedApp) return fail(422,"invalid_apps","Create a multi-app licence with POST /licenses.")
    const saved=await saveBundle(ctx.env,body,null)
    return "response" in saved ? saved.response : reply(await serializeBundle(ctx.env,saved.license,ctx.origin),saved.replayed ? 200 : 201,saved.replayed ? {"idempotent-replayed":"true"} : {})
  }

  const ref = body.external_ref === undefined || body.external_ref === null ? null : trimmed(body.external_ref, 120)
  if (body.external_ref !== undefined && body.external_ref !== null && !ref) return fail(422, "invalid_external_ref", "external_ref must be a non-empty string of at most 120 characters.")
  if (ref) {
    const existing = await getLicenseByRef(ctx.env, ref)
    if (existing) return reply(await serializeManagedLicense(ctx.env,existing,ctx.origin,await getStatusSetForLicense(ctx.env, existing)), 200, { "idempotent-replayed": "true" })
  }
  if (!("name" in body)) return fail(422, "invalid_name", "name is required.")

  const fromBody = forcedApp === undefined ? await resolveAppField(ctx.env, body) : forcedApp
  if (fromBody instanceof Response) return fromBody
  const app = fromBody ?? null
  const set = await getStatusSetForApp(ctx.env, app?.id ?? null)
  const base: LicenseInput = { ...LICENSE_DEFAULTS, status: defaultStatusKey(set), ...(app ? appDefaults(app) : {}), app_id: app?.id ?? null }
  const parsed = applyLicenseBody(body, base, set)
  if ("response" in parsed) return parsed.response
  try {
    return reply(serializeLicense(await createLicense(ctx.env, { ...parsed.input, external_ref: ref }), ctx.origin, set), 201)
  } catch (error) {
    // Two requests with the same reference can race; the unique index lets one succeed and the other returns that licence.
    const existing = ref ? await getLicenseByRef(ctx.env, ref) : null
    if (existing) return reply(serializeLicense(existing, ctx.origin, set), 200, { "idempotent-replayed": "true" })
    throw error
  }
}

async function licenseRoute(ctx: Context, segments: string[]): Promise<Response> {
  const { env, request, origin } = ctx
  const method = request.method
  if (segments.length === 0) {
    if (method === "GET") return listLicensesResponse(ctx)
    if (method === "POST") return createLicenseResponse(ctx)
    return fail(405, "method_not_allowed", "Use GET or POST.")
  }

  const license = await findLicense(env, segments[0])
  if (!license) return fail(404, "license_not_found", "No licence matches that id or key.")
  const set = await getStatusSetForLicense(env, license)
  const [, sub, ...rest] = segments
  const extra = rest[0]

  if (!sub) {
    if (method === "GET") return reply(await serializeManagedLicense(env,license,origin,set))
    if (method === "PATCH") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      if (license.expiry_mode !== "legacy" || "apps" in body || "expiry_mode" in body) {
        const saved=await saveBundle(env,body,license)
        return "response" in saved ? saved.response : reply(await serializeBundle(env,saved.license,origin))
      }
      const app = await resolveAppField(env, body)
      if (app instanceof Response) return app
      const targetApp = app === undefined ? license.app_id : (app?.id ?? null)
      const targetSet = targetApp === license.app_id ? set : await getStatusSetForLicense(env, { id: license.id, app_id: targetApp })
      const base = { ...toInput(license), app_id: targetApp }
      // Moving to an app whose statuses lack the licence's current status: the licence takes that set's default unless a status is sent.
      if (!findStatus(targetSet, base.status) && !("status" in body)) base.status = defaultStatusKey(targetSet)
      const parsed = applyLicenseBody(body, base, targetSet)
      if ("response" in parsed) return parsed.response
      await updateLicense(env, license, parsed.input)
      return reply(serializeLicense((await getLicense(env, license.id))!, origin, targetSet))
    }
    if (method === "DELETE") {
      const denied = need(ctx, "full")
      if (denied) return denied
      await deleteLicense(env, license.id)
      return reply({ deleted: true, id: license.id })
    }
    return fail(405, "method_not_allowed", "Use GET, PATCH or DELETE.")
  }

  if (license.expiry_mode && license.expiry_mode !== "legacy" && ["files","tracks","statuses"].includes(sub)) {
    if (method !== "GET") return fail(409,"app_owned","Manage files, release tracks and status definitions on the app.")
    const tag=ctx.url.searchParams.get("tag")
    const attachments=await listAttachments(env,license.id)
    if (tag === null && attachments.length !== 1) return fail(422,"tag_required","Send tag to select the app.")
    const attachment=tag === null ? attachments[0] : attachments.find((e) => e.tag === tag)
    if (!attachment) return fail(404,"attachment_not_found","No app has that tag.")
    const app=(await findApp(env,attachment.app_id))!
    if (sub === "files") return filesRoute(ctx,{app},extra)
    if (sub === "tracks") return tracksRoute(ctx,{app},rest)
    return statusRoute(ctx,{app:app.id},await getStatusSetForApp(env,app.id),rest)
  }
  if (sub === "files") return filesRoute(ctx, { license }, extra)
  if (sub === "tracks") return tracksRoute(ctx, { license }, rest)
  if (sub === "statuses") {
    // A licence in an app uses the app's statuses: they can be read here but are changed on the app.
    if (license.app_id) {
      if (method !== "GET" || rest.length > 0) return fail(409, "license_in_app", "This licence belongs to an app and uses the app's statuses. Change them with /apps/{app}/statuses.")
      return reply({ custom: false, source: await statusSource(env, license), data: set.map(serializeStatus), next: null })
    }
    return statusRoute(ctx, { license: license.id }, set, rest)
  }

  if (sub === "activity") {
    if (method !== "GET") return fail(405, "method_not_allowed", "Use GET.")
    const limit = readLimit(ctx.url.searchParams)
    const cursor = ctx.url.searchParams.get("cursor")
    const position = cursor?.match(/^(\d+)\.(\d+)$/)
    if (cursor && !position) return fail(422, "invalid_cursor", "cursor must be the next value of a previous page of this list.")
    const rows = await recentActivity(env, license.id, limit + 1, position ? { at: Number(position[1]), id: Number(position[2]) } : undefined)
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return reply({ data: page.map(serializeActivity), next: rows.length > limit ? `${last.at}.${last.id}` : null })
  }

  if (sub === "activations") {
    if (method === "GET" && !extra) {
      const page = pageOf(await listActivations(env, license.id), (a) => a.domain, ctx.url.searchParams)
      if(page instanceof Response) return page
      const versions=(await env.DB.prepare("SELECT v.domain,v.version,e.tag FROM activation_versions v JOIN license_apps e ON e.id=v.attachment_id WHERE e.license_id=?").bind(license.id).all<{domain:string;version:string|null;tag:string}>()).results
      return reply({max_sites:license.max_sites,data:page.data.map((a) => ({...serializeActivation(a),...(license.expiry_mode !== "legacy" ? {versions:Object.fromEntries(versions.filter((v) => v.domain === a.domain).map((v) => [v.tag,v.version]))} : {})})),next:page.next})
    }
    if (method === "DELETE" && extra) {
      const denied = need(ctx, "manage")
      if (denied) return denied
      let domain: string
      try {
        domain = decodeURIComponent(extra).toLowerCase()
      } catch {
        return fail(400, "invalid_domain", "The domain in the path is not correctly encoded.")
      }
      return (await releaseActivation(env, license, domain)) ? reply({ released: true, domain }) : fail(404, "activation_not_found", "That domain is not registered for this licence.")
    }
    return fail(405, "method_not_allowed", "Use GET on /activations, and DELETE on /activations/{domain}.")
  }

  if ((sub === "status" || sub === "renew" || sub === "regenerate-key") && !extra) {
    if (method !== "POST") return fail(405, "method_not_allowed", "Use POST.")
    const denied = need(ctx, sub === "regenerate-key" ? "full" : "manage")
    if (denied) return denied
    const body = await readJson(request)
    if (body instanceof Response) return body

    if (license.expiry_mode && license.expiry_mode !== "legacy" && sub !== "regenerate-key") {
      if (sub === "renew") {
        const error=await renewBundle(env,license,body)
        return error ?? reply(await serializeBundle(env,(await getLicense(env,license.id))!,origin))
      }
      if (typeof body.status !== "string") return fail(422,"invalid_status","Send status as a string.")
      if (typeof body.tag !== "string") return fail(422,"tag_required","Send the tag of the app whose status should change.")
      const attachments=await listAttachments(env,license.id)
      if (!attachments.some((e) => e.tag === body.tag)) return fail(404,"attachment_not_found","No app has that tag.")
      const apps=attachments.map((e) => ({tag:e.tag,app:e.app_id,status:e.tag === body.tag ? body.status : e.status,expires_at:iso(e.expires_at),grace_days:e.grace_days,message:e.message}))
      const saved=await saveBundle(env,{apps},license)
      return "response" in saved ? saved.response : reply(await serializeBundle(env,saved.license,origin))
    }
    if (sub === "status") {
      if (typeof body.status !== "string" || !findStatus(set, body.status)) return fail(422, "invalid_status", `status must be one of: ${set.map((s) => s.key).join(", ")}.`)
      await setStatus(env, license, body.status)
    } else if (sub === "renew") {
      if ("until" in body) {
        const until = parseExpiry(body.until)
        if (until === "invalid" || until === null || until <= Date.now()) return fail(422, "invalid_until", "until must be a date (YYYY-MM-DD) or an ISO date-time in the future.")
        await renewUntil(env, license, until)
      } else {
        const days = Number(body.days)
        if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(422, "invalid_days", "Send days (1 to 3650) or until (a date).")
        await extendLicense(env, license, days)
      }
    } else {
      await regenerateKey(env, license)
    }
    return reply(await serializeManagedLicense(env,(await getLicense(env,license.id))!,origin,set))
  }
  return unknownEndpoint()
}

// ---- files ------------------------------------------------------------------------

/** Files of a licence or of an app. Both use the same endpoints and release rules. */
async function filesRoute(ctx: Context, owner: FileOwner, fileId: string | undefined): Promise<Response> {
  const { env, request, url, origin } = ctx
  const method = request.method
  const license = "license" in owner ? owner.license : null
  const set = await statusSetForOwner(env, owner)
  const signing = await getSigningKey(env)
  const shape = async (f: Parameters<typeof serializeFile>[0]) => serializeFile(f, license, origin, set, await signRelease(signing, f.sha256))

  if (method === "GET" && !fileId) {
    const page = pageOf(await listFiles(env, owner), (f) => f.id, url.searchParams)
    return page instanceof Response ? page : reply({ data: await Promise.all(page.data.map(shape)), next: page.next })
  }

  if (method === "PUT" && !fileId) {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const q = url.searchParams
    const stored = await storeFile(env, owner, {
      name: q.get("name") ?? "",
      statuses: q.get("statuses") ?? undefined,
      track: q.get("track"),
      checkDomain: q.get("check_domain") !== "false",
      version: q.get("version") ?? "",
      notes: q.get("notes") ?? "",
      channel: q.get("channel") ?? undefined,
      changelog: q.get("changelog") ?? "",
      contentType: request.headers.get("content-type"),
      size: Number(request.headers.get("content-length")),
      body: request.body,
    })
    return "error" in stored ? fail(stored.status, "upload_failed", stored.error) : reply(await shape(stored.file), 201)
  }

  if (fileId && (method === "PATCH" || method === "DELETE")) {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const file = await getFile(env, owner, fileId)
    if (!file) return fail(404, "file_not_found", "File not found.")
    if (method === "DELETE") {
      await deleteFile(env, owner, file)
      return reply({ deleted: true, id: file.id })
    }
    const body = await readJson(request)
    if (body instanceof Response) return body
    const updated = await updateFile(env, owner, file, {
      statuses: body.statuses,
      track: typeof body.track === "string" ? body.track : undefined,
      checkDomain: typeof body.check_domain === "boolean" ? body.check_domain : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      channel: typeof body.channel === "string" ? body.channel : undefined,
      changelog: typeof body.changelog === "string" ? body.changelog : undefined,
      withdrawn: typeof body.withdrawn === "boolean" ? body.withdrawn : undefined,
    })
    return "error" in updated ? fail(updated.status, "invalid_file", updated.error) : reply(await shape(updated.file))
  }
  return fail(405, "method_not_allowed", "Use GET or PUT on /files, and PATCH or DELETE on /files/{fileId}.")
}

// ---- release tracks and their repositories ---------------------------------------------

const serializeImport = (i: SourceImport) => ({
  id: i.id, tag: i.ref, version: i.version || null, commit: i.commit_sha || null, state: i.state, detail: i.detail, file_id: i.file_id,
  started_at: iso(i.started_at), finished_at: iso(i.finished_at),
})

async function serializeSource(ctx: Context, source: ReleaseSource) {
  const view = await publicSource(ctx.env, source, ctx.origin)
  const { webhook_secret, app_id: _a, license_id: _l, statuses: _s, status_keys: _k, check_domain: _c, created_at, updated_at, last_delivery_at, ...rest } = view
  return {
    ...rest,
    // The secret lets a caller start imports, so only keys that can change the source see it.
    webhook_secret: ctx.key.scope === "read" ? undefined : webhook_secret,
    created_at: iso(created_at), updated_at: iso(updated_at), last_delivery_at: iso(last_delivery_at),
  }
}

async function serializeTrack(ctx: Context, track: ReleaseTrack, sources: ReleaseSource[]) {
  const stats = await ctx.env.DB.prepare("SELECT COUNT(*) AS releases FROM files WHERE track_id = ?").bind(track.id).first<{ releases: number }>()
  const source = sources.find((s) => s.track_id === track.id)
  return {
    id: track.id, name: track.name, statuses: track.statuses.split(",").filter(Boolean), check_domain: track.check_domain === 1, position: track.position,
    releases: stats?.releases ?? 0, source: source ? await serializeSource(ctx, source) : null,
    created_at: iso(track.created_at), updated_at: iso(track.updated_at),
  }
}

/**
 * Release tracks of a licence or an app. Paths relative to .../tracks:
 *   GET /  POST /  GET /{track}  PATCH /{track}  DELETE /{track}?move_to=
 *   GET|PUT|DELETE /{track}/source  POST /{track}/source/regenerate-secret
 *   GET|POST /{track}/source/imports  POST /{track}/source/imports/{id}/retry
 */
async function tracksRoute(ctx: Context, owner: FileOwner, segments: string[]): Promise<Response> {
  const { env, request, origin, url } = ctx
  const method = request.method
  const [trackRef, sub, part, importId, action] = segments

  if (!trackRef) {
    if (method === "GET") {
      const [tracks, sources] = await Promise.all([listTracks(env, owner), listSources(env, owner)])
      const body: Record<string, unknown> = { data: await Promise.all(tracks.map((t) => serializeTrack(ctx, t, sources))), next: null, conflicts: statusConflicts(tracks).map((c) => ({ status: c.status, tracks: c.tracks.map((t) => t.id) })) }
      // A licence of an app also receives the app's tracks, for the statuses its own tracks do not cover.
      if ("license" in owner && owner.license.app_id) {
        const appTracks = await listAppTracks(env, owner.license.app_id)
        const set = await statusSetForOwner(env, owner)
        const status = effectiveStatusKey(owner.license, set, Date.now())
        const receives = trackForStatus(status, tracks, appTracks)
        body.app_tracks = appTracks.map((t) => ({ id: t.id, name: t.name, statuses: t.statuses.split(",").filter(Boolean) }))
        body.receives = receives ? { status, track: receives.track.id, name: receives.track.name, inherited: receives.inherited } : { status, track: null, name: null, inherited: false }
      } else if ("license" in owner) {
        const set = await statusSetForOwner(env, owner)
        const status = effectiveStatusKey(owner.license, set, Date.now())
        const receives = trackForStatus(status, tracks)
        body.receives = { status, track: receives?.track.id ?? null, name: receives?.track.name ?? null, inherited: false }
      }
      return reply(body)
    }
    if (method === "POST") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const created = await createTrack(env, owner, body)
      return "error" in created ? fail(created.status, created.status === 409 ? "status_in_another_track" : "invalid_track", created.error) : reply(await serializeTrack(ctx, created.track, []), 201)
    }
    return fail(405, "method_not_allowed", "Use GET or POST.")
  }

  const track = await findTrack(env, owner, decodeURIComponent(trackRef))
  if (!track) return fail(404, "track_not_found", "No track matches that id or name.")

  if (!sub) {
    if (method === "GET") return reply(await serializeTrack(ctx, track, await listSources(env, owner)))
    if (method === "PATCH") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const updated = await updateTrack(env, owner, track, body)
      return "error" in updated ? fail(updated.status, updated.status === 409 ? "status_in_another_track" : "invalid_track", updated.error) : reply(await serializeTrack(ctx, updated.track, await listSources(env, owner)))
    }
    if (method === "DELETE") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const moveTo = url.searchParams.get("move_to")
      const target = moveTo ? await findTrack(env, owner, moveTo) : null
      if (moveTo && !target) return fail(422, "invalid_move_to", "move_to must be another track of the same app or licence.")
      const deleted = await deleteTrack(env, owner, track, target?.id ?? null)
      return "error" in deleted ? fail(deleted.status, "track_not_empty", deleted.error) : reply({ deleted: true, id: track.id })
    }
    return fail(405, "method_not_allowed", "Use GET, PATCH or DELETE.")
  }

  if (sub !== "source") return unknownEndpoint()
  if (!part && method === "PUT") {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const body = await readJson(request)
    if (body instanceof Response) return body
    const saved = await saveSource(env, owner, track, body)
    return "error" in saved ? fail(saved.status, "invalid_source", saved.error) : reply(await serializeSource(ctx, saved.source), saved.created ? 201 : 200)
  }
  const source = await getSourceForTrack(env, owner, track.id)
  if (!source) return fail(404, "source_not_found", "No repository is connected to this track. Connect one with PUT.")
  if (!part) {
    if (method === "GET") return reply(await serializeSource(ctx, source))
    if (method === "DELETE") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      await deleteSource(env, source)
      return reply({ deleted: true, id: source.id })
    }
    return fail(405, "method_not_allowed", "Use GET, PUT or DELETE.")
  }
  if (part === "regenerate-secret" && !importId) {
    if (method !== "POST") return fail(405, "method_not_allowed", "Use POST.")
    const denied = need(ctx, "manage")
    if (denied) return denied
    await regenerateWebhookSecret(env, source)
    return reply(await serializeSource(ctx, (await getSourceForTrack(env, owner, track.id))!))
  }
  if (part === "imports") {
    if (!importId && method === "GET") {
      const page = pageOf(await listImports(env, source.id, 1000), (i) => i.id, url.searchParams)
      return page instanceof Response ? page : reply({ data: page.data.map(serializeImport), next: page.next })
    }
    if (!importId && method === "POST") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const tag = trimmed(body.tag, 200)
      if (!tag) return fail(422, "invalid_tag", `tag is required, for example ${source.tag_prefix}v1.4.0.`)
      if (!tag.startsWith(source.tag_prefix)) return fail(422, "invalid_tag", `Tags of this track start with "${source.tag_prefix}".`)
      return reply(serializeImport(await startImport(env, ctx.execution, source, tag)), 202)
    }
    if (importId && action === "retry" && method === "POST") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const row = await getImport(env, source.id, importId)
      if (!row) return fail(404, "import_not_found", "No import with this id.")
      const retried = await retryImport(env, ctx.execution, source, row)
      return "error" in retried ? fail(retried.status, "cannot_retry", retried.error) : reply(serializeImport(retried), 202)
    }
  }
  return unknownEndpoint()
}

// ---- statuses ---------------------------------------------------------------------

/**
 * The statuses of an app or of a standalone licence. An app or standalone licence uses its own statuses if it has
 * customised them, otherwise the built-in defaults; a licence in an app uses the app's. `current` is the set in effect
 * for the scope. Paths relative to .../statuses:
 *   GET /  POST /  DELETE /  POST /customize  POST /order  PATCH /{key}  DELETE /{key}?move_to=
 */
async function statusRoute(ctx: Context, scope: StatusScope, current: StatusSet, segments: string[]): Promise<Response> {
  const { env, request, url } = ctx
  const method = request.method
  const custom = await hasCustomSet(env, scope)
  const list = (set: StatusSet) => reply({ data: set.map(serializeStatus), next: null })

  if (segments.length === 0) {
    if (method === "GET") {
      const source = "license" in scope ? await statusSource(env, { id: scope.license, app_id: await appOfLicense(env, scope.license) }) : custom ? "app" : "default"
      return reply({ custom, source, data: current.map(serializeStatus), next: null })
    }
    if (method === "POST") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      if (!custom) return fail(409, "statuses_not_customized", "These statuses are not customised yet. Call POST .../statuses/customize first.")
      const body = await readJson(request)
      if (body instanceof Response) return body
      const parsed = readStatusInput(body, false)
      if ("error" in parsed) return fail(422, "invalid_status", parsed.error)
      const created = await createStatus(env, scope, parsed.input as StatusInput)
      return "error" in created ? fail(422, "invalid_status", created.error) : reply(serializeStatus(created.set.find((s) => s.key === (parsed.input.key || created.set[created.set.length - 1].key))!), 201)
    }
    if (method === "DELETE") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const mapping = body.mapping && typeof body.mapping === "object" ? (body.mapping as Record<string, string>) : {}
      const reset = await resetStatuses(env, scope, mapping)
      return "error" in reset ? fail(409, "statuses_in_use", reset.error) : reply({ custom: false, data: (await currentSet(env, scope)).map(serializeStatus), next: null })
    }
    return fail(405, "method_not_allowed", "Use GET, POST or DELETE.")
  }

  const [first] = segments
  if (first === "customize" && method === "POST") {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const result = await customizeStatuses(env, scope)
    return "error" in result ? fail(409, "already_customized", result.error) : reply({ custom: true, data: result.set.map(serializeStatus), next: null }, 201)
  }
  if (first === "order" && method === "POST") {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const body = await readJson(request)
    if (body instanceof Response) return body
    if (!Array.isArray(body.keys) || !body.keys.every((k) => typeof k === "string")) return fail(422, "invalid_keys", "keys must be an array of status keys.")
    const ordered = await setStatusOrder(env, scope, body.keys as string[])
    return "error" in ordered ? fail(422, "invalid_keys", ordered.error) : list(ordered.set)
  }

  if (!findStatus(current, first)) return fail(404, "status_not_found", "No status with that key.")
  if (!custom) return fail(409, "statuses_not_customized", "These statuses are not customised yet. Call POST .../statuses/customize first.")
  if (method === "PATCH") {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const body = await readJson(request)
    if (body instanceof Response) return body
    const parsed = readStatusInput(body, true)
    if ("error" in parsed) return fail(422, "invalid_status", parsed.error)
    const updated = await updateStatus(env, scope, first, parsed.input)
    return "error" in updated ? fail(422, "invalid_status", updated.error) : reply(serializeStatus(updated.set.find((s) => s.key === first)!))
  }
  if (method === "DELETE") {
    const denied = need(ctx, "full")
    if (denied) return denied
    const deleted = await deleteStatus(env, scope, first, url.searchParams.get("move_to"))
    return "error" in deleted ? fail(409, "status_in_use", deleted.error) : list(deleted.set)
  }
  return fail(405, "method_not_allowed", "Use PATCH or DELETE.")
}

async function appOfLicense(env: Env, licenseId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT app_id FROM licenses WHERE id = ?").bind(licenseId).first<{ app_id: string | null }>())?.app_id ?? null
}

/** The statuses in effect for a scope. */
async function currentSet(env: Env, scope: StatusScope): Promise<StatusSet> {
  return "app" in scope ? getStatusSetForApp(env, scope.app) : getStatusSetForLicense(env, { id: scope.license, app_id: await appOfLicense(env, scope.license) })
}

// ---- apps -------------------------------------------------------------------------

async function appRoute(ctx: Context, segments: string[]): Promise<Response> {
  const { env, request, origin } = ctx
  const method = request.method

  if (segments.length === 0) {
    if (method === "GET") {
      const page = pageOf(await listApps(env), (a) => a.id, ctx.url.searchParams)
      return page instanceof Response ? page : reply({ data: page.data.map(serializeApp), next: page.next })
    }
    if (method === "POST") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      if (!("name" in body)) return fail(422, "invalid_name", "name is required.")
      const parsed = applyAppBody(body, { ...APP_DEFAULTS, default_status: defaultStatusKey(DEFAULT_STATUSES) }, DEFAULT_STATUSES)
      if ("response" in parsed) return parsed.response
      const created = await createApp(env, parsed.input)
      return "error" in created ? fail(409, "slug_taken", created.error) : reply(serializeApp((await getAppSummary(env, created.app.id))!), 201)
    }
    return fail(405, "method_not_allowed", "Use GET or POST.")
  }

  const app = await findApp(env, segments[0])
  if (!app) return fail(404, "app_not_found", "No app matches that id or slug.")
  const [, sub, ...rest] = segments

  if (!sub) {
    if (method === "GET") return reply(serializeApp((await getAppSummary(env, app.id))!))
    if (method === "PATCH") {
      const denied = need(ctx, "manage")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const parsed = applyAppBody(body, toAppInput(app), await getStatusSetForApp(env, app.id))
      if ("response" in parsed) return parsed.response
      const updated = await updateApp(env, app, parsed.input)
      return "error" in updated ? fail(409, "slug_taken", updated.error) : reply(serializeApp((await getAppSummary(env, app.id))!))
    }
    if (method === "DELETE") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const result = await deleteApp(env, app)
      return "error" in result ? fail(409, "app_not_empty", result.error) : reply({ deleted: true, id: app.id })
    }
    return fail(405, "method_not_allowed", "Use GET, PATCH or DELETE.")
  }

  if (sub === "licenses" && rest.length === 0) {
    if (method === "GET") return listLicensesResponse(ctx, app.id)
    if (method === "POST") return createLicenseResponse(ctx, app)
    return fail(405, "method_not_allowed", "Use GET or POST.")
  }
  if (sub === "files") return filesRoute(ctx, { app }, rest[0])
  if (sub === "tracks") return tracksRoute(ctx, { app }, rest)
  if (sub === "versions" && rest.length === 0) {
    if (method !== "GET") return fail(405, "method_not_allowed", "Use GET.")
    return reply(await versionsInUse(env, app.id))
  }
  if (sub === "statuses") return statusRoute(ctx, { app: app.id }, await getStatusSetForApp(env, app.id), rest)
  return unknownEndpoint()
}

// ---- analytics ----------------------------------------------------------------------

async function analyticsRoute({ env, url }: Context): Promise<Response> {
  const daysParam = url.searchParams.get("days")
  if (daysParam !== null && !(TRAFFIC_RANGES as readonly number[]).includes(Number(daysParam))) return fail(422, "invalid_days", `days must be one of ${TRAFFIC_RANGES.join(", ")}.`)
  const appRef = url.searchParams.get("app")
  const licenseRef = url.searchParams.get("license")
  let scope: TrafficScope = {}
  if (licenseRef) {
    const license = await findLicense(env, licenseRef)
    if (!license) return fail(404, "license_not_found", `No licence matches "${licenseRef}".`)
    scope = { license: license.id }
  } else if (appRef === "none") scope = { standalone: true }
  else if (appRef) {
    const app = await findApp(env, appRef)
    if (!app) return fail(404, "app_not_found", `No app matches "${appRef}".`)
    scope = { app: app.id }
  }
  return reply(await trafficReport(env, scope, readRange(daysParam)))
}

// ---- IP blocklist -------------------------------------------------------------------

async function ipBlockRoute(ctx: Context, rest: string[]): Promise<Response> {
  const { env, request } = ctx
  if (rest.length === 0 && request.method === "GET") {
    const page = pageOf(await listBlocks(env), (b) => b.id, ctx.url.searchParams)
    return page instanceof Response ? page : reply({ data: page.data.map(serializeBlock), next: page.next })
  }
  if (rest.length === 0 && request.method === "POST") {
    const denied = need(ctx, "manage")
    if (denied) return denied
    const body = await readJson(request)
    if (body instanceof Response) return body
    const ip = typeof body.ip === "string" ? body.ip : ""
    const reason = typeof body.reason === "string" ? body.reason : ""
    let expiresAt: number | null = null
    if (body.expires_at !== undefined && body.expires_at !== null) {
      const parsed = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN
      if (Number.isNaN(parsed)) return fail(422, "invalid_expires_at", "expires_at must be an ISO 8601 date and time, or null for a permanent block.")
      expiresAt = parsed
    }
    const created = await createBlock(env, { value: ip, reason, expires_at: expiresAt })
    if ("error" in created) return fail(created.code === "exists" ? 409 : 422, created.code === "exists" ? "already_blocked" : "invalid_ip", created.error)
    return reply(serializeBlock(created.block), 201)
  }
  if (rest.length === 1 && request.method === "DELETE") {
    const denied = need(ctx, "manage")
    if (denied) return denied
    return (await deleteBlock(env, rest[0])) ? reply({ deleted: true, id: rest[0] }) : fail(404, "ip_block_not_found", "No block with this id.")
  }
  if (rest.length <= 1) return fail(405, "method_not_allowed", "Use GET or POST on /ip-blocks, and DELETE on /ip-blocks/{id}.")
  return unknownEndpoint()
}

// ---- outgoing webhooks --------------------------------------------------------------

/**
 * Paths relative to /webhooks:
 *   GET /  POST /  GET /{id}  PATCH /{id}  DELETE /{id}  POST /{id}/test
 *   GET /{id}/deliveries  POST /{id}/deliveries/{delivery}/retry
 * Endpoints receive licence data, so changing them needs the full permission.
 */
async function webhookRoute(ctx: Context, segments: string[]): Promise<Response> {
  const { env, request, url } = ctx
  const method = request.method
  const [id, sub, deliveryId, action] = segments

  if (!id) {
    if (method === "GET") return reply({ data: (await listWebhooks(env)).map(serializeWebhook), next: null })
    if (method === "POST") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const parsed = readWebhookInput(body)
      if ("error" in parsed) return fail(422, `invalid_${parsed.field}`, parsed.error)
      const created = await createWebhook(env, parsed.input)
      return "error" in created ? fail(409, "too_many_webhooks", created.error) : reply(serializeWebhook(created.webhook), 201)
    }
    return fail(405, "method_not_allowed", "Use GET or POST.")
  }

  const webhook = await getWebhook(env, id)
  if (!webhook) return fail(404, "webhook_not_found", "No webhook with this id.")

  if (!sub) {
    if (method === "GET") return reply(serializeWebhook(webhook))
    if (method === "PATCH") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const parsed = readWebhookInput(body, webhook)
      if ("error" in parsed) return fail(422, `invalid_${parsed.field}`, parsed.error)
      return reply(serializeWebhook(await updateWebhook(env, webhook, parsed.input)))
    }
    if (method === "DELETE") {
      const denied = need(ctx, "full")
      if (denied) return denied
      await deleteWebhook(env, webhook)
      return reply({ deleted: true, id: webhook.id })
    }
    return fail(405, "method_not_allowed", "Use GET, PATCH or DELETE.")
  }
  if (sub === "test" && !deliveryId) {
    if (method !== "POST") return fail(405, "method_not_allowed", "Use POST.")
    const denied = need(ctx, "full")
    if (denied) return denied
    return reply(serializeDelivery(await sendTest(env, webhook)))
  }
  if (sub === "deliveries") {
    if (!deliveryId && method === "GET") {
      const page = pageOf(await listDeliveries(env, webhook.id, 1000), (d) => d.id, url.searchParams)
      return page instanceof Response ? page : reply({ data: page.data.map(serializeDelivery), next: page.next })
    }
    if (deliveryId && action === "retry" && method === "POST") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const retried = await retryDelivery(env, webhook, deliveryId)
      return "error" in retried ? fail(retried.status, retried.status === 404 ? "delivery_not_found" : "cannot_retry", retried.error) : reply(serializeDelivery(retried.delivery), 202)
    }
  }
  return unknownEndpoint()
}

// ---- entry point ------------------------------------------------------------------

export async function handleApi(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  const path = url.pathname.replace(/^\/api\/v1/, "").replace(/\/+$/, "") || "/"
  if (path === "/openapi.json" && request.method === "GET") return reply(openApiSpec(url.origin))

  const key = await authenticate(request, env, execution)
  if (!key) return fail(401, "unauthorized", "Send a valid API key as Authorization: Bearer wk_...")
  if (!(await apiWithinLimit(request, env, key.prefix))) {
    const limited = fail(429, "rate_limited", "Too many requests with this API key. Try again in a minute.")
    limited.headers.set("retry-after", "60")
    return limited
  }
  const ctx: Context = { env, request, url, origin: url.origin, key, execution }

  const [resource, ...rest] = path.split("/").filter(Boolean)
  if (resource === "me" && request.method === "GET") return reply({ name: key.name, scope: key.scope, prefix: key.prefix })
  if (resource === "stats" && request.method === "GET") {
    const stats = await overviewStats(env)
    return reply({ total: stats.total, valid: stats.valid, invalid: stats.invalid, expiring_within_14_days: stats.endingSoon, not_checked_for_3_days: stats.silent, by_status: stats.byStatus })
  }
  if (resource === "signing-key" && rest.length === 0 && request.method === "GET") return reply(publicSigningKey(await getSigningKey(env)))
  if (resource === "analytics" && rest.length === 0 && request.method === "GET") return analyticsRoute(ctx)
  if (resource === "ip-blocks") return ipBlockRoute(ctx, rest)
  if (resource === "protection" && rest.length === 0) {
    if (request.method === "GET") return reply(await getProtection(env))
    if (request.method === "PATCH") {
      const denied = need(ctx, "full")
      if (denied) return denied
      const body = await readJson(request)
      if (body instanceof Response) return body
      const saved = await saveProtection(env, body)
      return "error" in saved ? fail(422, "invalid_settings", saved.error) : reply(saved.settings)
    }
    return fail(405, "method_not_allowed", "Use GET or PATCH.")
  }
  if (resource === "integrations" && rest[0] === "github" && request.method === "GET") {
    const app = await getGitHubApp(env)
    if (rest.length === 1) {
      if (!app) return reply({ connected: false, app: null, installations: [] })
      const installations = await listInstallations(app)
      if ("error" in installations) return fail(installations.status, "github_unavailable", installations.error)
      return reply({ connected: true, app: { ...publicGitHubApp(app), created_at: iso(app.created_at), last_delivery_at: iso(app.last_delivery_at ?? null) }, installations })
    }
    if (rest.length === 2 && rest[1] === "repositories") {
      if (!app) return fail(404, "github_not_connected", "No GitHub App is connected. Create one under Integrations in the dashboard.")
      const repositories = await listAppRepositories(app)
      return "error" in repositories ? fail(repositories.status, "github_unavailable", repositories.error) : reply({ data: repositories, next: null })
    }
  }
  if (resource === "webhooks") return webhookRoute(ctx, rest)
  if (resource === "license-templates") {
    const template=rest[0] ? await getTemplate(env,rest[0]) : null
    if (rest.length>1) return unknownEndpoint()
    if (rest[0] && !template) return fail(404,"template_not_found","No template has that id.")
    if (request.method === "GET") {
      if(template) return reply(template)
      const page=pageOf(await listTemplates(env),(t) => t.id,url.searchParams)
      return page instanceof Response ? page : reply(page)
    }
    const denied=need(ctx,request.method === "DELETE" ? "full" : "manage")
    if (denied) return denied
    if (request.method === "DELETE" && template) { await env.DB.prepare("DELETE FROM license_templates WHERE id=?").bind(template.id).run(); return reply({deleted:true,id:template.id}) }
    if ((request.method === "POST" && !rest[0]) || (request.method === "PATCH" && template)) {
      const body=await readJson(request)
      if (body instanceof Response) return body
      const saved=await saveTemplate(env,body,template)
      return "response" in saved ? saved.response : reply(saved.template,template ? 200 : 201)
    }
    return fail(405,"method_not_allowed","Use GET or POST on /license-templates, and GET, PATCH or DELETE on /license-templates/{id}.")
  }
  if (resource === "licenses") return licenseRoute(ctx, rest)
  if (resource === "apps") return appRoute(ctx, rest)
  if (resource === "statuses" && rest.length === 0 && request.method === "GET") return reply({ data: DEFAULT_STATUSES.map(serializeStatus), next: null })
  return unknownEndpoint()
}
