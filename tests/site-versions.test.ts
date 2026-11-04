import { test } from "node:test"
import assert from "node:assert/strict"
import { makeDb, makeBucket, makeCtx } from "./helpers/d1.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { versionsInUse } from "../app/server/apps.server.ts"
import { storeFile } from "../app/server/files.server.ts"
import { resetSigningKeyCache } from "../app/server/signing.server.ts"
import { clearProtectionCache } from "../app/server/protection.server.ts"

const origin = "https://warden.example"

async function setup() {
  resetSigningKeyCache()
  clearProtectionCache()
  const db = makeDb()
  const env = { DB: db.DB, FILES: makeBucket().bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  const secret = (await createApiKey(env, "Tests", "full")).secret
  async function api(method: string, path: string, body?: unknown) {
    const res = await handleApi(
      new Request(`${origin}/api/v1${path}`, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      ctx,
    )
    await settle()
    return (await res.json()) as any
  }
  async function check(key: string, query: string) {
    const res = await handleCheck(new Request(`${origin}/check/${key}?${query}`), env, ctx, key)
    await settle()
    return (await res.json()) as any
  }
  const app = await api("POST", "/apps", { name: "Harbor Theme", slug: "harbor-theme" })
  const release = (version: string, statuses: string[], channel = "stable") => storeFile(env, { app }, { name: `harbor-${version}.zip`, version, statuses, channel, size: 1, body: new Response("x").body })
  const licence = (status: string, extra: Record<string, unknown> = {}) => api("POST", "/licenses", { name: "Harbor Studio", expiry_mode: "shared", expires_at: null, apps: [{ tag: "default", app: app.id, status }], ...extra })
  return { env, api, check, app, release, licence }
}

test("a site whose status receives no release is neither up to date nor behind", async () => {
  const s = await setup()
  await s.release("2.0.0", ["active"])
  const licence = await s.licence("completed")
  await s.check(licence.key, "domain=maple.example&version=1.0.0")
  const versions = await versionsInUse(s.env, s.app.id)
  assert.deepEqual([versions.up_to_date, versions.outdated, versions.no_release, versions.not_reported], [0, 0, 1, 0])
  assert.equal(versions.data[0].no_release, 1)
})

test("every site lands in exactly one state", async () => {
  const s = await setup()
  await s.release("2.0.0", ["active"])
  const licence = await s.licence("active")
  await s.check(licence.key, "domain=a.example&version=2.0.0")
  await s.check(licence.key, "domain=b.example&version=1.0.0")
  await s.check(licence.key, "domain=c.example")
  const versions = await versionsInUse(s.env, s.app.id)
  assert.deepEqual([versions.sites, versions.up_to_date, versions.outdated, versions.no_release, versions.not_reported], [3, 1, 1, 0, 1])
})

test("a site on the beta channel is compared with the release its check offers", async () => {
  const s = await setup()
  await s.release("1.0.0", ["active"])
  await s.release("2.0.0-beta.2", ["active"], "beta")
  const licence = await s.licence("active")
  const answer = await s.check(licence.key, "domain=beta.example&version=2.0.0-beta.1&channel=beta")
  assert.equal(answer.update.available, true)
  assert.equal((await versionsInUse(s.env, s.app.id)).outdated, 1)
  // A check without a version keeps the recorded channel.
  await s.check(licence.key, "domain=beta.example")
  assert.equal((await versionsInUse(s.env, s.app.id)).outdated, 1)
  await s.check(licence.key, "domain=beta.example&version=2.0.0-beta.2&channel=beta")
  const current = await versionsInUse(s.env, s.app.id)
  assert.deepEqual([current.outdated, current.up_to_date], [0, 1])
})

test("a registered site keeps reporting its version while its licence is invalid", async () => {
  const s = await setup()
  await s.release("2.0.0", ["active", "suspended"])
  const licence = await s.licence("active")
  await s.check(licence.key, "domain=a.example&version=1.0.0")
  await s.api("POST", `/licenses/${licence.id}/status`, { tag: "default", status: "suspended" })
  const answer = await s.check(licence.key, "domain=a.example&version=2.0.0")
  assert.equal(answer.valid, false)
  const versions = await versionsInUse(s.env, s.app.id)
  assert.deepEqual(versions.data.map((r) => r.version), ["2.0.0"])
  assert.equal(versions.outdated, 0)
})

test("an invalid check does not record a version for an unregistered site", async () => {
  const s = await setup()
  await s.release("2.0.0", ["active"])
  const licence = await s.licence("suspended")
  await s.check(licence.key, "domain=new.example&version=1.0.0")
  assert.equal((await versionsInUse(s.env, s.app.id)).sites, 0)
})

test("equal versions written differently share one row", async () => {
  const s = await setup()
  await s.release("1.4.0", ["active"])
  const licence = await s.licence("active")
  for (const [domain, version] of [["a.example", "v1.4.0"], ["b.example", "1.4"], ["c.example", "1.4.0"]]) await s.check(licence.key, `domain=${domain}&version=${version}`)
  const versions = await versionsInUse(s.env, s.app.id)
  assert.equal(versions.data.length, 1)
  assert.equal(versions.data[0].sites, 3)
})

test("the activations list returns the version of a single-app licence", async () => {
  const s = await setup()
  await s.release("2.0.0", ["active"])
  const licence = await s.licence("active", { max_sites: 2 })
  await s.check(licence.key, "domain=a.example&version=1.0.0")
  const [site] = (await s.api("GET", `/licenses/${licence.id}/activations`)).data
  assert.equal(site.version, "1.0.0")
  assert.deepEqual(site.versions, { default: "1.0.0" })
})
