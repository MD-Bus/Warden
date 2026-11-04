import { handleBundleCheck } from "./bundle-check.server"
import { buildCheckResponse, KEY_PATTERN, normalizeDomain, type CheckResponse } from "../lib/license"
import { clientIp, reportUnknownKey } from "./guard.server"
import { applyRules } from "./protection.server"
import { compareVersions, isChannel, latestRelease, readReportedVersion, type Channel } from "../lib/releases"
import { DEFAULT_STATUSES } from "../lib/statuses"
import { releaseSummary, visibleFiles } from "./download.server"
import { getLicenseByKey, listActivations, recordActivation, type License } from "./licenses.server"
import { getStatusSetForLicense } from "./statuses.server"
import { readTextUpTo } from "./api-http.server"
import { signatureHeaders, getSigningKey } from "./signing.server"
import { hmacHex, json } from "./util.server"

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "X-Warden-Signature-Ed25519, X-Warden-Key-Id, X-Warden-Signature", "cache-control": "no-store" }

export const MAX_CHECK_BODY_BYTES = 4096

/** A nonce is echoed in the signed response: 8 to 64 letters, digits, dots, underscores, tildes or hyphens. */
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{8,64}$/

/**
 * What a site sends with a check: its domain, and optionally the version it runs, the release channel it follows and
 * a nonce to echo.
 */
type CheckRequest = { domain: string | null; version: string | null; channel: Channel; nonce: string | null; tag: string | null }

async function readCheckRequest(request: Request): Promise<CheckRequest> {
  const q = new URL(request.url).searchParams
  let body: Record<string, unknown> = {}
  if (request.method === "POST") {
    // Only a small JSON body is expected. A larger body is ignored and is not read beyond the limit.
    const text = await readTextUpTo(request, MAX_CHECK_BODY_BYTES)
    if (text) {
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed
      } catch {}
    }
  }
  // The query string wins over the body, as it always has for the domain.
  const pick = (name: string) => q.get(name) ?? (typeof body[name] === "string" ? (body[name] as string) : null)
  const domainRaw = pick("domain")
  const channel = pick("channel")
  const nonce = pick("nonce")
  return {
    tag: pick("tag"),
    domain: domainRaw ? normalizeDomain(domainRaw) : null,
    version: readReportedVersion(pick("version")),
    channel: isChannel(channel) ? channel : "stable",
    nonce: nonce && NONCE_PATTERN.test(nonce) ? nonce : null,
  }
}

/**
 * Public endpoint: GET or POST /check/<licence key>[?domain=example.com][&version=1.3.0][&channel=beta][&nonce=…]
 *
 * Returns JSON with `valid` and `status`. The licence key in the path is the credential. Every response is signed
 * with the install's Ed25519 key (X-Warden-Signature-Ed25519 over the raw body, X-Warden-Key-Id), so a site verifies
 * with the public key that the response came from this server unmodified; the body names the licence key, the domain
 * and the nonce it answers. X-Warden-Signature (HMAC-SHA256 keyed with the licence key) is deprecated and is removed in
 * 1.0.0. A known key returns HTTP 200 and an unknown key 404, both with a JSON body.
 * When a domain is sent, the site is registered as an activation of the licence (within the licence's site limit).
 * When a version is sent, the response includes `update`: the newest release this licence can download and whether
 * it is newer than the site's version, and the version is recorded for the site.
 */
export async function handleCheck(request: Request, env: Env, ctx: ExecutionContext, key: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" } })
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, { status: 405, headers: CORS })

  const now = Date.now()
  const license = KEY_PATTERN.test(key) ? await getLicenseByKey(env, key) : null
  if (license && license.expiry_mode !== "legacy" && license.expiry_mode) return handleBundleCheck(request, env, ctx, license)
  const { domain, version, channel, nonce, tag } = await readCheckRequest(request)
  // Activations only matter for the limit, so they are loaded only for licences that have one.
  const activated = license && license.max_sites !== null ? (await listActivations(env, license.id)).map((a) => a.domain) : []
  const set = license ? await getStatusSetForLicense(env, license) : DEFAULT_STATUSES
  const signing = await getSigningKey(env)
  const result: CheckResponse = { ...buildCheckResponse(license, domain, now, activated, set), license_key: key, domain, nonce, ...(tag !== null ? {tag} : {}) }
  if (license && version) {
    const files = await visibleFiles(env, license, domain, result, now, set, new URL(request.url).origin)
    const latest = latestRelease(files.filter((f) => f.available), channel)
    result.update = { current: version, available: Boolean(latest && compareVersions(latest.version, version) > 0), latest: latest ? await releaseSummary(latest, signing) : null }
  }
  const body = JSON.stringify(result)

  if (license) {
    const ip = clientIp(request)
    ctx.waitUntil(
      recordCheck(env, license, result.status, domain, version, ip, now)
        // The rules read the check just recorded.
        .then(() => applyRules(env, ip, { kind: "check", invalid: !result.valid }, now))
        .catch((error) => console.error("Failed to record check:", error))
    )
  } else reportUnknownKey(env, ctx, request)
  const headers: Record<string, string> = { ...CORS, "content-type": "application/json; charset=utf-8", ...(await signatureHeaders(signing, body)) }
  // Deprecated: the HMAC can be computed by anyone holding the licence key. Removed in 1.0.0.
  if (license) headers["x-warden-signature"] = await hmacHex(license.license_key, body)
  return new Response(body, { status: license ? 200 : 404, headers })
}

async function recordCheck(env: Env, license: License, status: string, domain: string | null, version: string | null, ip: string | null, now: number) {
  // A site whose check is invalid because of its domain or the site limit is not registered.
  if (domain && status !== "domain_mismatch" && status !== "site_limit_reached") await recordActivation(env, license, domain, now, version, ip)
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET last_check_at = ?, last_check_domain = ?, check_count = check_count + 1 WHERE id = ?").bind(now, domain, license.id),
    env.DB.prepare("INSERT INTO activity (license_id, at, event, status, domain, detail, ip) VALUES (?, ?, 'check', ?, ?, ?, ?)").bind(license.id, now, status, domain, version ? `Version ${version}` : "", ip),
  ])
}
