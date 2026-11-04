import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { makeBucket, makeCtx, makeDb } from "./helpers/d1.ts"
import { compareVersions, isOutdated, isValidVersion, latestRelease, readReportedVersion, sortForDisplay } from "../app/lib/releases.ts"
import { createApp } from "../app/server/apps.server.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { handleDownload } from "../app/server/download.server.ts"
import { storeFile, updateFile, type FileOwner } from "../app/server/files.server.ts"
import { createLicense, listActivations, recentActivity, setStatus, getLicense, type LicenseInput } from "../app/server/licenses.server.ts"
import { handleApi } from "../app/server/api.server.ts"
import { createApiKey } from "../app/server/api-keys.server.ts"

const ORIGIN = "https://w.dev"
const licenseInput: LicenseInput = { name: "Harbor", customer_name: "", customer_email: "", app_id: null, max_sites: null, status: "active", expires_at: null, domains: "", message: "", notes: "" }

function setup() {
  const { bucket } = makeBucket()
  const env = { DB: makeDb().DB, FILES: bucket } as unknown as Env
  const { ctx, settle } = makeCtx()
  return { env, ctx, settle }
}

async function release(env: Env, owner: FileOwner, version: string, extra: { channel?: string; statuses?: string; changelog?: string; text?: string; name?: string } = {}) {
  const text = extra.text ?? `bytes of ${version}`
  const res = await storeFile(env, owner, {
    name: extra.name ?? `harbor-theme-${version || "notes"}.zip`,
    version,
    channel: extra.channel,
    changelog: extra.changelog,
    statuses: extra.statuses,
    checkDomain: false,
    size: new TextEncoder().encode(text).length,
    body: new Response(text).body,
    contentType: "application/zip",
  })
  assert.ok("file" in res, JSON.stringify(res))
  return res.file
}

test("versions compare by semantic versioning precedence", () => {
  assert.ok(compareVersions("1.10.0", "1.9.2") > 0)
  assert.equal(compareVersions("v2.0", "2.0.0"), 0)
  assert.equal(compareVersions("2.0.0+build.7", "2.0.0"), 0)
  assert.ok(compareVersions("2.0.0", "2.0.0-rc.1") > 0)
  assert.ok(compareVersions("2.0.0-rc.2", "2.0.0-rc.1") > 0)
  assert.ok(compareVersions("2.0.0-rc.10", "2.0.0-rc.9") > 0)
  assert.ok(compareVersions("2.0.0-beta", "2.0.0-alpha") > 0)
  assert.ok(compareVersions("2.0.0-alpha.1", "2.0.0-alpha") > 0)
  assert.ok(compareVersions("2.0.0-alpha.beta", "2.0.0-alpha.1") > 0) // words rank above numbers
  assert.ok(compareVersions("2.0.0-rc.1", "1.9.9") > 0)
})

test("version format, reported versions and display order", () => {
  for (const ok of ["1", "1.4", "1.4.0", "v1.4.0", "1.4.0.2", "2.0.0-beta.1", "2.0.0+build.5", "2.0.0-rc.1+sha.abc"]) assert.equal(isValidVersion(ok), true, ok)
  for (const bad of ["", "latest", "1.x", "1..2", "1.2.3.4.5", "1.0 beta", "-1.0", "a".repeat(41)]) assert.equal(isValidVersion(bad), false, bad)
  assert.equal(readReportedVersion(" 1.3.0 "), "1.3.0")
  assert.equal(readReportedVersion("not-a-version"), null)
  assert.equal(readReportedVersion(42), null)
  assert.equal(isOutdated("1.3.0", "1.4.0"), true)
  assert.equal(isOutdated("1.4.0", "1.4.0"), false)
  assert.equal(isOutdated(null, "1.4.0"), false)
  assert.equal(isOutdated("1.3.0", null), false)
  const files = [
    { version: "", channel: "stable", withdrawn_at: null, uploaded_at: 5 },
    { version: "1.2.0", channel: "stable", withdrawn_at: null, uploaded_at: 1 },
    { version: "1.10.0", channel: "stable", withdrawn_at: null, uploaded_at: 2 },
    { version: "", channel: "stable", withdrawn_at: null, uploaded_at: 9 },
  ]
  assert.deepEqual(sortForDisplay(files).map((f) => f.version || f.uploaded_at), ["1.10.0", "1.2.0", 9, 5])
})

test("the latest release depends on the channel and ignores attachments and withdrawn releases", () => {
  const f = (version: string, channel = "stable", withdrawn_at: number | null = null) => ({ version, channel, withdrawn_at })
  const files = [f("1.4.0"), f("2.0.0-beta.1", "beta"), f(""), f("1.5.0", "stable", 123), f("1.3.9")]
  assert.equal(latestRelease(files)?.version, "1.4.0")
  assert.equal(latestRelease(files, "beta")?.version, "2.0.0-beta.1")
  assert.equal(latestRelease([f("2.0.0", "stable"), f("2.0.0-rc.3", "beta")], "beta")?.version, "2.0.0") // a stable release beats its own pre-releases
  assert.equal(latestRelease([f("")]), null)
  // equal versions: the first entry wins (lists are passed newest first)
  const tie = [{ ...f("1.0.0"), id: "newer" }, { ...f("1.0"), id: "older" }]
  assert.equal(latestRelease(tie)?.id, "newer")
})

test("uploads record a SHA-256 checksum and validate version and channel", async () => {
  const { env } = setup()
  const license = await createLicense(env, licenseInput)
  const file = await release(env, { license }, "1.0.0", { text: "hello world" })
  assert.equal(file.sha256, createHash("sha256").update("hello world").digest("hex"))
  assert.equal(file.channel, "stable")

  const bad = async (version: string, channel?: string) => {
    const res = await storeFile(env, { license }, { name: "x.zip", version, channel, size: 1, body: new Response("x").body })
    assert.ok("error" in res && res.status === 422, `${version} ${channel}: ${JSON.stringify(res)}`)
  }
  await bad("latest")
  await bad("1.0.0", "nightly")

  // editing: version, channel, changelog, withdraw and restore
  assert.equal(((await updateFile(env, { license }, file, { version: "one" })) as { status: number }).status, 422)
  assert.equal(((await updateFile(env, { license }, file, { channel: "alpha" })) as { status: number }).status, 422)
  const edited = await updateFile(env, { license }, file, { channel: "beta", changelog: "  Fixes the header.  ", withdrawn: true })
  assert.ok("file" in edited)
  if ("file" in edited) {
    assert.deepEqual([edited.file.channel, edited.file.changelog, edited.file.withdrawn_at !== null], ["beta", "Fixes the header.", true])
    const restored = await updateFile(env, { license }, edited.file, { withdrawn: false })
    assert.ok("file" in restored && restored.file.withdrawn_at === null)
  }
  const log = (await recentActivity(env, license.id)).map((a) => a.detail).join("|")
  assert.match(log, /File added: harbor-theme-1.0.0.zip \(version 1.0.0\)/)
  assert.match(log, /Release withdrawn: harbor-theme-1.0.0.zip/)
  assert.match(log, /Release restored: harbor-theme-1.0.0.zip/)
})

test("a check with a version offers the newest release the licence can download", async () => {
  const { env, ctx, settle } = setup()
  const created = await createApp(env, { name: "Harbor Theme", slug: "harbor-theme", description: "", default_duration_days: null, default_status: "active", default_max_sites: 2, default_message: "", notes: "" })
  assert.ok("app" in created)
  const app = created.app
  const license = await createLicense(env, { ...licenseInput, app_id: app.id, max_sites: 2 })
  // Two tracks: updates for Active licences, the final build for Completed ones.
  await release(env, { app }, "1.3.0", { statuses: "active" })
  const current = await release(env, { app }, "1.4.0", { changelog: "Faster gallery.", statuses: "active" })
  await release(env, { app }, "1.5.0-beta.1", { channel: "beta", statuses: "active" })
  await release(env, { app }, "", { name: "manual.pdf" })
  const final = await release(env, { app }, "9.0.0", { statuses: "completed" }) // not available while the licence is Active

  const check = async (query: string) => {
    const res = await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}?${query}`), env, ctx, license.license_key)
    await settle()
    return (await res.json()) as any
  }

  const outdated = await check("domain=harborstudio.com&version=1.3.0")
  assert.equal(outdated.valid, true)
  assert.equal(outdated.update.current, "1.3.0")
  assert.equal(outdated.update.available, true)
  assert.equal(outdated.update.latest.id, current.id)
  assert.equal(outdated.update.latest.version, "1.4.0")
  assert.equal(outdated.update.latest.changelog, "Faster gallery.")
  assert.equal(outdated.update.latest.sha256, current.sha256)
  // A signed link (download-links.test.ts): the licence key is not part of the address.
  assert.match(outdated.update.latest.download_url, /^https:\/\/w\.dev\/download\/t\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.ok(!outdated.update.latest.download_url.includes(license.license_key))

  const upToDate = await check("domain=harborstudio.com&version=1.4.0")
  assert.equal(upToDate.update.available, false)
  assert.equal(upToDate.update.latest.version, "1.4.0")

  const beta = await check("domain=harborstudio.com&version=1.4.0&channel=beta")
  assert.equal(beta.update.latest.version, "1.5.0-beta.1")
  assert.equal(beta.update.available, true)

  // no version sent: no update block, the response stays as before
  assert.equal((await check("domain=harborstudio.com")).update, undefined)
  // an invalid version is ignored
  assert.equal((await check("domain=harborstudio.com&version=nonsense")).update, undefined)

  // the reported version is recorded for the site, and a check without a version keeps it
  assert.equal((await listActivations(env, license.id)).find((a) => a.domain === "harborstudio.com")?.version, "1.4.0")
  assert.match((await recentActivity(env, license.id)).map((a) => a.detail).join("|"), /Version 1.4.0/)

  // the completed-only release becomes the update once the licence is completed
  await setStatus(env, (await getLicense(env, license.id))!, "completed")
  assert.equal((await check("domain=harborstudio.com&version=1.4.0")).update.latest.id, final.id)

  // a licence that does not let sites run is offered nothing
  await setStatus(env, (await getLicense(env, license.id))!, "suspended")
  const suspended = await check("domain=harborstudio.com&version=1.3.0")
  assert.deepEqual([suspended.valid, suspended.update.available, suspended.update.latest], [false, false, null])

  // POST bodies carry the same fields
  await setStatus(env, (await getLicense(env, license.id))!, "active")
  const posted = await handleCheck(new Request(`${ORIGIN}/check/${license.license_key}`, { method: "POST", body: JSON.stringify({ domain: "harborstudio.com", version: "1.3.0" }) }), env, ctx, license.license_key)
  assert.equal(((await posted.json()) as any).update.available, true)
  await settle()
})

test("download list: channels, checksums, withdrawn releases and internal notes", async () => {
  const { env, ctx, settle } = setup()
  const license = await createLicense(env, licenseInput)
  const stable = await release(env, { license }, "1.0.0", { changelog: "First release." })
  await storeFile(env, { license }, { name: "notes.zip", version: "1.1.0", notes: "internal only", size: 1, body: new Response("x").body })
  const beta = await release(env, { license }, "2.0.0-beta.1", { channel: "beta" })
  const get = async (path: string) => {
    const res = await handleDownload(new Request(`${ORIGIN}/download/${path}`), env, ctx, license.license_key, path.split("/")[1]?.split("?")[0] ?? null)
    await settle()
    return res
  }

  const list = (await (await get(license.license_key)).json()) as any
  assert.equal(list.latest.version, "1.1.0")
  assert.equal(list.files.length, 3)
  assert.ok(list.files.every((f: any) => !("notes" in f)), "internal notes are never public")
  assert.equal(list.files.find((f: any) => f.id === stable.id).changelog, "First release.")
  assert.equal(((await (await get(`${license.license_key}?channel=beta`)).json()) as any).latest.id, beta.id)

  const download = await get(`${license.license_key}/${stable.id}`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get("x-warden-sha256"), stable.sha256)

  // withdrawing a release removes it from the list and from the update offer, and refuses the download
  await updateFile(env, { license }, beta, { withdrawn: true })
  const afterWithdraw = (await (await get(`${license.license_key}?channel=beta`)).json()) as any
  assert.equal(afterWithdraw.latest.version, "1.1.0")
  assert.ok(!afterWithdraw.files.some((f: any) => f.id === beta.id))
  const gone = await get(`${license.license_key}/${beta.id}`)
  assert.equal(gone.status, 410)
  assert.equal(((await gone.json()) as any).status, "withdrawn")
})

test("API: release fields, withdrawal and the versions sites run", async () => {
  const { env, ctx, settle } = setup()
  const manage = (await createApiKey(env, "m", "manage")).secret
  const call = async (method: string, path: string, payload?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${manage}` }
    if (payload !== undefined) headers["content-length"] = String(new TextEncoder().encode(payload).length)
    const res = await handleApi(new Request(`${ORIGIN}/api/v1${path}`, { method, headers, body: payload }), env, ctx)
    await settle()
    return { status: res.status, json: (await res.json()) as any }
  }
  const app = (await call("POST", "/apps", JSON.stringify({ name: "Atlas", default_max_sites: 5 }))).json
  const put = await call("PUT", `/apps/${app.slug}/files?name=atlas-1.2.0.zip&version=1.2.0&channel=stable&changelog=${encodeURIComponent("Bug fixes.")}`, "zip-bytes")
  assert.equal(put.status, 201)
  assert.deepEqual([put.json.version, put.json.channel, put.json.changelog, put.json.withdrawn], ["1.2.0", "stable", "Bug fixes.", false])
  assert.equal(put.json.sha256, createHash("sha256").update("zip-bytes").digest("hex"))
  assert.equal((await call("PUT", `/apps/${app.slug}/files?name=x.zip&version=soon`, "x")).status, 422)
  assert.equal((await call("PUT", `/apps/${app.slug}/files?name=x.zip&version=1.0.0&channel=nightly`, "x")).status, 422)
  await call("PUT", `/apps/${app.slug}/files?name=atlas-1.1.0.zip&version=1.1.0`, "old")

  const withdrawn = await call("PATCH", `/apps/${app.slug}/files/${put.json.id}`, JSON.stringify({ withdrawn: true, changelog: "Pulled: breaks checkout." }))
  assert.deepEqual([withdrawn.json.withdrawn, withdrawn.json.changelog], [true, "Pulled: breaks checkout."])
  assert.equal((await call("GET", `/apps/${app.slug}`)).json.latest_version, "1.1.0")
  await call("PATCH", `/apps/${app.slug}/files/${put.json.id}`, JSON.stringify({ withdrawn: false }))
  assert.equal((await call("GET", `/apps/${app.slug}`)).json.latest_version, "1.2.0")

  // sites report their versions with their checks
  const lic = (await call("POST", `/apps/${app.slug}/licenses`, JSON.stringify({ name: "Maple Dental" }))).json
  for (const [domain, version] of [["a.com", "1.2.0"], ["b.com", "1.1.0"], ["c.com", "1.1.0"], ["d.com", null]] as const) {
    await handleCheck(new Request(`${ORIGIN}/check/${lic.key}?domain=${domain}${version ? `&version=${version}` : ""}`), env, ctx, lic.key)
    await settle()
  }
  const versions = (await call("GET", `/apps/${app.slug}/versions`)).json
  assert.deepEqual(versions, {
    latest_version: "1.2.0",
    sites: 4,
    outdated: 2,
    data: [
      { version: "1.2.0", sites: 1, behind: 0, outdated: false },
      { version: "1.1.0", sites: 2, behind: 2, outdated: true },
      { version: null, sites: 1, behind: 0, outdated: false },
    ],
  })
  const sites = (await call("GET", `/licenses/${lic.id}/activations`)).json.data
  assert.equal(sites.find((s: any) => s.domain === "b.com").version, "1.1.0")
})
