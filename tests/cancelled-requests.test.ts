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

test("a request cancelled during the migration check does not hold up later requests", async () => {
  void ensureMigrated(stalledDb, [])
  assert.equal(await settles(ensureMigrated(makeDb().DB, [])), true)
})

test("a request cancelled while loading the signing key does not hold up later requests", async () => {
  resetSigningKeyCache()
  void getSigningKey({ DB: stalledDb } as unknown as Env)
  assert.equal(await settles(getSigningKey({ DB: makeDb().DB } as unknown as Env)), true)
})
