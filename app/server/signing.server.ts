/**
 * The install's Ed25519 signing key. Check responses, download responses and release checksums are signed with it, so
 * a site verifies them with the public key alone: holding a licence key is not enough to forge a valid response.
 *
 * The key pair is generated on first use and stored in settings under signing_key (the private key as a JWK). It can
 * be moved to the WARDEN_SIGNING_KEY Worker secret so that reading the database does not give it away. It never
 * changes: sites pin the public key in their code. The public half is recorded under signing_key_public, so a missing
 * private key stops the install instead of replacing the key sites trust. See "The signing key" in docs/checking.md.
 */
const KEY = "signing_key"
const PUBLIC_KEY = "signing_key_public"

export type SigningKey = {
  /** First 16 hex characters of the SHA-256 of the raw public key. Sent with every signature (X-Warden-Key-Id). */
  keyId: string
  /** The raw 32-byte public key, base64. The format libsodium (PHP sodium_crypto_sign_verify_detached) expects. */
  publicKey: string
  /** The same key as SubjectPublicKeyInfo PEM, for OpenSSL, Node.js and WebCrypto. */
  publicKeyPem: string
  createdAt: number
  privateKey: CryptoKey
  publicCryptoKey: CryptoKey
  /** Where the private key in use comes from. */
  source: "secret" | "database"
  /** Whether the database still holds the private key. */
  databaseCopy: boolean
  /** Why WARDEN_SIGNING_KEY is set but not used, or null. */
  secretProblem: string | null
}

type StoredKey = { jwk: JsonWebKey; created_at: number }

const encoder = new TextEncoder()
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow it. */
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])

// One install has one key, which never changes, so it is kept for the life of the Worker instance once loaded.
let cached: Promise<SigningKey> | null = null

/** Forgets the loaded key. Only tests need this, since each test uses a fresh database. */
export function resetSigningKeyCache() {
  cached = null
}

export function base64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** Base64url without padding (RFC 4648 section 5), for values carried in a URL path. */
export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

export function getSigningKey(env: Env): Promise<SigningKey> {
  cached ??= loadOrCreate(env).catch((error) => {
    cached = null
    throw error
  })
  return cached
}

/** Signs and verifies a probe, because a JWK whose d and x disagree can import without error and then sign invalid answers. */
async function halvesMatch(jwk: JsonWebKey): Promise<boolean> {
  try {
    const probe = encoder.encode("warden-signing-key-probe")
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"])
    const publicKey = await crypto.subtle.importKey("raw", fromBase64url(jwk.x!), { name: "Ed25519" }, false, ["verify"])
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, await crypto.subtle.sign({ name: "Ed25519" }, privateKey, probe), probe)
  } catch {
    return false
  }
}

/**
 * The key from the WARDEN_SIGNING_KEY secret, which holds the JSON of the settings row ({"jwk": {...}, "created_at": ...})
 * or the bare private JWK. Returns the key, or the reason it cannot be used. Both are null when the secret is not set.
 */
async function readSecret(env: Env): Promise<{ key: StoredKey | null; problem: string | null }> {
  const raw = env.WARDEN_SIGNING_KEY?.trim()
  if (!raw) return { key: null, problem: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { key: null, problem: "it is not valid JSON" }
  }
  const value = (parsed ?? {}) as Partial<StoredKey> & JsonWebKey
  const jwk = (value.jwk ?? value) as JsonWebKey
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) return { key: null, problem: "it is not an Ed25519 private JWK" }
  const clean = { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x }
  if (!(await halvesMatch(clean))) return { key: null, problem: "its private key does not match its public key" }
  return { key: { jwk: clean, created_at: Number(value.created_at) || 0 }, problem: null }
}

async function loadOrCreate(env: Env): Promise<SigningKey> {
  const [secret, row, recorded] = await Promise.all([readSecret(env), readStored(env), readPublicKey(env)])
  // The stored row is the key in use while it exists. Without it, the recorded public key tells which key sites trust.
  const trusted = row?.jwk.x ?? recorded
  let secretProblem = secret.problem
  if (secret.key && trusted && secret.key.jwk.x !== trusted) secretProblem = "it holds a different key than the one sites trust"
  if (secretProblem) console.error(`WARDEN_SIGNING_KEY is ignored: ${secretProblem}. Put the stored key in the secret (see docs/checking.md).`)

  const fromSecret = secretProblem ? null : secret.key
  let stored = fromSecret ? { jwk: fromSecret.jwk, created_at: fromSecret.created_at || row?.created_at || Date.now() } : row
  if (!stored) {
    // A new key would make every site reject every answer, for good. An error can be repaired by restoring the secret.
    if (recorded || secretProblem) throw new Error(`The signing key is missing: restore WARDEN_SIGNING_KEY${secretProblem ? ` (${secretProblem})` : ""}. See docs/checking.md.`)
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair
    const { kty, crv, d, x } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
    // Two instances can create a key at the same moment: the first one stored wins, and both use it.
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING")
      .bind(KEY, JSON.stringify({ jwk: { kty, crv, d, x }, created_at: Date.now() } satisfies StoredKey), Date.now())
      .run()
    stored = await readStored(env)
    if (!stored) throw new Error("The signing key could not be stored.")
  }
  if (recorded !== stored.jwk.x) {
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(PUBLIC_KEY, stored.jwk.x, Date.now())
      .run()
  }
  const raw = fromBase64url(stored.jwk.x!)
  const der = new Uint8Array(SPKI_PREFIX.length + raw.length)
  der.set(SPKI_PREFIX)
  der.set(raw, SPKI_PREFIX.length)
  const pem = `-----BEGIN PUBLIC KEY-----\n${base64(der)}\n-----END PUBLIC KEY-----`
  return {
    keyId: (await sha256Bytes(raw)).slice(0, 16),
    publicKey: base64(raw),
    publicKeyPem: pem,
    createdAt: stored.created_at,
    privateKey: await crypto.subtle.importKey("jwk", stored.jwk, { name: "Ed25519" }, false, ["sign"]),
    publicCryptoKey: await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]),
    source: fromSecret ? "secret" : "database",
    databaseCopy: row !== null || !fromSecret,
    secretProblem,
  }
}

async function readPublicKey(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(PUBLIC_KEY).first<{ value: string }>()
  return row?.value ?? null
}

async function readStored(env: Env): Promise<StoredKey | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>()
  if (!row) return null
  const parsed = JSON.parse(row.value) as StoredKey
  return parsed?.jwk?.d && parsed.jwk.x ? parsed : null
}

async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Ed25519 signature of a UTF-8 text, base64. */
export async function signText(key: SigningKey, text: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, encoder.encode(text))))
}

/** Raw Ed25519 signature of a UTF-8 text. */
export async function signBytes(key: SigningKey, text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, encoder.encode(text)))
}

/** Whether `signature` is this install's Ed25519 signature of a UTF-8 text. */
export async function verifyBytes(key: SigningKey, text: string, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return signature.length === 64 && crypto.subtle.verify({ name: "Ed25519" }, key.publicCryptoKey, signature, encoder.encode(text))
}

/**
 * Signature of a release: Ed25519 over the release's SHA-256 checksum as 64 lowercase hex characters. An updater
 * hashes the package it downloaded and verifies the signature against that hash. Null for a file without a checksum
 * (uploaded before 0.2.0).
 */
export async function signRelease(key: SigningKey, sha256: string): Promise<string | null> {
  return /^[0-9a-f]{64}$/.test(sha256) ? signText(key, sha256) : null
}

/** The public part of the key, as the API and the dashboard show it. */
export function publicSigningKey(key: SigningKey) {
  return { algorithm: "Ed25519", key_id: key.keyId, public_key: key.publicKey, public_key_pem: key.publicKeyPem, created_at: new Date(key.createdAt).toISOString() }
}

/** Headers carrying the signature of a JSON body. */
export async function signatureHeaders(key: SigningKey, body: string): Promise<Record<string, string>> {
  return { "x-warden-signature-ed25519": await signText(key, body), "x-warden-key-id": key.keyId }
}
