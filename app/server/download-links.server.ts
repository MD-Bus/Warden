import { base64url, fromBase64url, signBytes, verifyBytes, type SigningKey } from "./signing.server"

/**
 * Download links. Check and download answers offer releases as /download/t/<token> instead of
 * /download/<licence key>/<file id>, so the licence key does not appear where updaters show or log the package
 * address (WordPress prints it during an update, web servers and proxies log it).
 *
 * A token is `<claims>.<signature>`, both base64url: the claims are JSON naming the licence, the file, the tag, the
 * domain, the expiry time and the start of the SHA-256 of the licence key; the signature is the install's Ed25519
 * signature of `warden-download-link.<claims>`. Nothing is stored. A link opens one file for one licence and tag,
 * stops working after DOWNLOAD_LINK_TTL_MS or when the licence key is regenerated, and the release rules and the
 * licence's status are evaluated again when it is used, exactly as for /download/<key>/<file id>.
 */
export const DOWNLOAD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Longest token accepted in the path: well above any real token (a few hundred characters). */
export const MAX_TOKEN_LENGTH = 1024

const CONTEXT = "warden-download-link."
const encoder = new TextEncoder()

export type DownloadLinkClaims = {
  /** Licence id. */
  l: string
  /** File id. */
  f: string
  /** Tag of the app attachment, when the licence has tagged apps. */
  t?: string
  /** Domain the site sent with its check, normalised. */
  d?: string
  /** Expiry, milliseconds since the epoch. */
  e: number
  /** First 16 hex characters of the SHA-256 of the licence key: a regenerated key ends every link issued before. */
  k: string
}

export type DownloadLinkResult = { ok: true; claims: DownloadLinkClaims } | { ok: false; reason: "invalid" | "expired" }

/** First 16 hex characters of the SHA-256 of a licence key. */
export async function keyFingerprint(licenseKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(licenseKey)))
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** A signed download link for one file of a licence, valid for DOWNLOAD_LINK_TTL_MS from `now`. */
export async function createDownloadLink(
  signing: SigningKey,
  origin: string,
  license: { id: string; license_key: string; tag?: string },
  fileId: string,
  domain: string | null,
  now: number,
): Promise<string> {
  const claims: DownloadLinkClaims = { l: license.id, f: fileId, ...(license.tag ? { t: license.tag } : {}), ...(domain ? { d: domain } : {}), e: now + DOWNLOAD_LINK_TTL_MS, k: await keyFingerprint(license.license_key) }
  const payload = base64url(encoder.encode(JSON.stringify(claims)))
  return `${origin}/download/t/${payload}.${base64url(await signBytes(signing, CONTEXT + payload))}`
}

/** Verifies a token from a download link. The signature is checked before the claims are read. */
export async function readDownloadLink(signing: SigningKey, token: string, now: number): Promise<DownloadLinkResult> {
  const parts = token.split(".")
  if (token.length > MAX_TOKEN_LENGTH || parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "invalid" }
  const [payload, signature] = parts
  try {
    if (!(await verifyBytes(signing, CONTEXT + payload, fromBase64url(signature)))) return { ok: false, reason: "invalid" }
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as DownloadLinkClaims
    if (typeof claims?.l !== "string" || typeof claims.f !== "string" || typeof claims.e !== "number" || typeof claims.k !== "string") return { ok: false, reason: "invalid" }
    return claims.e <= now ? { ok: false, reason: "expired" } : { ok: true, claims }
  } catch {
    return { ok: false, reason: "invalid" }
  }
}
