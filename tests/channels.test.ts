import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeBucket, makeCtx, makeDb, mockFetch, type Sent } from "./helpers/d1.ts"
import { acceptedChannels, channelKeyFromName, DEFAULT_CHANNELS, parseChannelDefinitions, readRequestedChannel, readTrackChannels } from "../app/lib/channels.ts"
import { splitStatements } from "../app/server/migrate.server.ts"
import { createApp } from "../app/server/apps.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { listFiles, storeFile, updateFile } from "../app/server/files.server.ts"
import { createLicense, type LicenseInput } from "../app/server/licenses.server.ts"
import { channelForImport, handleWebhook, saveSource } from "../app/server/sources.server.ts"
import { createTrack, getTrack, updateTrack, type ReleaseTrack } from "../app/server/tracks.server.ts"
import { hmacHex } from "../app/server/util.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"
import { buildZip } from "./helpers/zip.ts"

const ORIGIN = "https://w.dev"
const licenseInput: LicenseInput = { name: "Harbor", customer_name: "", customer_email: "", app_id: null, max_sites: null, status: "active", expires_at: null, domains: "", message: "", notes: "" }
const NIGHTLY = { name: "Nightly", includes: ["stable", "beta"] }

async function setup() {
  const { bucket } = makeBucket()
  const env = { DB: makeDb().DB, FILES: bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  const created = await createApp(env, { name: "Harbor Theme", slug: "harbor-theme", description: "", default_duration_days: null, default_status: "active", default_max_sites: null, default_message: "", notes: "" })
  assert.ok("app" in created)
  const app = created.app
  const owner = { app }
  const made = await createTrack(env, owner, { name: "Updates", statuses: "active,completed" })
  assert.ok("track" in made)
  const license = await createLicense(env, { ...licenseInput, app_id: app.id })
  const upload = (version: string, channel?: string) => storeFile(env, owner, { name: `harbor-theme-${version}.zip`, version, channel, track: made.track.id, checkDomain: false, size: 1, body: new Response("x").body })
  const offered = async (channel?: string) => {
    const res = await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}?domain=harborstudio.com&version=1.0.0${channel ? `&channel=${channel}` : ""}`), env, ctx, license.license_key)
    await settle()
    return ((await res.json()) as any).update.latest?.version ?? null
  }
  return { env, ctx, settle, app, owner, track: made.track, license, upload, offered }
}

test("channel rules: stable is required, first and includes nothing; keys come from names; unknown channels mean stable", () => {
  assert.equal(channelKeyFromName("Release candidate"), "release-candidate")
  assert.equal(channelKeyFromName("!!"), "")
  assert.equal(readRequestedChannel(" Beta "), "beta")
  assert.equal(readRequestedChannel("not a channel!"), "stable")
  assert.equal(readRequestedChannel(undefined), "stable")

  const ok = parseChannelDefinitions([{ name: "Beta", key: "beta", includes: ["stable"] }, { key: "stable", name: "Stable" }, NIGHTLY])
  assert.ok("channels" in ok)
  assert.deepEqual(ok.channels.map((c) => c.key), ["stable", "beta", "nightly"], "Stable is put first.")
  assert.ok("error" in parseChannelDefinitions([{ key: "beta", name: "Beta" }]), "Stable cannot be removed.")
  assert.ok("error" in parseChannelDefinitions([{ key: "stable", name: "Stable", includes: ["beta"] }, { key: "beta", name: "Beta" }]), "Stable includes nothing.")
  assert.ok("error" in parseChannelDefinitions([{ key: "stable", name: "Stable" }, { key: "beta", name: "Beta", includes: ["gone"] }]))
  assert.ok("error" in parseChannelDefinitions([{ key: "stable", name: "Stable" }, { key: "beta", name: "Beta", includes: ["beta"] }]))

  assert.deepEqual(readTrackChannels(null), DEFAULT_CHANNELS, "A track from before channels has stable and beta.")
  assert.deepEqual(acceptedChannels(DEFAULT_CHANNELS, "beta"), ["beta", "stable"])
  assert.deepEqual(acceptedChannels(DEFAULT_CHANNELS, "stable"), ["stable"])
  assert.deepEqual(acceptedChannels(DEFAULT_CHANNELS, "nightly"), ["stable"], "A channel the track does not have gives stable, as before.")
})

test("existing sites: no channel gets stable, beta gets the newest of both, an unknown channel gets stable", async () => {
  const { upload, offered } = await setup()
  assert.ok("file" in (await upload("1.4.0")))
  assert.ok("file" in (await upload("1.5.0-beta.1", "beta")))
  assert.equal(await offered(), "1.4.0")
  assert.equal(await offered("stable"), "1.4.0")
  assert.equal(await offered("beta"), "1.5.0-beta.1")
  assert.equal(await offered("nightly"), "1.4.0")
})

test("a channel the track defines: its sites get its releases and those it includes; other sites are unaffected", async () => {
  const { env, owner, track, upload, offered } = await setup()
  const refused = await upload("1.6.0-dev.1", "nightly")
  assert.ok("error" in refused && refused.status === 422, "A channel the track does not have is refused.")

  const edited = await updateTrack(env, owner, track, { channels: [...DEFAULT_CHANNELS, NIGHTLY] })
  assert.ok("track" in edited, JSON.stringify(edited))
  assert.ok("file" in (await upload("1.4.0")))
  assert.ok("file" in (await upload("1.5.0-beta.1", "beta")))
  const nightly = await upload("1.6.0-dev.1", "nightly")
  assert.ok("file" in nightly, JSON.stringify(nightly))

  assert.equal(await offered(), "1.4.0")
  assert.equal(await offered("beta"), "1.5.0-beta.1")
  assert.equal(await offered("nightly"), "1.6.0-dev.1")

  // A channel with releases cannot be removed; once its release moves, it can.
  const blocked = await updateTrack(env, owner, edited.track, { channels: DEFAULT_CHANNELS })
  assert.ok("error" in blocked && blocked.status === 409)
  const moved = await updateFile(env, owner, nightly.file, { channel: "beta" })
  assert.ok("file" in moved)
  const removed = await updateTrack(env, owner, edited.track, { channels: DEFAULT_CHANNELS })
  assert.ok("track" in removed, JSON.stringify(removed))
  assert.equal(await offered("nightly"), "1.4.0", "Sites on a removed channel fall back to stable.")
})

test("a release moved to a track without its channel becomes stable", async () => {
  const { env, owner, track, upload } = await setup()
  await updateTrack(env, owner, track, { channels: [...DEFAULT_CHANNELS, NIGHTLY] })
  const nightly = await upload("1.6.0-dev.1", "nightly")
  assert.ok("file" in nightly)
  const other = await createTrack(env, owner, { name: "Final build", statuses: "suspended" })
  assert.ok("track" in other)
  const moved = await updateFile(env, owner, nightly.file, { track: other.track.id })
  assert.ok("file" in moved, JSON.stringify(moved))
  assert.equal(moved.file.channel, "stable")
})

const SHA_MAIN = "a".repeat(40)
const SHA_BETA = "b".repeat(40)
const SHA_OTHER = "c".repeat(40)

/**
 * GitHub stand-in: SHA_MAIN is on main and on beta (merged), SHA_BETA only on beta, SHA_OTHER on neither. Tags are
 * annotated: the SHA in a push event is the tag object's, which compare answers 404 for, as GitHub does.
 */
const TAG_OBJECT = "f".repeat(40)
function github() {
  const on: Record<string, string[]> = { main: [SHA_MAIN], beta: [SHA_MAIN, SHA_BETA] }
  const tags: Record<string, string> = { "v1.5.0-beta.1": SHA_BETA, "v1.5.0": SHA_MAIN, "v9.0.0": SHA_OTHER }
  return mockFetch((s: Sent) => {
    const base = "https://api.github.com/repos/harbor-studio/harbor-theme"
    if (s.url === base) return Response.json({ private: false, id: 7 })
    const compare = s.url.match(/\/compare\/([^.]+)\.\.\.(.+)$/)
    if (s.url.startsWith(`${base}/compare/`) && compare) {
      const branch = decodeURIComponent(compare[1]).replace(/^refs\/heads\//, "")
      const head = decodeURIComponent(compare[2])
      const commit = head.startsWith("refs/tags/") ? tags[head.slice("refs/tags/".length)] : /^[0-9a-f]{40}$/.test(head) && head !== TAG_OBJECT ? head : undefined
      if (!on[branch] || !commit) return new Response("not found", { status: 404 })
      return Response.json({ status: on[branch].includes(commit) ? "behind" : "diverged" })
    }
    if (s.url.startsWith(`${base}/zipball/`)) return new Response(buildZip([["harbor-studio-harbor-theme-1/style.css", "/* Harbor */"]]))
    return new Response("not found", { status: 404 })
  })
}

async function deliver(env: Env, ctx: ExecutionContext, source: { id: string; webhook_secret: string }, payload: unknown) {
  const body = JSON.stringify(payload)
  const request = new Request(`${ORIGIN}/hooks/github/${source.id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": `sha256=${await hmacHex(source.webhook_secret, body)}` },
    body,
  })
  const res = await handleWebhook(request, env, ctx, "github", source.id)
  return (await res.json()) as any
}

test("two channels follow two branches of one repository: a tag publishes on the channel whose branch has it", async () => {
  const { env, ctx, settle, owner, track } = await setup()
  const gh = github()
  const stable = await saveSource(env, owner, track, { repository: "harbor-studio/harbor-theme", connection: "token", branch: "main" })
  assert.ok("source" in stable, JSON.stringify(stable))
  const beta = await saveSource(env, owner, (await getTrack(env, owner, track.id))!, { repository: "harbor-studio/harbor-theme", connection: "token", branch: "beta" }, Date.now(), "beta")
  assert.ok("source" in beta, JSON.stringify(beta))
  assert.deepEqual([beta.source.channel, beta.source.branch], ["beta", "beta"])

  // A tag only on beta: the beta channel's webhook publishes it, the stable one's ignores it.
  assert.match((await deliver(env, ctx, stable.source, { ref: "refs/tags/v1.5.0-beta.1", after: TAG_OBJECT })).ignored, /another channel/)
  assert.equal((await deliver(env, ctx, beta.source, { ref: "refs/tags/v1.5.0-beta.1", after: TAG_OBJECT })).import.state, "pending")
  // A tag on main, whose commit beta also has (after a merge): GitHub names main, so stable publishes it.
  assert.equal((await deliver(env, ctx, stable.source, { ref: "refs/tags/v1.5.0", after: TAG_OBJECT, base_ref: "refs/heads/main" })).import.state, "pending")
  assert.match((await deliver(env, ctx, beta.source, { ref: "refs/tags/v1.5.0", after: TAG_OBJECT, base_ref: "refs/heads/main" })).ignored, /another channel/)
  // A tag on no followed branch publishes nothing.
  assert.match((await deliver(env, ctx, stable.source, { ref: "refs/tags/v9.0.0", after: TAG_OBJECT })).ignored, /not on a branch/)
  await settle()

  const files = await listFiles(env, owner)
  assert.deepEqual(files.map((f) => [f.version, f.channel]).sort(), [["1.5.0", "stable"], ["1.5.0-beta.1", "beta"]])
  gh.restore()
})

test("channels of one track sharing a repository need their own branches; other tracks still need a tag prefix", async () => {
  const { env, owner, track } = await setup()
  const gh = github()
  // Today's setup: stable follows the repository on any branch. Beta can join it by following a branch.
  assert.ok("source" in (await saveSource(env, owner, track, { repository: "harbor-studio/harbor-theme", connection: "token" })))
  const same = await saveSource(env, owner, track, { repository: "harbor-studio/harbor-theme", connection: "token" }, Date.now(), "beta")
  assert.ok("error" in same && same.status === 409, "Two channels on any branch would both take every tag.")
  assert.ok("source" in (await saveSource(env, owner, track, { repository: "harbor-studio/harbor-theme", connection: "token", branch: "beta" }, Date.now(), "beta")))
  assert.ok("error" in (await saveSource(env, owner, track, { repository: "harbor-studio/harbor-theme", connection: "token", branch: "bad..name" }, Date.now(), "beta")))
  const missing = await saveSource(env, owner, track, { repository: "harbor-studio/harbor-theme", connection: "token" }, Date.now(), "nightly")
  assert.ok("error" in missing && missing.status === 422, "A channel the track does not have.")

  const other = await createTrack(env, owner, { name: "Final build", statuses: "suspended" })
  assert.ok("track" in other)
  const clash = await saveSource(env, owner, other.track, { repository: "harbor-studio/harbor-theme", connection: "token", branch: "final" })
  assert.ok("error" in clash && clash.status === 409, "Another track still needs a tag prefix.")
  gh.restore()
})

test("the channel of an imported tag: the source's channel; a stable source on any branch keeps the suffix rule", () => {
  assert.equal(channelForImport({ channel: "stable", branch: "" }, "2.0.0-beta.1", DEFAULT_CHANNELS), "beta")
  assert.equal(channelForImport({ channel: "stable", branch: "" }, "2.0.0", DEFAULT_CHANNELS), "stable")
  assert.equal(channelForImport({ channel: "stable", branch: "" }, "2.0.0-beta.1", [DEFAULT_CHANNELS[0]]), "stable", "No beta channel: stable.")
  assert.equal(channelForImport({ channel: "stable", branch: "main" }, "2.0.0-rc.1", DEFAULT_CHANNELS), "stable", "A branch decides, not the name.")
  assert.equal(channelForImport({ channel: "beta", branch: "beta" }, "2.0.0", DEFAULT_CHANNELS), "beta")
})

test("API: tracks list their channels, and ?channel= selects the repository of a channel", async () => {
  const { env, ctx, settle, track } = await setup()
  const key = (await createApiKey(env, "m", "full")).secret
  const call = async (method: string, path: string, payload?: unknown) => {
    const text = payload === undefined ? undefined : JSON.stringify(payload)
    const headers: Record<string, string> = { authorization: `Bearer ${key}` }
    if (text !== undefined) headers["content-length"] = String(new TextEncoder().encode(text).length)
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: text }), env, ctx)
    await settle()
    return { status: res.status, json: (await res.json()) as any }
  }
  const gh = github()
  const listed = (await call("GET", "/apps/harbor-theme/tracks")).json.data[0]
  assert.deepEqual(listed.channels, DEFAULT_CHANNELS)
  const put = await call("PUT", `/apps/harbor-theme/tracks/${track.id}/source?channel=beta`, { repository: "harbor-studio/harbor-theme", connection: "token", branch: "beta" })
  assert.equal(put.status, 201, JSON.stringify(put.json))
  assert.deepEqual([put.json.channel, put.json.branch], ["beta", "beta"])
  assert.equal((await call("GET", `/apps/harbor-theme/tracks/${track.id}/source`)).status, 404, "Stable has no repository.")
  assert.equal((await call("GET", `/apps/harbor-theme/tracks/${track.id}/source?channel=nightly`)).json.error.code, "channel_not_found")
  const after = (await call("GET", `/apps/harbor-theme/tracks/${track.id}`)).json
  assert.equal(after.source, null)
  assert.deepEqual(after.sources.map((s: any) => s.channel), ["beta"])
  const patched = await call("PATCH", `/apps/harbor-theme/tracks/${track.id}`, { channels: [...DEFAULT_CHANNELS, NIGHTLY] })
  assert.deepEqual(patched.json.channels.map((c: any) => c.key), ["stable", "beta", "nightly"])
  gh.restore()
})

test("migration 0020 keeps existing sources on stable and reported versions, and allows any channel afterwards", () => {
  const { raw } = makeDb("0019_release_labels.sql")
  raw.exec("INSERT INTO apps (id, name, slug, created_at, updated_at) VALUES ('app_1', 'Harbor Theme', 'harbor-theme', 1, 1)")
  raw.exec("INSERT INTO release_tracks (id, app_id, name, statuses, position, created_at, updated_at) VALUES ('trk_1', 'app_1', 'Updates', 'active', 0, 1, 1)")
  raw.exec("INSERT INTO release_sources (id, app_id, track_id, provider, repository, package_folder, statuses, webhook_secret, created_at, updated_at) VALUES ('src_1', 'app_1', 'trk_1', 'github', 'harbor-studio/harbor-theme', 'harbor-theme', 'active', 's', 1, 1)")
  raw.exec("INSERT INTO licenses (id, name, customer_name, license_key, status, domains, message, notes, created_at, updated_at, expiry_mode) VALUES ('lic_1', 'Harbor', '', 'WRD-AAAAA-AAAAA-AAAAA-AAAAA', 'active', '', '', '', 1, 1, 'shared')")
  raw.exec("INSERT INTO license_apps (id, license_id, app_id, tag, status) VALUES ('att_1', 'lic_1', 'app_1', 'default', 'active')")
  raw.exec("INSERT INTO activation_versions (attachment_id, domain, version, last_seen_at, channel) VALUES ('att_1', 'harborstudio.com', '1.4.0', 5, 'beta')")

  const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0020_track_channels.sql"), "utf8")
  for (const statement of splitStatements(sql)) raw.exec(statement)

  assert.deepEqual({ ...(raw.prepare("SELECT channel, branch FROM release_sources WHERE id = 'src_1'").get() as object) }, { channel: "stable", branch: "" })
  assert.equal((raw.prepare("SELECT channels FROM release_tracks WHERE id = 'trk_1'").get() as { channels: string | null }).channels, null)
  assert.deepEqual({ ...(raw.prepare("SELECT version, channel, last_seen_at FROM activation_versions").get() as object) }, { version: "1.4.0", channel: "beta", last_seen_at: 5 })
  raw.exec("UPDATE activation_versions SET channel = 'nightly'")
  // A second source of the same track on another channel is allowed; the same channel twice is not.
  raw.exec("INSERT INTO release_sources (id, app_id, track_id, channel, provider, repository, package_folder, statuses, webhook_secret, created_at, updated_at) VALUES ('src_2', 'app_1', 'trk_1', 'beta', 'github', 'harbor-studio/harbor-theme', 'harbor-theme', 'active', 's', 1, 1)")
  assert.throws(() => raw.exec("INSERT INTO release_sources (id, app_id, track_id, channel, provider, repository, package_folder, statuses, webhook_secret, created_at, updated_at) VALUES ('src_3', 'app_1', 'trk_1', 'beta', 'github', 'x/y', 'y', 'active', 's', 1, 1)"))
})
