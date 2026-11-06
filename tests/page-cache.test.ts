import { test } from "node:test"
import assert from "node:assert/strict"
import { withDashboardHeaders } from "../app/server/headers.server.ts"

const respond = (path: string, method = "GET", status = 200, init: HeadersInit = {}) =>
  withDashboardHeaders(new Response("x", { status, headers: init }), new Request(`https://w.dev${path}`, { method }))

test("a page's data can serve a click for a few seconds, per cookie; the rest stays no-store", () => {
  const data = respond("/licenses.data?_routes=routes%2Flicenses")
  assert.equal(data.headers.get("Cache-Control"), "private, max-age=10")
  assert.match(data.headers.get("Vary")!, /Cookie/)
  assert.equal(respond("/licenses").headers.get("Cache-Control"), "no-store", "documents")
  assert.equal(respond("/licenses.data", "GET", 404).headers.get("Cache-Control"), "no-store", "errors")
  assert.equal(respond("/licenses.data", "GET", 202).headers.get("Cache-Control"), "no-store", "redirects")
  assert.equal(respond("/licenses.data", "POST").headers.get("Cache-Control"), "no-store", "actions")
})

test("every change gives a new revision cookie and keeps the route's own; reads give none", () => {
  const first = respond("/login.data", "POST", 200, { "Set-Cookie": "wd_session=x; Path=/" }).headers.getSetCookie()
  assert.equal(first.length, 2)
  const revision = first.find((c) => c.startsWith("wd_rev="))!
  assert.match(revision, /HttpOnly/)
  assert.notEqual(revision, respond("/x.data", "POST").headers.getSetCookie()[0])
  assert.deepEqual(respond("/licenses.data").headers.getSetCookie(), [])
})
