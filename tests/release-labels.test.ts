import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { makeBucket, makeCtx, makeDb } from "./helpers/d1.ts"
import { DEFAULT_RELEASE_LABELS, keepKnownLabels, labelKeyFromName, parseLabelDefinitions, parseReleaseLabels, readTrackLabels } from "../app/lib/release-labels.ts"
import { splitStatements } from "../app/server/migrate.server.ts"
import { createApp } from "../app/server/apps.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { handleDownload } from "../app/server/download.server.ts"
import { storeFile, updateFile } from "../app/server/files.server.ts"
import { createLicense, type LicenseInput } from "../app/server/licenses.server.ts"
import { createTrack, deleteTrack, getTrack, updateTrack } from "../app/server/tracks.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"

const ORIGIN = "https://w.dev"
const licenseInput: LicenseInput = { name: "Harbor", customer_name: "", customer_email: "", app_id: null, max_sites: null, status: "active", expires_at: null, domains: "", message: "", notes: "" }

async function setup() {
  const { bucket } = makeBucket()
  const env = { DB: makeDb().DB, FILES: bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  const created = await createApp(env, { name: "Harbor Theme", slug: "harbor-theme", description: "", default_duration_days: null, default_status: "active", default_max_sites: null, default_message: "", notes: "" })
  assert.ok("app" in created)
  const app = created.app
  const license = await createLicense(env, { ...licenseInput, app_id: app.id })
  const upload = async (version: string, extra: { track?: string; labels?: unknown } = {}) => {
    const text = `bytes of ${version}`
    const res = await storeFile(env, { app }, { name: `harbor-theme-${version}.zip`, version, checkDomain: false, size: text.length, body: new Response(text).body, track: extra.track, labels: extra.labels })
    return res
  }
  const latest = async (channel = "stable") => {
    const res = await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}?domain=harborstudio.com&version=1.0.0&channel=${channel}`), env, ctx, license.license_key)
    await settle()
    return ((await res.json()) as any).update.latest
  }
  return { env, ctx, settle, app, license, upload, latest }
}

test("label keys come from names, and a track's label set is validated", () => {
  assert.equal(labelKeyFromName("Bug fix"), "bug_fix")
  assert.equal(labelKeyFromName("  Sécurité!  "), "securite")
  assert.equal(labelKeyFromName("2024 hotfix"), "hotfix")
  assert.equal(labelKeyFromName("!!!"), "")

  const ok = parseLabelDefinitions([{ name: "Urgent", color: "#DC2626" }, { key: "lts", name: "Long-term support", color: "#2563eb" }])
  assert.deepEqual(ok, { labels: [{ key: "urgent", name: "Urgent", color: "#dc2626" }, { key: "lts", name: "Long-term support", color: "#2563eb" }] })
  assert.ok("error" in parseLabelDefinitions([{ name: "Urgent", color: "red" }]), "Colours are hex.")
  assert.ok("error" in parseLabelDefinitions([{ name: "Urgent", color: "#dc2626" }, { name: "urgent", color: "#000000" }]), "Names are unique.")
  assert.ok("error" in parseLabelDefinitions([{ key: "Bad Key", name: "X", color: "#000000" }]))
  assert.ok("error" in parseLabelDefinitions([{ name: "", color: "#000000" }]))
  assert.ok("error" in parseLabelDefinitions("urgent"))

  assert.deepEqual(readTrackLabels(null), DEFAULT_RELEASE_LABELS, "A track from before labels uses the defaults.")
  assert.deepEqual(readTrackLabels("[]"), [], "A track whose labels were all removed has none.")
})

test("a release's labels must be labels of its track, and keep the track's order", () => {
  assert.deepEqual(parseReleaseLabels("security, urgent,urgent", DEFAULT_RELEASE_LABELS), { keys: ["urgent", "security"] })
  assert.deepEqual(parseReleaseLabels([], DEFAULT_RELEASE_LABELS), { keys: [] })
  const unknown = parseReleaseLabels(["urgent", "hotfix"], DEFAULT_RELEASE_LABELS)
  assert.ok("error" in unknown && unknown.error.includes('"hotfix"'))
  assert.deepEqual(keepKnownLabels(["feature", "gone"], DEFAULT_RELEASE_LABELS), ["feature"])
})

test("labels given to a release reach sites in the check answer and the download list", async () => {
  const { env, ctx, settle, license, upload, latest } = await setup()
  const stored = await upload("1.4.0", { labels: "urgent,security" })
  assert.ok("file" in stored, JSON.stringify(stored))
  assert.deepEqual((await latest()).labels, ["urgent", "security"])

  const res = await handleDownload(new Request(`${ORIGIN}/download/${license.license_key}?domain=harborstudio.com`), env, ctx, license.license_key, null)
  await settle()
  const list = (await res.json()) as any
  assert.deepEqual(list.latest.labels, ["urgent", "security"])
  assert.deepEqual(list.files[0].labels, ["urgent", "security"])

  const unknown = await upload("1.5.0", { labels: "hotfix" })
  assert.ok("error" in unknown && unknown.status === 422, "A label the track does not define is refused.")
})

test("editing labels: replace them, clear them, and a release without labels sends an empty list", async () => {
  const { env, app, upload, latest } = await setup()
  const stored = await upload("1.4.0")
  assert.ok("file" in stored)
  assert.deepEqual((await latest()).labels, [])

  const marked = await updateFile(env, { app }, stored.file, { labels: ["feature"] })
  assert.ok("file" in marked)
  assert.deepEqual((await latest()).labels, ["feature"])

  // Other changes leave the labels alone.
  const renotes = await updateFile(env, { app }, marked.file, { changelog: "Faster gallery." })
  assert.ok("file" in renotes)
  assert.equal(renotes.file.labels, "feature")

  const cleared = await updateFile(env, { app }, renotes.file, { labels: "" })
  assert.ok("file" in cleared)
  assert.deepEqual((await latest()).labels, [])

  // An attachment carries no label.
  const attachment = await updateFile(env, { app }, cleared.file, { version: "", statuses: "active" })
  assert.ok("file" in attachment)
  assert.equal(attachment.file.labels, "")
})

test("a track defines its own labels; removing one, or moving a release, drops what the track does not define", async () => {
  const { env, app, upload } = await setup()
  const first = await upload("1.4.0", { labels: ["urgent", "feature"] })
  assert.ok("file" in first, JSON.stringify(first))
  const updates = (await getTrack(env, { app }, first.file.track_id!))!
  assert.equal(updates.labels, JSON.stringify(DEFAULT_RELEASE_LABELS), "A new track is created with the default labels.")

  // Renaming and recolouring keeps the key; removing "feature" takes it off the release.
  const edited = await updateTrack(env, { app }, updates, { labels: [{ key: "urgent", name: "Critical", color: "#b91c1c" }, { name: "Hotfix", color: "#0891b2" }] })
  assert.ok("track" in edited, JSON.stringify(edited))
  assert.deepEqual(readTrackLabels(edited.track.labels), [{ key: "urgent", name: "Critical", color: "#b91c1c" }, { key: "hotfix", name: "Hotfix", color: "#0891b2" }])
  const after = (await env.DB.prepare("SELECT labels FROM files WHERE id = ?").bind(first.file.id).first<{ labels: string }>())!
  assert.equal(after.labels, "urgent")

  const invalid = await updateTrack(env, { app }, edited.track, { labels: [{ name: "Urgent", color: "nope" }] })
  assert.ok("error" in invalid && invalid.status === 422)

  // A release moved to a track without "urgent" loses it; deleting a track moves releases the same way.
  const final = await createTrack(env, { app }, { name: "Maintenance", statuses: ["suspended"], labels: [{ name: "Hotfix", color: "#0891b2" }] })
  assert.ok("track" in final, JSON.stringify(final))
  const moved = await updateFile(env, { app }, (await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(first.file.id).first<any>())!, { track: final.track.id })
  assert.ok("file" in moved, JSON.stringify(moved))
  assert.equal(moved.file.labels, "")

  const second = await upload("2.0.0", { track: edited.track.id, labels: ["urgent", "hotfix"] })
  assert.ok("file" in second, JSON.stringify(second))
  const deleted = await deleteTrack(env, { app }, edited.track, final.track.id)
  assert.ok("ok" in deleted)
  assert.equal((await env.DB.prepare("SELECT labels FROM files WHERE id = ?").bind(second.file.id).first<{ labels: string }>())!.labels, "hotfix")
})

test("the API sets labels on upload and PATCH, and edits a track's labels", async () => {
  const { env, ctx, settle } = await setup()
  const key = (await createApiKey(env, "m", "manage")).secret
  const call = async (method: string, path: string, payload?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` }
    if (payload !== undefined) headers["content-length"] = String(new TextEncoder().encode(payload).length)
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: payload }), env, ctx)
    await settle()
    return { status: res.status, json: (await res.json()) as any }
  }
  const put = await call("PUT", "/apps/harbor-theme/files?name=harbor-1.2.0.zip&version=1.2.0&labels=security", "zip-bytes")
  assert.equal(put.status, 201, JSON.stringify(put.json))
  assert.deepEqual(put.json.labels, ["security"])

  const patched = await call("PATCH", `/apps/harbor-theme/files/${put.json.id}`, JSON.stringify({ labels: ["urgent", "security"] }))
  assert.equal(patched.status, 200, JSON.stringify(patched.json))
  assert.deepEqual(patched.json.labels, ["urgent", "security"])
  const refused = await call("PATCH", `/apps/harbor-theme/files/${put.json.id}`, JSON.stringify({ labels: ["hotfix"] }))
  assert.equal(refused.status, 422)
  assert.equal(refused.json.error.code, "invalid_file")

  const track = (await call("GET", "/apps/harbor-theme/tracks")).json.data[0]
  assert.deepEqual(track.labels, DEFAULT_RELEASE_LABELS)
  const relabelled = await call("PATCH", `/apps/harbor-theme/tracks/${track.id}`, JSON.stringify({ labels: [{ key: "urgent", name: "Urgent", color: "#dc2626" }] }))
  assert.equal(relabelled.status, 200, JSON.stringify(relabelled.json))
  assert.deepEqual(relabelled.json.labels, [{ key: "urgent", name: "Urgent", color: "#dc2626" }])
  assert.deepEqual((await call("GET", "/apps/harbor-theme/files")).json.data[0].labels, ["urgent"], "The removed label is gone from the release.")
  const bad = await call("PATCH", `/apps/harbor-theme/tracks/${track.id}`, JSON.stringify({ labels: [{ name: "Urgent", color: "red" }] }))
  assert.equal(bad.status, 422)
})

test("migration 0019 turns the urgent marker of 0.6.3 into the urgent label and takes it out of the notes", () => {
  const { raw } = makeDb("0018_site_channel.sql")
  raw.exec("INSERT INTO apps (id, name, slug, created_at, updated_at) VALUES ('app_1', 'Harbor Theme', 'harbor-theme', 1, 1)")
  raw.exec("INSERT INTO release_tracks (id, app_id, name, statuses, check_domain, position, created_at, updated_at) VALUES ('trk_1', 'app_1', 'Releases', 'active', 1, 0, 1, 1)")
  const insert = raw.prepare("INSERT INTO files (id, app_id, name, version, changelog, statuses, check_domain, size, content_type, r2_key, uploaded_at, track_id) VALUES (?, 'app_1', 'x.zip', ?, ?, 'active', 1, 1, 't', ?, 1, ?)")
  insert.run("fil_button", "1.0.0", "Fixes the gallery.\n\n[urgent]", "k1", "trk_1")
  insert.run("fil_alone", "1.0.1", "[urgent]", "k2", "trk_1")
  insert.run("fil_typed", "1.0.2", "Security fix [URGENT]", "k3", "trk_1")
  insert.run("fil_plain", "1.0.3", "Nothing urgent here.", "k4", "trk_1")
  insert.run("fil_attachment", "", "[urgent]", "k5", null)

  const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0019_release_labels.sql"), "utf8")
  for (const statement of splitStatements(sql)) raw.exec(statement)

  const row = (id: string) => raw.prepare("SELECT labels, changelog FROM files WHERE id = ?").get(id) as { labels: string; changelog: string }
  assert.deepEqual({ ...row("fil_button") }, { labels: "urgent", changelog: "Fixes the gallery." })
  assert.deepEqual({ ...row("fil_alone") }, { labels: "urgent", changelog: "" })
  assert.deepEqual({ ...row("fil_typed") }, { labels: "urgent", changelog: "Security fix [URGENT]" }, "A marker typed in another case gets the label; its text stays.")
  assert.deepEqual({ ...row("fil_plain") }, { labels: "", changelog: "Nothing urgent here." })
  assert.deepEqual({ ...row("fil_attachment") }, { labels: "", changelog: "[urgent]" }, "Attachments have no labels.")
  assert.equal((raw.prepare("SELECT labels FROM release_tracks WHERE id = 'trk_1'").get() as { labels: string | null }).labels, null, "Existing tracks use the default labels.")
})
