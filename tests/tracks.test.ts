import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { makeBucket, makeCtx, makeDb, mockFetch, type Sent } from "./helpers/d1.ts"
import { buildZip } from "./helpers/zip.ts"
import { readKeepReleases, releasesToPrune } from "../app/lib/releases.ts"
import { prefixForTag, statusConflicts, trackForStatus, trackOverlaps } from "../app/lib/tracks.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { createApp, versionsInUse, type App } from "../app/server/apps.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { listFiles, storeFile, updateFile, type FileOwner } from "../app/server/files.server.ts"
import { createLicense, getLicense, setStatus, type LicenseInput } from "../app/server/licenses.server.ts"
import { splitStatements } from "../app/server/migrate.server.ts"
import { handleWebhook, listImports, saveSource } from "../app/server/sources.server.ts"
import { createTrack, deleteTrack, listTracks, updateTrack, type ReleaseTrack } from "../app/server/tracks.server.ts"
import { hmacHex } from "../app/server/util.server.ts"

const ORIGIN = "https://w.dev"
const licenseInput: LicenseInput = { name: "Maple Dental", customer_name: "", customer_email: "", app_id: null, max_sites: null, status: "active", expires_at: null, domains: "", message: "", notes: "" }

function setup() {
  const { bucket } = makeBucket()
  const env = { DB: makeDb().DB, FILES: bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  return { env, ctx, settle }
}

async function newApp(env: Env): Promise<App> {
  const created = await createApp(env, { name: "Harbor Theme", slug: "harbor-theme", description: "", default_duration_days: null, default_status: "active", default_max_sites: null, default_message: "", notes: "" })
  assert.ok("app" in created)
  return created.app
}

async function track(env: Env, owner: FileOwner, name: string, statuses: string): Promise<ReleaseTrack> {
  const made = await createTrack(env, owner, { name, statuses })
  assert.ok("track" in made, JSON.stringify(made))
  return made.track
}

async function release(env: Env, owner: FileOwner, version: string, trackRef?: string) {
  const text = `bytes of ${version} ${trackRef ?? ""}`
  const res = await storeFile(env, owner, { name: `harbor-theme-${version}.zip`, version, track: trackRef, checkDomain: false, size: new TextEncoder().encode(text).length, body: new Response(text).body, contentType: "application/zip" })
  assert.ok("file" in res, JSON.stringify(res))
  return res.file
}

async function checkLatest(env: Env, ctx: ExecutionContext, settle: () => Promise<void>, key: string, version = "0.1.0") {
  const res = await handleCheck(new Request(`${ORIGIN}/check/${key}?domain=maple.example&version=${version}`), env, ctx, key)
  await settle()
  return ((await res.json()) as { update: { latest: { version: string } | null } }).update.latest?.version ?? null
}

test("track helpers: overlaps, conflicts, the track of a status, tag prefixes", () => {
  const updates = { id: "t1", name: "Updates", statuses: "active" }
  const final = { id: "t2", name: "Final", statuses: "completed" }
  assert.deepEqual(trackOverlaps([updates, final], ["active", "suspended"]).map((o) => [o.status, o.track.name]), [["active", "Updates"]])
  assert.deepEqual(trackOverlaps([updates, final], ["active"], "t1"), [])
  assert.deepEqual(statusConflicts([updates, { id: "t3", name: "Old", statuses: "active,suspended" }]).map((c) => [c.status, c.tracks.length]), [["active", 2]])
  assert.equal(trackForStatus("completed", [final], [updates])?.track.name, "Final")
  assert.deepEqual(trackForStatus("active", [], [updates]), { track: updates, inherited: true })
  assert.equal(trackForStatus("suspended", [final], [updates]), null)
  assert.equal(prefixForTag("final-v1.0.0", ["", "final-"]), "final-")
  assert.equal(prefixForTag("v1.4.0", ["", "final-"]), "")
  assert.equal(prefixForTag("v1.4.0", ["final-"]), null)
})

test("each status belongs to one track at most; uploads choose or create a track", async () => {
  const { env } = setup()
  const app = await newApp(env)
  const owner = { app }

  // No track yet: the first release creates "Releases" for the valid statuses.
  const first = await release(env, owner, "1.0.0")
  const [releases] = await listTracks(env, owner)
  assert.deepEqual([releases.name, releases.statuses, first.track_id], ["Releases", "active,completed", releases.id])

  // A status cannot be in two tracks.
  const clash = await createTrack(env, owner, { name: "Final build", statuses: "completed" })
  assert.ok("error" in clash && clash.status === 409 && /Completed already belongs to the track "Releases"/.test(clash.error))
  const updated = await updateTrack(env, owner, releases, { name: "Updates", statuses: "active" })
  assert.ok("track" in updated)
  const final = await track(env, owner, "Final build", "completed")
  assert.ok("error" in (await updateTrack(env, owner, final, { statuses: "active,completed" })))

  // The track's statuses are copied onto its releases.
  assert.equal((await listFiles(env, owner)).find((f) => f.id === first.id)?.statuses, "active")

  // With several tracks, a release must name its track (by id or name).
  const missing = await storeFile(env, owner, { name: "x.zip", version: "2.0.0", size: 1, body: new Response("x").body })
  assert.ok("error" in missing && /has 2 tracks: choose the track/.test(missing.error))
  const named = await release(env, owner, "1.0.0", "final build")
  assert.equal(named.track_id, final.id) // the same version can exist in two tracks

  // Deleting a track with releases needs a track to move them to.
  assert.ok("error" in (await deleteTrack(env, owner, final, null)))
  assert.deepEqual(await deleteTrack(env, owner, final, (updated as { track: ReleaseTrack }).track.id), { ok: true })
  assert.deepEqual((await listFiles(env, owner)).map((f) => [f.version, f.statuses]), [["1.0.0", "active"], ["1.0.0", "active"]])
})

test("a licence is offered the latest release of its status's track, not the highest version overall", async () => {
  const { env, ctx, settle } = setup()
  const app = await newApp(env)
  const owner = { app }
  await track(env, owner, "Updates", "active")
  await track(env, owner, "Final build", "completed")
  await release(env, owner, "1.3.0", "Updates")
  await release(env, owner, "1.4.0", "Updates")
  await release(env, owner, "1.0.0", "Final build") // the licence-free build has its own numbering

  const license = await createLicense(env, { ...licenseInput, app_id: app.id })
  assert.equal(await checkLatest(env, ctx, settle, license.license_key), "1.4.0")
  await setStatus(env, (await getLicense(env, license.id))!, "completed")
  assert.equal(await checkLatest(env, ctx, settle, license.license_key), "1.0.0") // not 1.4.0
  await setStatus(env, (await getLicense(env, license.id))!, "suspended")
  assert.equal(await checkLatest(env, ctx, settle, license.license_key), null) // no track serves Suspended

  // A licence's own track replaces the app's track for the statuses it serves (a custom build for one client).
  const custom = await createLicense(env, { ...licenseInput, name: "Copper Salon", app_id: app.id })
  await track(env, { license: custom }, "Custom build", "active")
  await release(env, { license: custom }, "1.4.0-copper.2")
  assert.equal(await checkLatest(env, ctx, settle, custom.license_key), "1.4.0-copper.2")
  await setStatus(env, (await getLicense(env, custom.id))!, "completed")
  assert.equal(await checkLatest(env, ctx, settle, custom.license_key), "1.0.0") // still the app's Final build

  // Sites are behind only relative to their own licence's track.
  await env.DB.prepare("INSERT INTO activations (license_id, domain, first_seen_at, last_seen_at, check_count, version) VALUES (?, 'a.example', 1, 1, 1, '1.0.0'), (?, 'b.example', 1, 1, 1, '1.4.0-copper.1')")
    .bind(license.id, custom.id)
    .run()
  await setStatus(env, (await getLicense(env, license.id))!, "completed")
  await setStatus(env, (await getLicense(env, custom.id))!, "active")
  const versions = await versionsInUse(env, app.id)
  // maple.example (registered by the checks, version 0.1.0, Completed → 1.0.0) and b.example (custom 1.4.0-copper.1 → copper.2) are behind; a.example (Completed, 1.0.0) is not.
  assert.equal(versions.latest_version, "1.4.0")
  assert.equal(versions.outdated, 3)
  assert.equal(versions.data.find((d) => d.version === "1.0.0")?.behind, 0)
})

test("one repository feeds two tracks, told apart by tag prefix", async () => {
  const { env, ctx, settle } = setup()
  const app = await newApp(env)
  const owner = { app }
  const updates = await track(env, owner, "Updates", "active")
  const final = await track(env, owner, "Final build", "completed")
  const gh = mockFetch((s: Sent) => {
    if (s.url === "https://api.github.com/repos/harbor-studio/harbor-theme") return Response.json({ id: 555, private: false })
    if (s.url.includes("/zipball/")) return new Response(buildZip([["harbor-studio-harbor-theme-abc/style.css", "/* Harbor */"]]))
    return new Response("", { status: 404 })
  })
  const a = await saveSource(env, owner, updates, { repository: "harbor-studio/harbor-theme", connection: "token" })
  const b = await saveSource(env, owner, final, { repository: "harbor-studio/harbor-theme", connection: "token", tag_prefix: "final-", package_folder: "harbor-theme" })
  assert.ok("source" in a && "source" in b)
  // Same repository, same prefix: refused.
  const third = await track(env, owner, "Maintenance", "suspended")
  const clash = await saveSource(env, owner, third, { repository: "harbor-studio/harbor-theme", connection: "token", tag_prefix: "final-" })
  assert.ok("error" in clash && clash.status === 409)
  // Statuses belong to the track, not to the repository.
  assert.ok("error" in (await saveSource(env, owner, third, { repository: "harbor-studio/harbor-theme", connection: "token", tag_prefix: "maint-", statuses: "active" })))

  const deliver = async (sourceId: string, secret: string, tag: string) => {
    const body = JSON.stringify({ ref: `refs/tags/${tag}`, after: "a".repeat(40) })
    const res = await handleWebhook(
      new Request(`${ORIGIN}/hooks/github/${sourceId}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${await hmacHex(secret, body)}` }, body }),
      env,
      ctx,
      "github",
      sourceId
    )
    await settle()
    return res
  }
  const sa = (a as { source: { id: string; webhook_secret: string } }).source
  const sb = (b as { source: { id: string; webhook_secret: string } }).source
  // GitHub sends every push to both webhooks; each track takes only its own tags.
  for (const tag of ["v1.4.0", "final-v1.0.0"]) {
    await deliver(sa.id, sa.webhook_secret, tag)
    await deliver(sb.id, sb.webhook_secret, tag)
  }
  const files = await listFiles(env, owner)
  assert.deepEqual(files.map((f) => [f.version, f.track_id]).sort(), [["1.0.0", final.id], ["1.4.0", updates.id]])
  assert.deepEqual((await listImports(env, sa.id)).map((i) => i.ref), ["v1.4.0"]) // no "skipped" noise for final- tags
  assert.deepEqual((await listImports(env, sb.id)).map((i) => [i.ref, i.version]), [["final-v1.0.0", "1.0.0"]])
  gh.restore()
})

test("migration 0013 puts existing releases and repositories into tracks without changing access", async () => {
  const { DB, raw } = makeDb("0012_github_app.sql")
  const now = Date.now()
  raw.exec(`INSERT INTO apps (id, name, slug, created_at, updated_at) VALUES ('app_a', 'Harbor Theme', 'harbor-theme', ${now}, ${now}), ('app_b', 'Atlas', 'atlas', ${now}, ${now})`)
  const file = (id: string, app: string, version: string, statuses: string, check = 1) =>
    raw.exec(`INSERT INTO files (id, app_id, name, version, statuses, check_domain, size, content_type, r2_key, uploaded_at) VALUES ('${id}', '${app}', '${id}.zip', '${version}', '${statuses}', ${check}, 1, 'application/zip', 'k/${id}', ${now})`)
  file("f1", "app_a", "1.3.0", "active,completed")
  file("f2", "app_a", "1.4.0", "active,completed")
  file("f3", "app_a", "9.0.0", "completed")
  file("f4", "app_a", "", "suspended") // an attachment: no track
  file("f5", "app_b", "3.0.0", "active,completed")
  raw.exec(`INSERT INTO release_sources (id, app_id, provider, repository, package_folder, statuses, check_domain, webhook_secret, created_at, updated_at) VALUES ('src_1', 'app_b', 'github', 'harbor-studio/atlas', 'atlas', 'active', 1, 's', ${now}, ${now})`)

  for (const statement of splitStatements(readFileSync(new URL("../migrations/0013_release_tracks.sql", import.meta.url), "utf8"))) raw.exec(statement)

  const tracks = (await DB.prepare("SELECT app_id, name, statuses FROM release_tracks ORDER BY app_id, position").all<{ app_id: string; name: string; statuses: string }>()).results
  assert.deepEqual(
    tracks.map((t) => [t.app_id, t.name, t.statuses]),
    [
      ["app_a", "Releases for active, completed", "active,completed"],
      ["app_a", "Releases for completed", "completed"],
      ["app_b", "Releases", "active,completed"],
      ["app_b", "From harbor-studio/atlas", "active"],
    ]
  )
  const files = (await DB.prepare("SELECT f.id, f.statuses, t.statuses AS track_statuses FROM files f LEFT JOIN release_tracks t ON t.id = f.track_id ORDER BY f.id").all<{ id: string; statuses: string; track_statuses: string | null }>()).results
  for (const f of files) assert.equal(f.track_statuses, f.id === "f4" ? null : f.statuses, f.id) // every release keeps its exact rule
  const source = await DB.prepare("SELECT t.name FROM release_sources s JOIN release_tracks t ON t.id = s.track_id").first<{ name: string }>()
  assert.equal(source?.name, "From harbor-studio/atlas")
  // The overlap the old data had (Completed in two tracks) is reported, not hidden.
  assert.deepEqual(statusConflicts(tracks.filter((t) => t.app_id === "app_a").map((t, i) => ({ id: String(i), name: t.name, statuses: t.statuses }))).map((c) => c.status), ["completed"])
})

test("API: tracks, conflicts, what a licence receives, uploads into a track", async () => {
  const { env, ctx } = setup()
  const full = (await createApiKey(env, "f", "full")).secret
  const app = await newApp(env)
  const license = await createLicense(env, { ...licenseInput, app_id: app.id })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: { authorization: `Bearer ${full}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
    return { status: res.status, json: (await res.json()) as any }
  }
  assert.equal((await call("POST", "/apps/harbor-theme/tracks", { name: "Updates", statuses: ["active"] })).status, 201)
  assert.equal((await call("POST", "/apps/harbor-theme/tracks", { name: "Final build", statuses: ["completed"] })).status, 201)
  const clash = await call("POST", "/apps/harbor-theme/tracks", { name: "Also active", statuses: ["active"] })
  assert.deepEqual([clash.status, clash.json.error.code], [409, "status_in_another_track"])

  const upload = await handleApi(
    new Request(`${ORIGIN}/api/v1/apps/harbor-theme/files?name=final.zip&version=1.0.0&track=Final%20build`, { method: "PUT", headers: { authorization: `Bearer ${full}`, "content-length": "3" }, body: "zip" }),
    env,
    ctx
  )
  const file = (await upload.json()) as any
  assert.deepEqual([upload.status, file.statuses], [201, ["completed"]])
  assert.ok(file.track)

  const list = await call("GET", "/apps/harbor-theme/tracks")
  assert.deepEqual(list.json.data.map((t: any) => [t.name, t.statuses, t.releases]), [["Updates", ["active"], 0], ["Final build", ["completed"], 1]])
  assert.deepEqual(list.json.conflicts, [])

  const forLicence = await call("GET", `/licenses/${license.id}/tracks`)
  assert.deepEqual([forLicence.json.receives.status, forLicence.json.receives.name, forLicence.json.receives.inherited], ["active", "Updates", true])
  assert.equal(forLicence.json.app_tracks.length, 2)

  const patched = await call("PATCH", "/apps/harbor-theme/tracks/Final%20build", { statuses: ["completed", "suspended"] })
  assert.deepEqual(patched.json.statuses, ["completed", "suspended"])
  assert.deepEqual((await call("GET", "/apps/harbor-theme/files")).json.data[0].statuses, ["completed", "suspended"])
  assert.equal((await call("DELETE", "/apps/harbor-theme/tracks/Final%20build")).status, 409)
  assert.equal((await call("DELETE", "/apps/harbor-theme/tracks/Final%20build?move_to=Updates")).json.deleted, true)
})

test("a version is published once per track: upload, edit and restore refuse a duplicate", async () => {
  const { env } = setup()
  const app = await newApp(env)
  const owner = { app }
  await track(env, owner, "Updates", "active")
  const first = await release(env, owner, "1.4.0", "Updates")
  const text = "other bytes"
  const upload = (version: string) => storeFile(env, owner, { name: "x.zip", version, track: "Updates", checkDomain: false, size: text.length, body: new Response(text).body, contentType: "application/zip" })

  // "v1.4.0" and "1.4.0" are the same version.
  const duplicate = await upload("v1.4.0")
  assert.ok("error" in duplicate && duplicate.status === 409, JSON.stringify(duplicate))
  assert.match(duplicate.error, /already published in the track "Updates"/)

  const second = await upload("1.5.0")
  assert.ok("file" in second)
  const edited = await updateFile(env, owner, second.file, { version: "1.4.0" })
  assert.ok("error" in edited && edited.status === 409)

  // A withdrawn release frees its version, and cannot be restored while another release holds it.
  assert.ok("file" in (await updateFile(env, owner, first, { withdrawn: true })))
  const again = await upload("1.4.0")
  assert.ok("file" in again)
  const withdrawn = (await listFiles(env, owner)).find((f) => f.id === first.id)!
  const restored = await updateFile(env, owner, withdrawn, { withdrawn: false })
  assert.ok("error" in restored && restored.status === 409)
})


test("release limit: the rule keeps the newest N and always the newest stable and beta", () => {
  const f = (id: string, version: string, channel = "stable", withdrawn_at: number | null = null) => ({ id, version, channel, withdrawn_at, uploaded_at: 1 })
  const list = [f("a", "1.0.0"), f("b", "1.1.0"), f("c", "1.10.0"), f("d", "1.2.0"), f("att", "")]
  assert.deepEqual(releasesToPrune(list, null), [])
  assert.deepEqual(releasesToPrune(list, 4), [])
  assert.deepEqual(releasesToPrune(list, 2).map((r) => r.id), ["b", "a"], "numeric order, not text order: 1.10.0 is the newest; oldest are listed last")
  // The newest release is a beta: the newest stable one is still kept, because stable sites are offered it.
  const beta = [f("s1", "1.0.0"), f("s2", "1.1.0"), f("b1", "2.0.0-beta.1", "beta")]
  assert.deepEqual(releasesToPrune(beta, 1).map((r) => r.id), ["s1"])
  assert.deepEqual(releasesToPrune([f("w", "3.0.0", "stable", 5), f("x", "2.0.0"), f("y", "1.0.0")], 1).map((r) => r.id), ["y"], "a withdrawn release counts but is not the one offered")
  assert.deepEqual([readKeepReleases(""), readKeepReleases(null), readKeepReleases("12"), readKeepReleases(3)], [{ keep: null }, { keep: null }, { keep: 12 }, { keep: 3 }])
  for (const bad of [0, -1, 1.5, "abc", 1001, true]) assert.ok("error" in readKeepReleases(bad), String(bad))
})

test("release limit: uploads delete the oldest releases and their files; lowering the limit deletes at once", async () => {
  const { bucket, objects } = makeBucket()
  const env = { DB: makeDb().DB, FILES: bucket } as unknown as Env
  const app = await newApp(env)
  const owner: FileOwner = { app }
  const updates = await createTrack(env, owner, { name: "Updates", statuses: ["active"], keep_releases: 3 })
  assert.ok("track" in updates)
  for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.10.0"]) await release(env, owner, v, "Updates")
  assert.deepEqual((await listFiles(env, owner)).map((f) => f.version).sort(), ["1.10.0", "1.2.0", "1.3.0"])
  assert.equal(objects.size, 3, "the files of the deleted releases are gone from storage")

  // A hotfix with an old version is kept when it is added, even though it is the oldest.
  await release(env, owner, "1.0.1", "Updates")
  assert.ok((await listFiles(env, owner)).some((f) => f.version === "1.0.1"))
  assert.equal((await listFiles(env, owner)).length, 4, "the new release is spared, so the track holds one more than its limit until the next upload")
  await release(env, owner, "1.4.0", "Updates")
  assert.deepEqual((await listFiles(env, owner)).map((f) => f.version).sort(), ["1.10.0", "1.3.0", "1.4.0"], "the next upload brings it back to the limit")

  // Attachments and other tracks are untouched.
  const manual = await storeFile(env, owner, { name: "manual.pdf", size: 3, body: new Response("pdf").body })
  assert.ok("file" in manual)
  const other = await createTrack(env, owner, { name: "Final build", statuses: ["completed"] })
  assert.ok("track" in other)
  for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) await release(env, owner, v, "Final build")
  const final = (await listFiles(env, owner)).filter((f) => f.track_id === other.track.id)
  assert.equal(final.length, 4)

  const lowered = await updateTrack(env, owner, (await listTracks(env, owner)).find((t) => t.name === "Updates")!, { keep_releases: 1 })
  assert.ok("track" in lowered)
  assert.equal(lowered.pruned, 2)
  const left = (await listFiles(env, owner)).filter((f) => f.track_id === lowered.track.id).map((f) => f.version)
  assert.deepEqual(left, ["1.10.0"])
  assert.equal((await listFiles(env, owner)).some((f) => f.name === "manual.pdf"), true)

  const cleared = await updateTrack(env, owner, lowered.track, { keep_releases: null })
  assert.ok("track" in cleared)
  assert.equal(cleared.track.keep_releases, null)
  assert.equal(cleared.pruned, 0)
  const invalid = await updateTrack(env, owner, cleared.track, { keep_releases: 0 })
  assert.deepEqual([("error" in invalid) && invalid.status], [422])
})

test("release limit: the API sets it, returns it and reports how many releases were deleted", async () => {
  const { env, ctx } = setup()
  const full = (await createApiKey(env, "f", "full")).secret
  const app = await newApp(env)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers: { authorization: `Bearer ${full}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx)
    return { status: res.status, json: (await res.json()) as any }
  }
  const created = await call("POST", "/apps/harbor-theme/tracks", { name: "Updates", statuses: ["active"] })
  assert.equal(created.json.keep_releases, null)
  for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) await release(env, { app }, v, "Updates")
  const patched = await call("PATCH", "/apps/harbor-theme/tracks/Updates", { keep_releases: 2 })
  assert.deepEqual([patched.status, patched.json.keep_releases, patched.json.pruned, patched.json.releases], [200, 2, 2, 2])
  const bad = await call("PATCH", "/apps/harbor-theme/tracks/Updates", { keep_releases: 0 })
  assert.deepEqual([bad.status, bad.json.error.code], [422, "invalid_track"])
  assert.equal((await call("GET", "/apps/harbor-theme/tracks/Updates")).json.keep_releases, 2)
})
