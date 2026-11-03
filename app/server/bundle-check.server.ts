import { buildCheckResponse, normalizeDomain } from "../lib/license"
import { compareVersions, isChannel, latestRelease, readReportedVersion } from "../lib/releases"
import { contextsForLicense, type AppContext } from "./entitlements.server"
import { getStatusSetForApp } from "./statuses.server"
import { getSigningKey, signatureHeaders } from "./signing.server"
import { readTextUpTo } from "./api-http.server"
import { listActivations, recordActivation, type License } from "./licenses.server"
import { releaseSummary, visibleFiles } from "./download.server"
import { clientIp } from "./guard.server"
import { applyRules } from "./protection.server"
import { hmacHex } from "./util.server"

export async function handleBundleCheck(request: Request, env: Env, ctx: ExecutionContext, license: License): Promise<Response> {
  const url = new URL(request.url),
    q = url.searchParams
  let data: Record<string, unknown> = {}
  if (request.method === "POST") {
    const text = await readTextUpTo(request, 4096)
    try {
      const parsed = JSON.parse(text ?? "{}")
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed
    } catch {}
  }
  const pick = (field: string) => q.get(field) ?? data[field]
  const rawDomain = pick("domain"),
    rawNonce = pick("nonce"),
    tag = pick("tag")
  const domain = typeof rawDomain === "string" ? normalizeDomain(rawDomain) : null
  const nonce = typeof rawNonce === "string" && /^[A-Za-z0-9._~-]{8,64}$/.test(rawNonce) ? rawNonce : null
  const now = Date.now(),
    signing = await getSigningKey(env)
  const send = async (value: object, status = 200) => {
    const body = JSON.stringify({ license_key: license.license_key, domain, nonce, checked_at: new Date(now).toISOString(), ...value })
    return new Response(body, {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "X-Warden-Signature-Ed25519, X-Warden-Key-Id, X-Warden-Signature",
        ...(await signatureHeaders(signing, body)),
        "x-warden-signature": await hmacHex(license.license_key, body),
      },
    })
  }
  const all = await contextsForLicense(env, license)
  const selected = tag === undefined || tag === null ? all : all.filter((c) => c.tag === tag)
  if (!selected.length) return send({ valid: false, status: "attachment_not_found", message: "No app has that tag on this licence.", tag }, 404)
  if (selected.length > 1 && pick("version") !== undefined && pick("version") !== null)
    return send({ error: { code: "tag_required", message: "Send tag with version, or send a versions object keyed by tag." } }, 422)
  const ip = clientIp(request)
  const results: ({ valid: boolean } & Record<string, unknown>)[] = []
  const records: Promise<void>[] = []
  for (const c of selected) {
    const set = await getStatusSetForApp(env, c.app_id)
    let activated = license.max_sites !== null ? (await listActivations(env, license.id)).map((a) => a.domain) : []
    let check = buildCheckResponse(c, domain, now, activated, set)
    // Reserve the shared domain slot before returning a valid answer, including concurrent checks.
    if (check.valid && domain) {
      await recordActivation(env, license, domain, now, null, ip)
      if (license.max_sites !== null) {
        activated = (await listActivations(env, license.id)).map((a) => a.domain)
        check = buildCheckResponse(c, domain, now, activated, set)
      }
    }
    const versions = data.versions && typeof data.versions === "object" && !Array.isArray(data.versions) ? (data.versions as Record<string, unknown>) : {}
    const version = readReportedVersion(selected.length === 1 ? (pick("version") ?? versions[c.tag!]) : versions[c.tag!])
    const channel = isChannel(pick("channel")) ? (pick("channel") as "stable" | "beta") : "stable"
    if (version) {
      const files = await visibleFiles(env, c, domain, check, now, set, url.origin)
      const latest = latestRelease(
        files.filter((f) => f.available),
        channel,
      )
      check.update = { current: version, available: Boolean(latest && compareVersions(latest.version, version) > 0), latest: latest ? await releaseSummary(latest, signing, domain) : null }
    }
    const result = { ...check, tag: c.tag, app: { id: c.app_id, slug: c.app_slug, name: c.app_name } }
    results.push(result)
    records.push(record(env, c, result.status, check.valid, domain, version, ip, now))
  }
  ctx.waitUntil(env.DB.prepare("UPDATE licenses SET last_check_at=?,last_check_domain=?,check_count=check_count+1 WHERE id=?").bind(now, domain, license.id).run())
  ctx.waitUntil(Promise.all(records).then(() => applyRules(env, ip, { kind: "check", invalid: results.some((r) => !r.valid) }, now)))
  return send(results.length === 1 ? results[0] : { name: license.name, apps: results })
}
async function record(env: Env, c: AppContext, status: string, valid: boolean, domain: string | null, version: string | null, ip: string | null, now: number) {
  const statements = [
    env.DB.prepare("UPDATE license_apps SET last_check_at=?,check_count=check_count+1 WHERE id=?").bind(now, c.attachment_id!),
    env.DB.prepare("INSERT INTO activity (license_id,at,event,status,domain,detail,ip,app_id,tag) VALUES (?,?,'check',?,?,?,?,?,?)").bind(
      c.id,
      now,
      status,
      domain,
      version ? `Version ${version}` : "",
      ip,
      c.app_id,
      c.tag!,
    ),
  ]
  if (valid && domain)
    statements.push(
      env.DB.prepare(
        `INSERT INTO activation_versions (attachment_id,domain,version,last_seen_at) VALUES (?,?,?,?) ON CONFLICT(attachment_id,domain) DO UPDATE SET version=COALESCE(excluded.version,activation_versions.version),last_seen_at=excluded.last_seen_at`,
      ).bind(c.attachment_id!, domain, version, now),
    )
  await env.DB.batch(statements)
}
