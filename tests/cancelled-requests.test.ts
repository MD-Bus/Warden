import { test } from "node:test"
import assert from "node:assert/strict"
import { makeDb } from "./helpers/d1.ts"
import { ensureMigrated } from "../app/server/migrate.server.ts"
import { getSigningKey, resetSigningKeyCache } from "../app/server/signing.server.ts"

/** A database whose queries are never answered, as when the Workers runtime cancels the request that started them. */
const unanswered = () => new Promise<never>(() => {})
const statement = { bind: () => statement, run: unanswered, all: unanswered, first: unanswered }
const stalledDb = { prepare: () => statement } as unknown as D1Database

const settles = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200))])

// One test: an instance remembers a finished check, so the steps depend on each other.
test("a request cancelled during the migration check does not hold up later requests, and only a new install creates the table", async () => {
  void ensureMigrated(stalledDb, [])

  let created = 0
  const failing = {
    prepare: (sql: string) => ({
      run: async () => (created += sql.startsWith("CREATE") ? 1 : 0),
      all: async () => Promise.reject(new Error("D1 unavailable")),
    }),
  } as unknown as D1Database
  await assert.rejects(ensureMigrated(failing, []), /D1 unavailable/)
  assert.equal(created, 0, "another failure does not create anything")

  let reads = 0
  const newInstall = {
    prepare: (sql: string) => ({
      run: async () => (created += sql.startsWith("CREATE") ? 1 : 0),
      all: async () => (reads++ === 0 ? Promise.reject(new Error("D1_ERROR: no such table: d1_migrations: SQLITE_ERROR")) : { results: [] }),
    }),
  } as unknown as D1Database
  assert.equal(await settles(ensureMigrated(newInstall, [])), true)
  assert.equal(created, 1)
})

test("a request cancelled while loading the signing key does not hold up later requests", async () => {
  resetSigningKeyCache()
  void getSigningKey({ DB: stalledDb } as unknown as Env)
  assert.equal(await settles(getSigningKey({ DB: makeDb().DB } as unknown as Env)), true)
})
