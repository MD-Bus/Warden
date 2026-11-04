import { test } from "node:test"
import assert from "node:assert/strict"
import { makeBucket, makeCtx, makeDb } from "./helpers/d1.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { handleDownload, handleLinkDownload } from "../app/server/download.server.ts"
import { createDownloadLink, DOWNLOAD_LINK_TTL_MS, readDownloadLink } from "../app/server/download-links.server.ts"
import { storeFile } from "../app/server/files.server.ts"
import { getSigningKey, resetSigningKeyCache } from "../app/server/signing.server.ts"
import { clearProtectionCache } from "../app/server/protection.server.ts"

const ORIGIN = "https://w.dev"

async function setup() {
  resetSigningKeyCache()
  clearProtectionCache()
  const env = { DB: makeDb().DB, FILES: makeBucket().bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  const apiKey = (await createApiKey(env, "Tests", "full")).secret
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
    await settle()
    return (await res.json()) as any
  }
  const parent = await api("POST", "/apps", { name: "Harbor Theme", slug: "harbor-theme" })
  const child = await api("POST", "/apps", { name: "Harbor Theme Child", slug: "harbor-theme-child" })
  const parentFile = await storeFile(env, { app: parent }, { name: "harbor-theme.zip", version: "2.0.0", statuses: ["active"], size: 6, body: new Response("parent").body })
  const childFile = await storeFile(env, { app: child }, { name: "harbor-theme-child.zip", version: "1.1.0", statuses: ["active"], checkDomain: true, size: 5, body: new Response("child").body })
  assert.ok("file" in parentFile && "file" in childFile)
  const licence = await api("POST", "/licenses", {
    name: "Harbor Studio website",
    expiry_mode: "shared",
    domains: "harborstudio.com",
    apps: [
      { tag: "parent-theme", app: parent.id, status: "active" },
      { tag: "child-theme", app: child.id, status: "active" },
    ],
  })
  const check = async (query: string) => {
    const res = await handleCheck(new Request(`${ORIGIN}/check/${licence.key}?${query}`), env, ctx, licence.key)
    await settle()
    return (await res.json()) as any
  }
  const fetchLink = async (url: string, method = "GET") => {
    const u = new URL(url)
    const res = await handleLinkDownload(new Request(u, { method }), env, ctx, u.pathname.split("/").pop()!)
    await settle()
    return res
  }
  return { env, ctx, settle, api, parent, child, licence, check, fetchLink, parentFile: parentFile.file, childFile: childFile.file }
}

test("update links do not contain the licence key and download the release", async () => {
  const s = await setup()
  const c = await s.check("tag=child-theme&domain=harborstudio.com&version=1.0.0")
  const url: string = c.update.latest.download_url
  assert.match(url, /^https:\/\/w\.dev\/download\/t\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.ok(!url.includes(s.licence.key), "the key is not in the link")
  assert.ok(url.length < 400, `link stays short enough for updaters' temporary file names (${url.length})`)

  const res = await s.fetchLink(url)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), "child")
  assert.equal(res.headers.get("x-warden-sha256"), s.childFile.sha256)

  // The download list also answers with links, scoped to each tag.
  const list = (await (await handleDownload(new Request(`${ORIGIN}/download/${s.licence.key}?tag=parent-theme&domain=harborstudio.com`), s.env, s.ctx, s.licence.key, null)).json()) as any
  assert.ok(list.files.every((f: any) => f.download_url.startsWith(`${ORIGIN}/download/t/`) && !f.download_url.includes(s.licence.key)))
  assert.equal(await (await s.fetchLink(list.latest.download_url)).text(), "parent")
})

test("a link binds the tag and the domain, and the release rules apply when it is used", async () => {
  const s = await setup()
  const signing = await getSigningKey(s.env)
  const license = { id: s.licence.id, license_key: s.licence.key }
  // A link for the child's file under the parent's tag does not open it.
  const wrongTag = await createDownloadLink(signing, ORIGIN, { ...license, tag: "parent-theme" }, s.childFile.id, "harborstudio.com", Date.now())
  assert.equal((await s.fetchLink(wrongTag)).status, 404)
  // The child's file requires an allowed domain: the bound domain wins over the query.
  const bound = await createDownloadLink(signing, ORIGIN, { ...license, tag: "child-theme" }, s.childFile.id, "other.example", Date.now())
  assert.equal((await s.fetchLink(`${bound}?domain=harborstudio.com`)).status, 403)
  // Without a bound domain, ?domain= is read, as for the key-based address.
  const unbound = await createDownloadLink(signing, ORIGIN, { ...license, tag: "child-theme" }, s.childFile.id, null, Date.now())
  assert.equal((await s.fetchLink(unbound)).status, 403)
  assert.equal((await s.fetchLink(`${unbound}?domain=harborstudio.com`)).status, 200)

  // A status that is no longer valid denies the download through an existing link.
  const link = (await s.check("tag=parent-theme&domain=harborstudio.com&version=1.0.0")).update.latest.download_url
  assert.equal((await s.fetchLink(link, "HEAD")).status, 200)
  await s.api("POST", `/licenses/${s.licence.id}/status`, { tag: "parent-theme", status: "suspended" })
  assert.equal((await s.fetchLink(link)).status, 403)
})

test("expired, altered and revoked links are refused", async () => {
  const s = await setup()
  const signing = await getSigningKey(s.env)
  const now = Date.now()
  const link = await createDownloadLink(signing, ORIGIN, { id: s.licence.id, license_key: s.licence.key, tag: "parent-theme" }, s.parentFile.id, "harborstudio.com", now)
  const token = link.split("/").pop()!
  assert.equal((await readDownloadLink(signing, token, now + DOWNLOAD_LINK_TTL_MS - 1)).ok, true)
  assert.deepEqual(await readDownloadLink(signing, token, now + DOWNLOAD_LINK_TTL_MS), { ok: false, reason: "expired" })

  const old = await createDownloadLink(signing, ORIGIN, { id: s.licence.id, license_key: s.licence.key, tag: "parent-theme" }, s.parentFile.id, "harborstudio.com", now - DOWNLOAD_LINK_TTL_MS)
  const expired = await s.fetchLink(old)
  assert.equal(expired.status, 410)
  assert.equal(((await expired.json()) as any).status, "link_expired")

  // Claims changed without the signature: another file, a later expiry.
  const [payload, signature] = token.split(".")
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
  const forged = Buffer.from(JSON.stringify({ ...claims, e: claims.e + DOWNLOAD_LINK_TTL_MS })).toString("base64url")
  assert.equal((await s.fetchLink(`${ORIGIN}/download/t/${forged}.${signature}`)).status, 404)
  for (const bad of ["x", "a.b.c", `${payload}.`, `${payload}.${"A".repeat(86)}`]) assert.deepEqual(await readDownloadLink(signing, bad, now), { ok: false, reason: "invalid" }, bad)

  // Regenerating the key ends the links issued before.
  assert.equal((await s.fetchLink(link)).status, 200)
  await s.api("POST", `/licenses/${s.licence.id}/regenerate-key`)
  assert.equal((await s.fetchLink(link)).status, 410)
})
