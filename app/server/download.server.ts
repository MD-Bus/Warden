import { contextsForLicense, type AppContext } from "./entitlements.server"
import { evaluateFileAccess, type FileAccess } from "../lib/files"
import { clientIp, reportUnknownKey } from "./guard.server"
import { buildCheckResponse, KEY_PATTERN, normalizeDomain, type CheckResponse } from "../lib/license"
import { isChannel, latestRelease, type Channel } from "../lib/releases"
import { describeStatusKeys, type StatusSet } from "../lib/statuses"
import { getFileForLicense, listFilesForLicense, releaseRule, type LicenseFile } from "./files.server"
import { getLicenseByKey, listActivations, type License } from "./licenses.server"
import { getStatusSetForLicense } from "./statuses.server"
import { getSigningKey, signatureHeaders, signRelease, type SigningKey } from "./signing.server"

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "X-Warden-Sha256, X-Warden-Release-Signature, X-Warden-Signature-Ed25519, X-Warden-Key-Id",
  "cache-control": "no-store",
}

/** A JSON response of the download endpoint, signed like a check response (X-Warden-Signature-Ed25519 over the body). */
async function reply(key: SigningKey, body: unknown, status: number): Promise<Response> {
  const text = JSON.stringify(body)
  return new Response(text, { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", ...(await signatureHeaders(key, text)) } })
}

/**
 * Content-Disposition for a download. Header values must be Latin-1, so the plain `filename` gets an ASCII version of
 * the name and `filename*` carries the exact name, percent-encoded as UTF-8 (RFC 6266 / RFC 5987).
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "download"
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * Whether a file can be downloaded by this licence now. Combines the file's release rule with the licence's
 * site rules: when the file requires a matching domain, the domain must also be allowed and within the site limit.
 */
function accessFor(license: License, file: LicenseFile, domain: string | null, check: CheckResponse, now: number, set: StatusSet): FileAccess {
  const rule = releaseRule(file, set)
  const access = evaluateFileAccess(license, rule, domain, now, false, set)
  if (access.allowed && rule.check_domain && (check.status === "site_limit_reached" || check.status === "domain_mismatch")) {
    return { allowed: false, status: check.status, message: check.message }
  }
  return access
}

/** A file as a licence sees it: its release rule, whether it can be downloaded now, and its download link. */
export type VisibleFile = {
  id: string
  name: string
  version: string
  channel: Channel
  changelog: string
  size: number
  sha256: string
  source: "licence" | "app"
  uploaded_at: number
  withdrawn_at: null
  statuses: string[]
  check_domain: boolean
  available: boolean
  download_url: string
}

/**
 * The files a licence can see (its own and its app's), without withdrawn releases, each with its availability for the
 * given domain. `check` is the licence's check result for that domain, which carries the site rules. `set` is the
 * licence's status set: it is also the set every one of these files refers to, because a licence in an app uses the
 * app's statuses and a standalone licence sees no app files.
 */
export async function visibleFiles(env: Env, license: License, domain: string | null, check: CheckResponse, now: number, set: StatusSet, origin: string): Promise<VisibleFile[]> {
  const files = (await listFilesForLicense(env, license)).filter((f) => f.withdrawn_at === null)
  return files.map((f) => {
    const rule = releaseRule(f, set)
    return {
      id: f.id,
      name: f.name,
      version: f.version,
      channel: f.channel,
      changelog: f.changelog,
      size: f.size,
      sha256: f.sha256,
      source: f.app_id ? "app" : "licence",
      uploaded_at: f.uploaded_at,
      withdrawn_at: null,
      statuses: rule.statuses,
      check_domain: rule.check_domain,
      available: accessFor(license, f, domain, check, now, set).allowed,
      download_url: `${origin}/download/${license.license_key}/${f.id}${license.tag ? `?tag=${encodeURIComponent(license.tag)}` : ""}`,
    }
  })
}

/** The fields of a release a site needs to offer an update, with the signature of its checksum. */
export async function releaseSummary(f: VisibleFile, key: SigningKey, domain: string | null = null) {
  return {
    id: f.id,
    name: f.name,
    version: f.version,
    channel: f.channel,
    changelog: f.changelog,
    size: f.size,
    sha256: f.sha256 || null,
    signature: await signRelease(key, f.sha256),
    released_at: new Date(f.uploaded_at).toISOString(),
    download_url: domain ? `${f.download_url}${f.download_url.includes("?") ? "&" : "?"}domain=${encodeURIComponent(domain)}` : f.download_url,
  }
}

/** A file in the public download list. Internal notes are never included. */
const publicEntry = async (f: VisibleFile, key: SigningKey) => ({
  id: f.id,
  name: f.name,
  version: f.version,
  channel: f.channel,
  changelog: f.changelog,
  size: f.size,
  sha256: f.sha256 || null,
  signature: await signRelease(key, f.sha256),
  source: f.source,
  uploaded_at: new Date(f.uploaded_at).toISOString(),
  statuses: f.statuses,
  check_domain: f.check_domain,
  available: f.available,
  download_url: f.download_url,
})

/**
 * Public file endpoint. The licence key in the path is the credential.
 *
 *   GET /download/<key>[?domain=example.com][&channel=beta]  lists the licence's files and its app's files, with
 *                                                          availability and the latest release in the channel
 *   GET /download/<key>/<file id>[?domain=example.com]       returns the file, a JSON error with HTTP 403, or 410
 *                                                          for a withdrawn release
 *
 * Every JSON response is signed with the install's Ed25519 key. A file carries X-Warden-Sha256 and
 * X-Warden-Release-Signature, the signature of that checksum.
 *
 * A file is released when the licence's effective status is one of the file's release statuses and, if the
 * file requires it, the requesting domain is allowed for the licence.
 */
export async function handleDownload(request: Request, env: Env, ctx: ExecutionContext, key: string, fileId: string | null): Promise<Response> {
  if (request.method === "OPTIONS") return legacyDownload(request,env,ctx,key,fileId)
  const license = KEY_PATTERN.test(key) ? await getLicenseByKey(env,key) : null
  if (!license?.expiry_mode || license.expiry_mode === "legacy") return legacyDownload(request,env,ctx,key,fileId)
  const url = new URL(request.url), tag = url.searchParams.get("tag"), signing = await getSigningKey(env)
  if (request.method !== "GET" && request.method !== "HEAD") return reply(signing,{error:"Method not allowed. Use GET."},405)
  const all = await contextsForLicense(env,license)
  const selected = tag === null ? all : all.filter((c) => c.tag === tag)
  if (!selected.length) return reply(signing,{valid:false,status:"attachment_not_found",tag,license_key:key,message:"No app has that tag on this licence."},404)
  if (fileId) {
    const matching=[]
    for (const c of selected) if (await getFileForLicense(env,c,fileId)) matching.push(c)
    if(matching.length>1 && tag === null) return reply(signing,{error:"Send tag to select which attachment authorizes this file."},422)
    if(matching.length) return legacyDownload(request,env,ctx,key,fileId,matching[0])
    return reply(signing,{error:"File not found for this licence and tag."},404)
  }
  if (selected.length === 1) return legacyDownload(request,env,ctx,key,fileId,selected[0])
  const apps = await Promise.all(selected.map(async (c) => {
    const response = await legacyDownload(request,env,ctx,key,null,c)
    return response.json()
  }))
  return reply(signing,{license_key:key,checked_at:new Date().toISOString(),apps},200)
}

async function legacyDownload(request: Request, env: Env, ctx: ExecutionContext, key: string, fileId: string | null, context?: AppContext): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET" } })
  const signing = await getSigningKey(env)
  if (request.method !== "GET" && request.method !== "HEAD") return reply(signing, { error: "Method not allowed. Use GET." }, 405)

  const url = new URL(request.url)
  const domainParam = url.searchParams.get("domain")
  const domain = domainParam ? normalizeDomain(domainParam) : null
  const now = Date.now()

  const license = context ?? (KEY_PATTERN.test(key) ? await getLicenseByKey(env, key) : null)
  if (!license) {
    reportUnknownKey(env, ctx, request)
    return reply(signing, { valid: false, status: "unknown", message: "Unknown licence." }, 404)
  }

  const activated = license.max_sites !== null ? (await listActivations(env, license.id)).map((a) => a.domain) : []
  const set = await getStatusSetForLicense(env, license)
  const check = buildCheckResponse(license, domain, now, activated, set)

  if (!fileId) {
    const channelParam = url.searchParams.get("channel") ?? "stable"
    const channel: Channel = isChannel(channelParam) ? channelParam : "stable"
    const entries = await visibleFiles(env, license, domain, check, now, set, url.origin)
    const latest = latestRelease(entries.filter((e) => e.available), channel)
    return reply(signing, { valid: check.valid, status: check.status, message: check.message, tag: context?.tag, app: context ? { id: context.app_id, slug: context.app_slug, name: context.app_name } : check.app, license_key: license.license_key, checked_at: check.checked_at, latest: latest ? await releaseSummary(latest, signing) : null, files: await Promise.all(entries.map((e) => publicEntry(e, signing))) }, 200)
  }

  const file = /^fil_[a-z0-9]+$/.test(fileId) ? await getFileForLicense(env, license, fileId) : null
  if (!file) return reply(signing, { error: "File not found for this licence." }, 404)
  if (file.withdrawn_at !== null) return reply(signing, { valid: false, status: "withdrawn", message: "This release has been withdrawn.", file: { id: file.id, name: file.name, version: file.version } }, 410)

  const access = accessFor(license, file, domain, check, now, set)
  if (!access.allowed) {
    ctx.waitUntil(logDownload(env, license, file, access.status, domain, clientIp(request), now, false, set).catch((e) => console.error("Failed to log download:", e)))
    return reply(signing, { valid: false, status: access.status, message: access.message, file: { id: file.id, name: file.name, statuses: releaseRule(file, set).statuses } }, 403)
  }
  if (!env.FILES) return reply(signing, { error: "File storage is not configured." }, 501)
  const object = await env.FILES.get(file.r2_key)
  if (!object) return reply(signing, { error: "The file is missing from storage." }, 404)

  const headers: Record<string, string> = {
    ...CORS,
    "content-type": file.content_type,
    "content-length": String(object.size),
    "content-disposition": contentDisposition(file.name),
    "x-content-type-options": "nosniff",
    // The file is served from the dashboard's origin. If a browser ever rendered it instead of downloading it, this
    // keeps it from running scripts or reaching anything.
    "content-security-policy": "default-src 'none'; sandbox",
  }
  if (file.sha256) {
    headers["x-warden-sha256"] = file.sha256
    headers["x-warden-release-signature"] = (await signRelease(signing, file.sha256))!
    headers["x-warden-key-id"] = signing.keyId
  }
  // A HEAD request only asks for the headers: it is not a download and is not counted.
  if (request.method === "HEAD") {
    object.body.cancel().catch(() => {})
    return new Response(null, { status: 200, headers })
  }
  ctx.waitUntil(logDownload(env, license, file, access.status, domain, clientIp(request), now, true, set).catch((e) => console.error("Failed to log download:", e)))
  return new Response(object.body, { status: 200, headers })
}

async function logDownload(env: Env, license: License, file: LicenseFile, status: string, domain: string | null, ip: string | null, now: number, granted: boolean, set: StatusSet) {
  const detail = granted ? `Downloaded: ${file.name}` : `Download denied: ${file.name} (available when ${describeStatusKeys(releaseRule(file, set).statuses, set)})`
  const statements = [env.DB.prepare("INSERT INTO activity (license_id, at, event, status, domain, detail, ip, app_id, tag) VALUES (?, ?, 'download', ?, ?, ?, ?, ?, ?)").bind(license.id, now, status, domain, detail, ip, license.app_id, license.tag ?? null)]
  if (granted) statements.push(env.DB.prepare("UPDATE files SET download_count = download_count + 1, last_download_at = ? WHERE id = ?").bind(now, file.id))
  await env.DB.batch(statements)
}
