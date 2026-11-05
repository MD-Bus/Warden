import { TAG_PATTERN, validTag } from "../app/lib/entitlements.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPublicKey, verify } from "node:crypto"
import { makeDb, makeBucket, makeCtx } from "./helpers/d1.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { handleDownload } from "../app/server/download.server.ts"
import { getSigningKey, resetSigningKeyCache } from "../app/server/signing.server.ts"
import { createApp, listApps, versionsInUse } from "../app/server/apps.server.ts"
import { attentionLists, createLicense, getLicense, scanLicenseEvents, overviewStats, queryLicenses } from "../app/server/licenses.server.ts"
import { storeFile, listFilesForLicense } from "../app/server/files.server.ts"
import { createTrack } from "../app/server/tracks.server.ts"
import { saveBundle, listAttachments, attachmentContext } from "../app/server/entitlements.server.ts"
import { splitStatements } from "../app/server/migrate.server.ts"
import { trafficReport } from "../app/server/analytics.server.ts"
import { createWebhook } from "../app/server/webhooks.server.ts"
import { clearProtectionCache } from "../app/server/protection.server.ts"

const origin = "https://warden.example",
  DAY = 86400000
async function setup() {
  resetSigningKeyCache()
  clearProtectionCache()
  const db = makeDb(),
    bucket = makeBucket(),
    env = { DB: db.DB, FILES: bucket.bucket } as unknown as Env,
    { ctx, settle } = makeCtx()
  const key = (await createApiKey(env, "Tests", "full")).secret
  async function api(method: string, path: string, body?: unknown, scopeKey = key) {
    const res = await handleApi(
      new Request(`${origin}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${scopeKey}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    )
    await settle()
    return { status: res.status, headers: res.headers, json: (await res.json()) as any }
  }
  const parent = (await api("POST", "/apps", { name: "Harbor Theme", slug: "harbor-theme" })).json
  const child = (await api("POST", "/apps", { name: "Harbor Studio Child", slug: "harbor-studio-child" })).json
  async function check(key: string, query = "", body?: unknown) {
    const res = await handleCheck(new Request(`${origin}/check/${key}${query ? `?${query}` : ""}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }), env, ctx, key)
    await settle()
    const text = await res.text()
    return { status: res.status, json: JSON.parse(text), text, headers: res.headers }
  }
  async function download(key: string, id: string | null, query = "") {
    const res = await handleDownload(new Request(`${origin}/download/${key}${id ? `/${id}` : ""}?${query}`), env, ctx, key, id)
    await settle()
    return res
  }
  async function licence(extra: Record<string, unknown> = {}) {
    const res = await api("POST", "/licenses", {
      name: "Harbor Studio website",
      expiry_mode: "separate",
      max_sites: 1,
      apps: [
        { tag: "parent-theme", app: parent.id, status: "active" },
        { tag: "child-theme", app: child.id, status: "completed" },
      ],
      ...extra,
    })
    assert.equal(res.status, 201, JSON.stringify(res.json))
    return res.json
  }
  return { env, db, bucket, ctx, settle, key, api, parent, child, check, download, licence }
}

test("one key checks each tag independently, signs the selected app, and records separate versions in one site slot", async () => {
  const s = await setup(),
    l = await s.licence()
  const p = await s.check(l.key, "tag=parent-theme&domain=harborstudio.com&version=2.1.0&nonce=test_nonce")
  assert.equal(p.json.valid, true)
  assert.equal(p.json.app.id, s.parent.id)
  assert.equal(p.json.tag, "parent-theme")
  const signing = await getSigningKey(s.env)
  assert.ok(verify(null, Buffer.from(p.text), createPublicKey(signing.publicKeyPem), Buffer.from(p.headers.get("x-warden-signature-ed25519")!, "base64")))
  const c = await s.check(l.key, "tag=child-theme&domain=harborstudio.com&version=1.0.0")
  assert.equal(c.json.status, "completed")
  assert.equal((await s.check(l.key, "tag=parent-theme&domain=other.example")).json.status, "site_limit_reached")
  assert.equal((await s.check(l.key, "tag=missing")).status, 404)
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM activations").get() as any).n, 1)
  const versions = s.db.raw.prepare("SELECT e.tag,v.version FROM activation_versions v JOIN license_apps e ON e.id=v.attachment_id ORDER BY e.tag").all()
  assert.deepEqual(
    versions.map((v) => [v.tag, v.version]),
    [
      ["child-theme", "1.0.0"],
      ["parent-theme", "2.1.0"],
    ],
  )
  const all = await s.check(l.key, "domain=harborstudio.com")
  assert.equal(all.json.valid, undefined)
  assert.deepEqual(
    all.json.apps.map((a: any) => a.tag),
    ["parent-theme", "child-theme"],
  )
  const stats = await listApps(s.env)
  assert.equal(stats.find((a) => a.id === s.child.id)?.licenses, 1)
  assert.equal((await versionsInUse(s.env, s.child.id)).data[0].version, "1.0.0")
})

test("release selection and direct downloads stay inside the requested tag", async () => {
  const s = await setup(),
    l = await s.licence(),
    releases = []
  for (const [app, version] of [
    [s.parent, "9.0.0"],
    [s.child, "1.2.0"],
  ] as const) {
    const made = await storeFile(s.env, { app }, { name: `${app.slug}.zip`, version, size: 3, body: new Response("zip").body })
    assert.ok("file" in made)
    releases.push(made.file)
  }
  assert.equal((await s.check(l.key, "tag=child-theme&domain=harborstudio.com&version=1.0.0")).json.update.latest.version, "1.2.0")
  assert.equal((await s.download(l.key, releases[0].id, "tag=child-theme&domain=harborstudio.com")).status, 404)
  assert.equal((await s.download(l.key, releases[1].id, "tag=child-theme&domain=harborstudio.com")).status, 200)
  const list = (await (await s.download(l.key, null, "domain=harborstudio.com")).json()) as any
  assert.equal(list.latest, undefined)
  assert.equal(list.apps.length, 2)
  await s.api("POST", `/licenses/${l.id}/status`, { tag: "child-theme", status: "suspended" })
  assert.equal((await s.check(l.key, "tag=parent-theme&domain=harborstudio.com")).json.valid, true)
  assert.equal((await s.download(l.key, releases[1].id, "tag=child-theme&domain=harborstudio.com")).status, 403)
})

test("shared expiry, independent expiry, Completed, grace and explicit mode conversion", async () => {
  const s = await setup(),
    past = new Date(Date.now() - DAY).toISOString(),
    future = new Date(Date.now() + DAY).toISOString()
  const l = await s.licence({ expiry_mode: "shared", expires_at: past })
  let all = await s.check(l.key, "domain=harborstudio.com")
  assert.deepEqual(
    all.json.apps.map((a: any) => a.status),
    ["expired", "completed"],
  )
  assert.equal((await s.api("POST", `/licenses/${l.id}/renew`, { tag: "parent-theme", days: 30 })).status, 422)
  assert.equal((await s.api("POST", `/licenses/${l.id}/renew`, { days: 30 })).status, 200)
  const separate = await s.api("PATCH", `/licenses/${l.id}`, { expiry_mode: "separate" })
  assert.equal(separate.json.apps[0].expires_at, separate.json.apps[1].expires_at)
  assert.equal((await s.api("POST", `/licenses/${l.id}/renew`, { days: 30 })).json.error.code, "tag_required")
  const before = separate.json.apps[1].expires_at
  const renewed = await s.api("POST", `/licenses/${l.id}/renew`, { tag: "parent-theme", days: 30 })
  assert.equal(renewed.json.apps[1].expires_at, before)
  assert.notEqual(renewed.json.apps[0].expires_at, before)
  assert.equal((await s.api("PATCH", `/licenses/${l.id}`, { expiry_mode: "shared" })).status, 422)
  assert.equal((await s.api("PATCH", `/licenses/${l.id}`, { expiry_mode: "shared", expires_at: null })).json.expires_at, null)
  await s.api("PATCH", `/licenses/${l.id}`, { expires_at: past, grace_days: 3 })
  all = await s.check(l.key, "domain=harborstudio.com")
  assert.equal(all.json.apps[0].valid, true)
  assert.ok(all.json.apps[0].grace_ends_at)
  assert.equal(all.json.apps[1].grace_ends_at, null)
  const mixed = await s.licence({
    apps: [
      { tag: "parent-theme", app: s.parent.id, expires_at: past },
      { tag: "child-theme", app: s.child.id, expires_at: future },
    ],
  })
  assert.deepEqual(
    mixed.apps.map((a: any) => a.valid),
    [false, true],
  )
})

test("templates prefill tags, validate app defaults and required slots, and do not mutate existing licences", async () => {
  const s = await setup()
  const t = await s.api("POST", "/license-templates", {
    name: "WordPress website",
    expiry_mode: "separate",
    slots: [
      { tag: "parent-theme", app: s.parent.id },
      { tag: "child-theme", required: true },
      { tag: "booking", required: false },
    ],
  })
  assert.equal(t.status, 201)
  assert.equal((await s.api("POST", "/licenses", { name: "Missing child", template: t.json.id })).status, 422)
  const made = await s.api("POST", "/licenses", { name: "From template", template: t.json.id, apps: [{ tag: "parent-theme" }, { tag: "child-theme", app: s.child.id }] })
  assert.equal(made.status, 201, JSON.stringify(made.json))
  assert.equal(made.json.expiry_mode, "separate")
  await s.api("PATCH", `/license-templates/${t.json.id}`, { slots: [{ tag: "new-tag", app: s.parent.id }] })
  assert.deepEqual(
    (await s.api("GET", `/licenses/${made.json.id}`)).json.apps.map((e: any) => e.tag),
    ["parent-theme", "child-theme"],
  )
  assert.equal((await s.api("DELETE", `/apps/${s.parent.id}`)).status, 409)
  assert.equal((await s.api("POST", "/license-templates", { name: "Duplicate tags", slots: [{ tag: "theme" }, { tag: "theme" }] })).status, 422)
  const read = (await createApiKey(s.env, "Read", "read")).secret
  assert.equal((await s.api("POST", "/license-templates", {}, read)).status, 403)
})

test("invalid updates are atomic, tags are unique, idempotent create returns the same key, deletion leaves apps and releases", async () => {
  const s = await setup(),
    l = await s.licence({ external_ref: "order-1042" })
  const retry = await s.api("POST", "/licenses", { apps: [], external_ref: "order-1042" })
  assert.equal(retry.status, 200)
  assert.equal(retry.json.key, l.key)
  assert.equal(
    (
      await s.api("PATCH", `/licenses/${l.id}`, {
        name: "Changed",
        apps: [
          { tag: "parent-theme", app: s.parent.id },
          { tag: "parent-theme", app: s.child.id },
        ],
      })
    ).status,
    422,
  )
  assert.equal((await s.api("GET", `/licenses/${l.id}`)).json.name, l.name)
  const subset = await s.api("PATCH", `/licenses/${l.id}`, { apps: [{ tag: "child-theme", app: s.child.id, status: "completed" }] })
  assert.equal(subset.json.apps.length, 1)
  assert.equal((await s.check(l.key, "tag=parent-theme")).status, 404)
  const release = await storeFile(s.env, { app: s.child }, { name: "child.zip", version: "1.0.0", size: 1, body: new Response("x").body })
  assert.ok("file" in release)
  await s.api("DELETE", `/licenses/${l.id}`)
  assert.equal(s.bucket.objects.size, 1)
  assert.equal((await s.api("GET", `/apps/${s.child.id}`)).status, 200)
})

test("analytics, status changes and expiry events retain the app and tag context", async () => {
  const s = await setup(),
    l = await s.licence({
      apps: [
        { tag: "parent-theme", app: s.parent.id, expires_at: new Date(Date.now() - DAY).toISOString() },
        { tag: "child-theme", app: s.child.id, status: "completed" },
      ],
    })
  await s.check(l.key, "domain=harborstudio.com")
  assert.equal((await trafficReport(s.env, { app: s.child.id }, 7)).totals.valid, 1)
  assert.equal((await trafficReport(s.env, { app: s.parent.id }, 7)).totals.invalid, 1)
  assert.equal((await queryLicenses(s.env, { appId: s.child.id, limit: 10 })).length, 1)
  assert.equal((await overviewStats(s.env)).invalid, 1)
  await createWebhook(s.env, { url: "https://events.example/warden", description: "", events: ["license.expired"], enabled: true })
  assert.equal(await scanLicenseEvents(s.env), 1)
  assert.equal(await scanLicenseEvents(s.env), 0)
  const delivery = s.db.raw.prepare("SELECT payload FROM webhook_deliveries WHERE event='license.expired'").get() as any
  const data = JSON.parse(delivery.payload).data
  assert.equal(data.tag, "parent-theme")
  assert.equal(data.license.apps.length, 2)
  await s.api("POST", `/apps/${s.child.id}/statuses/customize`)
  const removed = await s.api("DELETE", `/apps/${s.child.id}/statuses/completed?move_to=active`)
  assert.equal(removed.status, 200)
  assert.equal((await s.api("GET", `/licenses/${l.id}`)).json.apps[1].stored_status, "active")
})

test("migration preserves keys, checksums, file ids, downloads, overrides, base release inheritance and activation versions", async () => {
  resetSigningKeyCache()
  clearProtectionCache()
  const db = makeDb("0015_import_progress.sql"),
    env = { DB: db.DB, FILES: makeBucket().bucket } as unknown as Env
  // The data is seeded with the current code, which writes the release limit added by 0017 (independent of 0016).
  db.raw.exec("ALTER TABLE release_tracks ADD COLUMN keep_releases INTEGER")
  const result = await createApp(env, {
    name: "Harbor Theme",
    slug: "harbor-theme",
    description: "",
    default_status: "active",
    default_duration_days: null,
    default_max_sites: null,
    default_message: "",
    notes: "",
  })
  assert.ok("app" in result)
  const app = result.app
  const standalone = await createLicense(env, {
    name: "Harbor Studio Child",
    customer_name: "Harbor Studio",
    customer_email: "",
    app_id: null,
    max_sites: 1,
    status: "active",
    expires_at: null,
    domains: "harborstudio.com",
    message: "",
    notes: "",
  })
  const custom = await createLicense(env, { ...standalone, name: "Custom parent", app_id: app.id, max_sites: 1 })
  const normal = await createLicense(env, { ...standalone, name: "Normal parent", app_id: app.id, max_sites: 1 })
  const regular = await storeFile(env, { app }, { name: "parent.zip", version: "2.0.0", statuses: ["active"], size: 1, body: new Response("p").body })
  assert.ok("file" in regular)
  const final = await storeFile(env, { app }, { name: "final.zip", version: "1.0.0", statuses: ["completed"], size: 1, body: new Response("f").body })
  assert.ok("file" in final)
  const own = await storeFile(env, { license: custom }, { name: "custom.zip", version: "1.5.0", statuses: ["active"], size: 1, body: new Response("c").body })
  assert.ok("file" in own)
  const standaloneFile = await storeFile(env, { license: standalone }, { name: "child.zip", version: "1.0.0", size: 1, body: new Response("s").body })
  assert.ok("file" in standaloneFile)
  db.raw.prepare("INSERT INTO activations (license_id,domain,first_seen_at,last_seen_at,version) VALUES (?,?,?,?,?)").run(custom.id, "harborstudio.com", 1, 2, "1.4.0")
  const originalSigning = await getSigningKey(env)
  db.raw
    .prepare(
      "INSERT INTO release_sources (id,license_id,provider,repository,trigger,package_folder,statuses,webhook_secret,created_at,updated_at,track_id) VALUES ('src_migrated',?,'github','harbor-studio/child','tag','harbor-child','active','test-webhook',1,1,?)",
    )
    .run(custom.id, own.file.track_id)
  db.raw
    .prepare(
      "INSERT INTO source_imports (id,source_id,ref,state,started_at,stage,package_key,upload_id,parts,archive_size) VALUES ('imp_migrated','src_migrated','v1.6.0','pending',1,'repack','original/package.zip','upload-in-progress','[]',1024)",
    )
    .run()
  const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0016_license_apps.sql"), "utf8")
  for (const statement of splitStatements(sql)) db.raw.exec(statement)
  assert.equal(db.raw.prepare("PRAGMA foreign_key_check").all().length, 0)
  resetSigningKeyCache()
  assert.equal((await getSigningKey(env)).publicKey, originalSigning.publicKey)
  const source = db.raw.prepare("SELECT app_id,license_id FROM release_sources WHERE id='src_migrated'").get() as any
  assert.ok(source.app_id)
  assert.equal(source.license_id, null)
  const pending = db.raw.prepare("SELECT package_key,upload_id,stage FROM source_imports WHERE id='imp_migrated'").get() as any
  assert.deepEqual([pending.package_key, pending.upload_id, pending.stage], ["original/package.zip", "upload-in-progress", "repack"])
  for (const before of [standalone, custom, normal]) {
    const after = (await getLicense(env, before.id))!
    assert.equal(after.license_key, before.license_key)
    assert.equal(after.expiry_mode, "shared")
    assert.ok(after.app_id)
    assert.equal((await listAttachments(env, before.id)).length, 1)
  }
  const after = (await getLicense(env, custom.id))!,
    e = (await listAttachments(env, custom.id))[0],
    c = attachmentContext(after, e)
  const files = await listFilesForLicense(env, c)
  assert.equal(files.find((f) => f.id === regular.file.id)?.statuses, "")
  assert.equal(files.find((f) => f.id === final.file.id)?.statuses, "completed")
  assert.equal(files.find((f) => f.id === own.file.id)?.sha256, own.file.sha256)
  assert.equal((db.raw.prepare("SELECT version FROM activation_versions WHERE attachment_id=?").get(e.id) as any).version, "1.4.0")
  const { ctx, settle } = makeCtx()
  const check = await handleCheck(new Request(`${origin}/check/${custom.license_key}?domain=harborstudio.com&version=1.4.0`), env, ctx, custom.license_key)
  assert.equal(((await check.json()) as any).update.latest.id, own.file.id)
  await settle()
  const download = await handleDownload(
    new Request(`${origin}/download/${standalone.license_key}/${standaloneFile.file.id}?domain=harborstudio.com`),
    env,
    ctx,
    standalone.license_key,
    standaloneFile.file.id,
  )
  assert.equal(download.status, 200)
  await settle()
})

test("the same app under two tags requires an explicit download tag and rejects ambiguous version checks without registering a site", async () => {
  const s = await setup(),
    l = await s.licence({
      apps: [
        { tag: "production", app: s.parent.id, status: "suspended" },
        { tag: "staging", app: s.parent.id, status: "active" },
      ],
    })
  const stored = await storeFile(s.env, { app: s.parent }, { name: "parent.zip", version: "1.0.0", size: 1, body: new Response("x").body })
  assert.ok("file" in stored)
  assert.equal((await s.check(l.key, "domain=harborstudio.com&version=1.0.0")).status, 422)
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM activations").get() as any).n, 0)
  assert.equal((await s.download(l.key, stored.file.id, "domain=harborstudio.com")).status, 422)
  assert.equal((await s.download(l.key, stored.file.id, "tag=production&domain=harborstudio.com")).status, 403)
  assert.equal((await s.download(l.key, stored.file.id, "tag=staging&domain=harborstudio.com")).status, 200)
  const versioned = await s.check(l.key, "", { domain: "harborstudio.com", versions: { production: "0.1.0", staging: "0.5.0" } })
  assert.equal(versioned.json.apps[1].update.latest.version, "1.0.0")
  assert.equal((await s.api("GET", `/licenses/${l.id}/activations`)).json.data[0].versions.staging, "0.5.0")
  assert.equal((await s.api("POST", `/licenses/${l.id}/status`, { tag: "staging" })).status, 422)
  assert.equal((await s.api("PATCH", `/licenses/${l.id}`, { apps: null })).status, 422)
})

test("failed API app selection leaves the existing licence unchanged and preserves per-app settings on a partial edit", async () => {
  const s = await setup(),
    l = await s.licence()
  await s.check(l.key, "tag=child-theme&domain=harborstudio.com&version=1.0.0")
  const before = (await s.api("GET", `/licenses/${l.id}`)).json
  const failed = await s.api("PATCH", `/licenses/${l.id}`, {
    name: "Changed",
    apps: [
      { tag: "parent-theme", app: s.parent.id },
      { tag: "child-theme", app: "missing-app" },
    ],
  })
  assert.equal(failed.status, 422)
  assert.equal((await s.api("GET", `/licenses/${l.id}`)).json.name, before.name)
  assert.equal((await s.api("PATCH", `/licenses/${l.id}`, { notes: "Updated notes" })).json.apps[1].stored_status, "completed")
  assert.equal((await queryLicenses(s.env, { q: "child-theme", limit: 10 })).length, 1)
  await s.api("DELETE", `/licenses/${l.id}/activations/harborstudio.com`)
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM activation_versions").get() as any).n, 0)
})

test("tag input patterns compile in browser Unicode sets mode and agree with server validation", () => {
  const browser = new RegExp(TAG_PATTERN.source, "v")
  const valid = ["parent-theme", "child_theme", "a", "a0", "a".repeat(48)]
  const invalid = ["", "Parent-theme", "0theme", "-theme", "theme name", "theme/theme", "theme|theme", "theme\\theme", "a".repeat(49), "parent-theme\n"]
  for (const tag of valid) {
    assert.equal(browser.test(tag), true, tag)
    assert.equal(validTag(tag), true, tag)
  }
  for (const tag of invalid) {
    assert.equal(browser.test(tag), false, JSON.stringify(tag))
    assert.equal(validTag(tag), false, JSON.stringify(tag))
  }
})

test("a check without a tag registers the domain once, records every app in one request and keeps the shared site limit", async () => {
  const s = await setup(),
    l = await s.licence()
  const first = await s.check(l.key, "", { domain: "harborstudio.com", versions: { "parent-theme": "2.0.0", "child-theme": "1.1.0" } })
  assert.deepEqual(
    first.json.apps.map((a: any) => [a.tag, a.valid]),
    [
      ["parent-theme", true],
      ["child-theme", true],
    ],
  )
  // One request is one check for the site, whatever the number of attached apps.
  const site = s.db.raw.prepare("SELECT domain, check_count FROM activations").all() as any[]
  assert.deepEqual(
    site.map((r) => [r.domain, r.check_count]),
    [["harborstudio.com", 1]],
  )
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM activity WHERE event = 'check'").get() as any).n, 2)
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM activation_versions").get() as any).n, 2)
  const other = await s.check(l.key, "domain=other.example")
  assert.deepEqual(
    other.json.apps.map((a: any) => a.status),
    ["site_limit_reached", "site_limit_reached"],
  )
  assert.equal((s.db.raw.prepare("SELECT COUNT(*) AS n FROM activations").get() as any).n, 1)
})

test("the attention list reports the apps that expired, per tag, and skips apps made invalid by decision", async () => {
  const s = await setup()
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const future = new Date(Date.now() + 200 * 86_400_000).toISOString()
  const create = async (body: Record<string, unknown>) => {
    const res = await s.api("POST", "/licenses", body)
    assert.equal(res.status, 201, JSON.stringify(res.json))
    return res.json.id as string
  }
  const shared = await create({ name: "Shared", expiry_mode: "shared", expires_at: past, apps: [{ tag: "site", app: s.parent.id, status: "active" }] })
  const separate = await create({ name: "Separate", expiry_mode: "separate", apps: [{ tag: "parent-theme", app: s.parent.id, status: "active", expires_at: past }, { tag: "child-theme", app: s.child.id, status: "active", expires_at: future }] })
  await create({ name: "Suspended", expiry_mode: "shared", expires_at: past, apps: [{ tag: "site", app: s.parent.id, status: "suspended" }] })
  await create({ name: "Separate, suspended", expiry_mode: "separate", apps: [{ tag: "site", app: s.parent.id, status: "suspended", expires_at: past }] })

  const { lapsed } = await attentionLists(s.env)
  assert.deepEqual(lapsed.map((l) => [l.id, l.lapsed_tags]).sort(), [[shared, ["site"]], [separate, ["parent-theme"]]].sort())
})
