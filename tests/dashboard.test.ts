import { test } from "node:test"
import assert from "node:assert/strict"
import { makeCtx, makeDb } from "./helpers/d1.ts"
import { toCsv } from "../app/lib/csv.ts"
import { DEFAULT_STATUSES } from "../app/lib/statuses.ts"
import { daysUntil, describeExpiry, filterLicenses, inView, readLicenseFilter } from "../app/lib/views.ts"
import { handleCheck } from "../app/server/check.server.ts"
import { attentionLists, createLicense, overviewStats, recentEvents, searchLicenses, type LicenseInput } from "../app/server/licenses.server.ts"

const DAY = 86_400_000
const base: LicenseInput = { name: "Harbor", customer_name: "", customer_email: "", app_id: null, max_sites: null, status: "active", expires_at: null, domains: "", message: "", notes: "" }

test("expiry wording uses calendar days in UTC", () => {
  const now = Date.parse("2026-10-10T09:00:00Z")
  const endOf = (date: string) => Date.parse(`${date}T23:59:59.999Z`)
  assert.equal(daysUntil(endOf("2026-10-10"), now), 0)
  assert.equal(describeExpiry(endOf("2026-10-10"), now), "today")
  assert.equal(describeExpiry(endOf("2026-10-11"), now), "tomorrow")
  assert.equal(describeExpiry(endOf("2026-10-20"), now), "in 10 days")
  assert.equal(describeExpiry(endOf("2026-10-09"), now), "yesterday")
  assert.equal(describeExpiry(endOf("2026-10-01"), now), "9 days ago")
  assert.equal(describeExpiry(null, now), "Never")
})

test("licence views and list filters", () => {
  const now = Date.now()
  const lic = (over: Partial<{ status: string; expires_at: number | null; last_check_at: number | null; created_at: number; app_id: string | null; name: string }>) => ({
    status: "active", expires_at: null, last_check_at: now, created_at: now - 30 * DAY, app_id: null, name: "A", customer_name: "", customer_email: "", license_key: "WRD-X", domains: "", ...over,
  })
  const set = DEFAULT_STATUSES
  assert.equal(inView(lic({}), set, "valid", now), true)
  assert.equal(inView(lic({ status: "suspended" }), set, "invalid", now), true)
  assert.equal(inView(lic({ expires_at: now + 5 * DAY }), set, "expiring", now), true)
  assert.equal(inView(lic({ expires_at: now + 30 * DAY }), set, "expiring", now), false)
  assert.equal(inView(lic({ status: "completed", expires_at: now + 5 * DAY }), set, "expiring", now), false) // completed ignores the date
  assert.equal(inView(lic({ expires_at: now - DAY }), set, "expiring", now), false) // already expired: not valid
  assert.equal(inView(lic({ last_check_at: now - 4 * DAY }), set, "silent", now), true)
  assert.equal(inView(lic({ last_check_at: null, created_at: now - DAY }), set, "silent", now), false) // new licences get time to check in
  assert.equal(inView(lic({ status: "disabled", last_check_at: null }), set, "silent", now), false)

  const rows = [lic({ name: "Maple Dental" }), lic({ name: "Atlas", app_id: "app_1", status: "suspended" }), lic({ name: "Harbor", expires_at: now + 2 * DAY })]
  const run = (query: string) => filterLicenses(rows, readLicenseFilter(new URLSearchParams(query)), () => set, now).map((l) => l.name)
  assert.deepEqual(run(""), ["Maple Dental", "Atlas", "Harbor"])
  assert.deepEqual(run("q=maple"), ["Maple Dental"])
  assert.deepEqual(run("app=none"), ["Maple Dental", "Harbor"])
  assert.deepEqual(run("app=app_1"), ["Atlas"])
  assert.deepEqual(run("status=suspended"), ["Atlas"])
  assert.deepEqual(run("view=expiring"), ["Harbor"])
  assert.deepEqual(readLicenseFilter(new URLSearchParams("view=in_force")).view, "") // earlier name, removed in 0.3.0
  assert.deepEqual(run("view=bogus"), ["Maple Dental", "Atlas", "Harbor"]) // unknown views are ignored
})

test("CSV export escapes quotes, line breaks and spreadsheet formulas", () => {
  assert.equal(toCsv([["a", 'say "hi"', "x,y", "line\nbreak", null, 3, true]]), 'a,"say ""hi""","x,y","line\nbreak",,3,true\r\n')
  assert.equal(toCsv([["=HYPERLINK(1)", "+1", "-2", "@cmd", "ok"]]), "'=HYPERLINK(1),'+1,'-2,'@cmd,ok\r\n")
})

test("search finds licences by their fields and by a registered site", async () => {
  const env = { DB: makeDb().DB } as unknown as Env
  const { ctx, settle } = makeCtx()
  const maple = await createLicense(env, { ...base, name: "Maple Dental website", customer_name: "Maple Dental" })
  const atlas = await createLicense(env, { ...base, name: "Atlas shop" })
  await handleCheck(new Request(`https://w.dev/check/${atlas.license_key}?domain=shop.atlas-goods.com`), env, ctx, atlas.license_key)
  await settle()
  assert.deepEqual((await searchLicenses(env, "maple")).map((h) => h.id), [maple.id])
  assert.deepEqual((await searchLicenses(env, maple.license_key.slice(4, 15))).map((h) => h.id), [maple.id])
  const bySite = await searchLicenses(env, "atlas-goods")
  assert.deepEqual(bySite.map((h) => [h.id, h.matched_site]), [[atlas.id, "shop.atlas-goods.com"]])
  assert.deepEqual(await searchLicenses(env, "   "), [])
  assert.deepEqual(await searchLicenses(env, "100%_"), []) // LIKE wildcards are matched literally
})

test("attention lists and recent events agree with the overview counts", async () => {
  const env = { DB: makeDb().DB } as unknown as Env
  const now = Date.now()
  const soon = await createLicense(env, { ...base, name: "Soon", expires_at: now + 3 * DAY })
  const sooner = await createLicense(env, { ...base, name: "Sooner", expires_at: now + DAY })
  await createLicense(env, { ...base, name: "Later", expires_at: now + 60 * DAY })
  const quiet = await createLicense(env, { ...base, name: "Quiet" })
  await env.DB.prepare("UPDATE licenses SET created_at = ?, last_check_at = ? WHERE id = ?").bind(now - 20 * DAY, now - 5 * DAY, quiet.id).run()
  await env.DB.prepare("UPDATE licenses SET last_check_at = ? WHERE id IN (?, ?)").bind(now, soon.id, sooner.id).run()

  const lists = await attentionLists(env)
  assert.deepEqual(lists.expiring.map((l) => l.id), [sooner.id, soon.id])
  assert.deepEqual(lists.silent.map((l) => l.id), [quiet.id])
  const stats = await overviewStats(env)
  assert.equal(stats.endingSoon, lists.expiring.length)
  assert.equal(stats.silent, lists.silent.length)

  const events = await recentEvents(env, 10)
  assert.equal(events.length, 4)
  assert.ok(events.every((e) => e.event === "change" && e.detail === "Licence created"))
  assert.equal((await recentEvents(env, 10, "check")).length, 0)
})

test("the attention lists keep recent expiries, not licences made invalid by decision", async () => {
  const env = { DB: makeDb().DB } as unknown as Env
  const now = Date.now()
  const lapsed = await createLicense(env, { ...base, name: "Lapsed", expires_at: now - 3 * DAY })
  await createLicense(env, { ...base, name: "Long gone", expires_at: now - 60 * DAY })
  await createLicense(env, { ...base, name: "Fine", expires_at: now + 200 * DAY })
  await createLicense(env, { ...base, name: "No expiry" })
  await createLicense(env, { ...base, name: "Suspended", status: "suspended", expires_at: now - 3 * DAY })
  await createLicense(env, { ...base, name: "Disabled", status: "disabled", expires_at: now - 3 * DAY })
  await createLicense(env, { ...base, name: "Pending", status: "pending", expires_at: now - 3 * DAY })
  await createLicense(env, { ...base, name: "Completed", status: "completed", expires_at: now - 3 * DAY })
  const set = await createLicense(env, { ...base, name: "Set to Expired", status: "expired", expires_at: now - 5 * DAY })

  const lists = await attentionLists(env, 8, now)
  assert.deepEqual(lists.lapsed.map((l) => l.id), [lapsed.id, set.id])
  assert.ok(!lists.expiring.some((l) => l.id === lapsed.id), "a lapsed licence is not also listed as expiring")
})
