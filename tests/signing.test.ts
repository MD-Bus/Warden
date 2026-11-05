import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash, createPublicKey, verify } from "node:crypto"
import { makeBucket, makeCtx, makeDb } from "./helpers/d1.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { handleDownload } from "../app/server/download.server.ts"
import { storeFile } from "../app/server/files.server.ts"
import { createLicense, type LicenseInput } from "../app/server/licenses.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"
import { getSigningKey, resetSigningKeyCache } from "../app/server/signing.server.ts"
import { clearBlockCache } from "../app/server/ip-blocks.server.ts"
import { clearProtectionCache } from "../app/server/protection.server.ts"

const ORIGIN = "https://w.dev"
const licenseInput: LicenseInput = { name: "Harbor", customer_name: "", customer_email: "", app_id: null, max_sites: null, status: "active", expires_at: null, domains: "", message: "", notes: "" }

function setup() {
  // Each test has its own database, so its own signing key.
  resetSigningKeyCache()
  clearProtectionCache()
  clearBlockCache()
  const env = { DB: makeDb().DB, FILES: makeBucket().bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  return { env, ctx, settle }
}

/** Verifies an Ed25519 signature the way a site would: with the PEM public key only. */
function verifies(pem: string, message: string, signature: string | null): boolean {
  if (!signature) return false
  return verify(null, Buffer.from(message), createPublicKey(pem), Buffer.from(signature, "base64"))
}

test("one key pair per install: created on first use, stored, and the same after a restart", async () => {
  const { env } = setup()
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'signing_key'").first("n"), 0)
  const first = await getSigningKey(env)
  assert.equal(Buffer.from(first.publicKey, "base64").length, 32)
  assert.match(first.keyId, /^[0-9a-f]{16}$/)
  assert.equal(first.keyId, createHash("sha256").update(Buffer.from(first.publicKey, "base64")).digest("hex").slice(0, 16))
  // The PEM and the raw key are the same key.
  const raw = createPublicKey(first.publicKeyPem).export({ format: "jwk" }).x!
  assert.equal(Buffer.from(raw, "base64url").toString("base64"), first.publicKey)

  resetSigningKeyCache()
  const again = await getSigningKey(env)
  assert.equal(again.publicKey, first.publicKey)
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'signing_key'").first("n"), 1)
})

test("check responses are signed with Ed25519 and name the key, domain and nonce they answer", async () => {
  const { env, ctx, settle } = setup()
  const license = await createLicense(env, licenseInput)
  const key = await getSigningKey(env)

  const res = await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}?domain=www.Harbor.com&nonce=n0nce-1234`), env, ctx, license.license_key)
  await settle()
  const body = await res.text()
  assert.equal(res.headers.get("x-warden-key-id"), key.keyId)
  assert.ok(verifies(key.publicKeyPem, body, res.headers.get("x-warden-signature-ed25519")))
  assert.match(res.headers.get("access-control-expose-headers")!, /X-Warden-Signature-Ed25519/)
  const json = JSON.parse(body)
  assert.deepEqual([json.valid, json.license_key, json.domain, json.nonce], [true, license.license_key, "harbor.com", "n0nce-1234"])
  // A changed body no longer verifies.
  assert.equal(verifies(key.publicKeyPem, body.replace('"valid":true', '"valid":false'), res.headers.get("x-warden-signature-ed25519")), false)
  // The HMAC header is still sent until 1.0.0.
  assert.match(res.headers.get("x-warden-signature")!, /^[0-9a-f]{64}$/)

  // A nonce outside the allowed format is not echoed; the nonce can also come in a POST body.
  const odd = await (await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}?nonce=${encodeURIComponent("<script>")}`), env, ctx, license.license_key)).json()
  assert.equal((odd as any).nonce, null)
  const posted = await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}`, { method: "POST", body: JSON.stringify({ domain: "harbor.com", nonce: "from-the-body" }) }), env, ctx, license.license_key)
  assert.equal(((await posted.json()) as any).nonce, "from-the-body")
  await settle()

  // An unknown key is signed too, so a site can trust an "unknown" answer as much as a valid one.
  const unknownKey = "WRD-AAAAA-BBBBB-CCCCC-DDDDD"
  const unknown = await handleCheck(new Request(`${ORIGIN}/check/${unknownKey}`), env, ctx, unknownKey)
  const unknownBody = await unknown.text()
  assert.equal(unknown.status, 404)
  assert.ok(verifies(key.publicKeyPem, unknownBody, unknown.headers.get("x-warden-signature-ed25519")))
  assert.equal(JSON.parse(unknownBody).license_key, unknownKey)
  assert.equal(unknown.headers.get("x-warden-signature"), null)
  await settle()
})

test("releases are signed: the update offer, the download list, the file and the API carry the signature of the checksum", async () => {
  const { env, ctx, settle } = setup()
  const license = await createLicense(env, licenseInput)
  const key = await getSigningKey(env)
  const text = "the package"
  const stored = await storeFile(env, { license }, { name: "harbor-1.1.0.zip", version: "1.1.0", checkDomain: false, size: text.length, body: new Response(text).body, contentType: "application/zip" })
  assert.ok("file" in stored)
  const sha256 = createHash("sha256").update(text).digest("hex")

  const check = (await (await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}?version=1.0.0`), env, ctx, license.license_key)).json()) as any
  await settle()
  assert.equal(check.update.latest.sha256, sha256)
  assert.ok(verifies(key.publicKeyPem, sha256, check.update.latest.signature))

  const list = await handleDownload(new Request(`${ORIGIN}/download/${license.license_key}`), env, ctx, license.license_key, null)
  const listBody = await list.text()
  assert.ok(verifies(key.publicKeyPem, listBody, list.headers.get("x-warden-signature-ed25519")))
  const parsed = JSON.parse(listBody)
  assert.equal(parsed.license_key, license.license_key)
  assert.ok(verifies(key.publicKeyPem, sha256, parsed.files[0].signature))
  assert.ok(verifies(key.publicKeyPem, sha256, parsed.latest.signature))

  const file = await handleDownload(new Request(`${ORIGIN}/download/${license.license_key}/${stored.file.id}`), env, ctx, license.license_key, stored.file.id)
  const bytes = Buffer.from(await file.arrayBuffer())
  await settle()
  const digest = createHash("sha256").update(bytes).digest("hex")
  assert.equal(file.headers.get("x-warden-sha256"), digest)
  assert.ok(verifies(key.publicKeyPem, digest, file.headers.get("x-warden-release-signature")))
  assert.equal(file.headers.get("x-warden-key-id"), key.keyId)

  // A denied download is a signed JSON answer.
  await env.DB.prepare("UPDATE licenses SET status = 'suspended' WHERE id = ?").bind(license.id).run()
  const denied = await handleDownload(new Request(`${ORIGIN}/download/${license.license_key}/${stored.file.id}`), env, ctx, license.license_key, stored.file.id)
  await settle()
  assert.equal(denied.status, 403)
  assert.ok(verifies(key.publicKeyPem, await denied.text(), denied.headers.get("x-warden-signature-ed25519")))

  const apiKey = (await createApiKey(env, "r", "read")).secret
  const api = async (path: string) => (await (await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { headers: { authorization: `Bearer ${apiKey}` } }), env, ctx)).json()) as any
  const files = await api(`/licenses/${license.id}/files`)
  assert.ok(verifies(key.publicKeyPem, sha256, files.data[0].signature))
  assert.deepEqual(await api("/signing-key"), { algorithm: "Ed25519", key_id: key.keyId, public_key: key.publicKey, public_key_pem: key.publicKeyPem, created_at: new Date(key.createdAt).toISOString() })
})

test("API lists: every list answers { data, next } and pages with limit and cursor", async () => {
  const { env, ctx, settle } = setup()
  const apiKey = (await createApiKey(env, "f", "full")).secret
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
    await settle()
    return { status: res.status, json: (await res.json()) as any }
  }
  for (const name of ["Atlas Booking", "Harbor Theme", "Maple Dental"]) assert.equal((await call("POST", "/apps", { name })).status, 201)
  const first = await call("GET", "/apps?limit=2")
  assert.equal(first.json.data.length, 2)
  const second = await call("GET", `/apps?limit=2&cursor=${first.json.next}`)
  assert.deepEqual([second.json.data.length, second.json.next], [1, null])
  assert.equal((await call("GET", "/apps?cursor=app_unknown")).json.error.code, "invalid_cursor")

  const license = (await call("POST", "/licenses", { name: "Copper Salon" })).json
  for (const days of [10, 20, 30]) await call("POST", `/licenses/${license.id}/renew`, { days })
  const activity = await call("GET", `/licenses/${license.id}/activity?limit=2`)
  assert.equal(activity.json.data.length, 2)
  const rest = await call("GET", `/licenses/${license.id}/activity?limit=2&cursor=${activity.json.next}`)
  assert.ok(rest.json.data.length >= 1)
  assert.equal(new Set([...activity.json.data, ...rest.json.data].map((a: any) => a.detail + a.at)).size, activity.json.data.length + rest.json.data.length)
  assert.equal((await call("GET", `/licenses/${license.id}/activity?cursor=nope`)).json.error.code, "invalid_cursor")

  for (const path of ["/statuses", `/licenses/${license.id}/activations`, `/licenses/${license.id}/files`, `/licenses/${license.id}/tracks`, "/ip-blocks"]) {
    const res = await call("GET", path)
    assert.ok(Array.isArray(res.json.data) && "next" in res.json, path)
  }
  assert.equal((await call("GET", "/analytics?license=lic_missing")).json.error.code, "license_not_found")
  assert.equal((await call("DELETE", "/ip-blocks/blk_missing")).json.error.code, "ip_block_not_found")
  assert.equal((await call("POST", "/protection", {})).status, 405)
})

const silently = async <T>(run: () => Promise<T>): Promise<T> => {
  const errors = console.error
  console.error = () => {}
  try {
    return await run()
  } finally {
    console.error = errors
  }
}

async function storedRow(env: Env) {
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'signing_key'").first<{ value: string }>())!.value
}

async function anotherKey() {
  resetSigningKeyCache()
  const other = setup().env
  await getSigningKey(other)
  resetSigningKeyCache()
  return storedRow(other)
}

const removeStoredKey = (env: Env) => env.DB.prepare("DELETE FROM settings WHERE key = 'signing_key'").run()

test("the WARDEN_SIGNING_KEY secret is used when it holds the stored key, and on an empty database", async () => {
  const { env } = setup()
  const stored = await getSigningKey(env)
  assert.equal(stored.source, "database")
  const row = await storedRow(env)

  // Same key in the secret while the row exists: the secret is used and the copy is reported.
  resetSigningKeyCache()
  const both = await getSigningKey({ ...env, WARDEN_SIGNING_KEY: row } as Env)
  assert.deepEqual([both.publicKey, both.source, both.databaseCopy, both.secretProblem], [stored.publicKey, "secret", true, null])

  // Database row removed: the secret alone signs, with the same public key.
  resetSigningKeyCache()
  await removeStoredKey(env)
  const fromSecret = await getSigningKey({ ...env, WARDEN_SIGNING_KEY: row } as Env)
  assert.deepEqual([fromSecret.publicKey, fromSecret.databaseCopy], [stored.publicKey, false])
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'signing_key'").first("n"), 0, "a key from the secret is not written to the database")

  // A bare JWK works too.
  resetSigningKeyCache()
  const bare = JSON.stringify((JSON.parse(row) as { jwk: JsonWebKey }).jwk)
  assert.equal((await getSigningKey({ ...env, WARDEN_SIGNING_KEY: bare } as Env)).publicKey, stored.publicKey)

  // A new install can start from the secret.
  resetSigningKeyCache()
  const fresh = setup().env
  assert.equal((await getSigningKey({ ...fresh, WARDEN_SIGNING_KEY: row } as Env)).publicKey, stored.publicKey)
})

test("a WARDEN_SIGNING_KEY secret that cannot be used is ignored, and reported, while the stored key exists", async () => {
  const { env } = setup()
  const stored = await getSigningKey(env)
  const row = await storedRow(env)
  const other = await anotherKey()
  const wrongHalf = JSON.parse(row) as { jwk: JsonWebKey }
  wrongHalf.jwk.d = (JSON.parse(other) as { jwk: JsonWebKey }).jwk.d

  for (const [value, problem] of [
    ["not json", /valid JSON/],
    ["null", /Ed25519/],
    ['{"kty":"RSA"}', /Ed25519/],
    [row.slice(0, -5), /valid JSON/],
    [other, /different key/],
    [JSON.stringify(wrongHalf), /does not match/],
  ] as const) {
    resetSigningKeyCache()
    const used = await silently(() => getSigningKey({ ...env, WARDEN_SIGNING_KEY: value } as Env))
    assert.equal(used.publicKey, stored.publicKey, "sites keep verifying with the key they trust")
    assert.equal(used.source, "database")
    assert.match(used.secretProblem ?? "", problem)
  }
})

test("a new key is never created once sites trust one: removing the stored key without a usable secret fails", async () => {
  const { env } = setup()
  const stored = await getSigningKey(env)
  const row = await storedRow(env)
  const other = await anotherKey()
  await removeStoredKey(env)

  for (const secret of [undefined, "not json", row.slice(0, -5), `"${row}"`, other]) {
    resetSigningKeyCache()
    await assert.rejects(silently(() => getSigningKey({ ...env, WARDEN_SIGNING_KEY: secret } as Env)), /signing key is missing/)
  }
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'signing_key'").first("n"), 0, "no replacement key was stored")

  // Restoring the secret repairs the install.
  resetSigningKeyCache()
  assert.equal((await getSigningKey({ ...env, WARDEN_SIGNING_KEY: row } as Env)).publicKey, stored.publicKey)
})

test("an unusable secret on an empty database fails instead of creating a key the secret does not hold", async () => {
  resetSigningKeyCache()
  await assert.rejects(silently(() => getSigningKey({ ...setup().env, WARDEN_SIGNING_KEY: "not json" } as Env)), /signing key is missing/)
})
