import { serializeBundle } from "./entitlements.server"
/**
 * Outgoing webhooks: Warden calls your URLs when something happens to a licence (docs/webhooks.md).
 *
 * Events are written to an outbox (webhook_deliveries) in the request that caused them, one row per subscribed
 * endpoint, and sent right after the response; the scheduled run sends what is due and retries failures. Each request
 * is signed with the installation's Ed25519 key, like check responses, so a receiver verifies it with the public key.
 */
import { DELIVERY_RETENTION_DAYS, EVENT_TYPES, MAX_ATTEMPTS, MAX_WEBHOOKS, RETRY_DELAYS_MS, TEST_EVENT, validateWebhookUrl } from "../lib/webhooks"
import { VERSION } from "../lib/version"
import { iso } from "./api-http.server"
import { serializeLicense } from "./api-serializers.server"
import type { License } from "./licenses.server"
import { getSigningKey, signatureHeaders } from "./signing.server"
import { getStatusSetForLicense } from "./statuses.server"
import { newId } from "./util.server"

export type Webhook = {
  id: string
  url: string
  description: string
  /** Comma-separated event types. */
  events: string
  enabled: number
  created_at: number
  updated_at: number
}

export type DeliveryState = "pending" | "sending" | "delivered" | "failed"

export type Delivery = {
  id: string
  webhook_id: string
  event_id: string
  event: string
  license_id: string | null
  payload: string
  state: DeliveryState
  attempts: number
  next_attempt_at: number
  last_status: number | null
  last_error: string
  last_attempt_at: number | null
  created_at: number
  delivered_at: number | null
}

export type WebhookInput = { url: string; description: string; events: string[]; enabled: boolean }

const REQUEST_TIMEOUT_MS = 10_000
/** How long a delivery being sent is reserved, so another run does not send it at the same time. */
const CLAIM_MS = 2 * 60_000
const DAY_MS = 86_400_000

// ---- endpoints --------------------------------------------------------------------

export async function listWebhooks(env: Env): Promise<Webhook[]> {
  return (await env.DB.prepare("SELECT * FROM webhooks ORDER BY created_at").all<Webhook>()).results
}

export function getWebhook(env: Env, id: string): Promise<Webhook | null> {
  return env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first<Webhook>()
}

export const webhookEvents = (w: Webhook) => w.events.split(",").filter(Boolean)

/**
 * Validates an endpoint from a JSON body or a form (both give the same field names). `base` is the endpoint being
 * edited: fields left out keep its values.
 */
export function readWebhookInput(body: Record<string, unknown>, base?: Webhook): { input: WebhookInput } | { error: string; field: string } {
  const rawUrl = "url" in body ? body.url : base?.url
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return { error: "url is required: the address Warden sends events to.", field: "url" }
  const checked = validateWebhookUrl(rawUrl)
  if ("error" in checked) return { error: checked.error, field: "url" }

  const rawDescription = "description" in body ? body.description : (base?.description ?? "")
  if (typeof rawDescription !== "string") return { error: "description must be a string.", field: "description" }

  let events: string[]
  if ("events" in body) {
    const raw = body.events
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null
    if (!list || list.some((e) => typeof e !== "string")) return { error: "events must be an array of event types.", field: "events" }
    events = [...new Set((list as string[]).map((e) => e.trim()).filter(Boolean))]
    const unknown = events.find((e) => !EVENT_TYPES.includes(e))
    if (unknown) return { error: `Unknown event "${unknown}". Events: ${EVENT_TYPES.join(", ")}.`, field: "events" }
  } else events = base ? webhookEvents(base) : []
  if (events.length === 0) return { error: "Choose at least one event.", field: "events" }

  const rawEnabled = "enabled" in body ? body.enabled : base ? base.enabled === 1 : true
  const enabled = rawEnabled === true || rawEnabled === "true" || rawEnabled === "on"
  if (typeof rawEnabled !== "boolean" && !["true", "false", "on"].includes(String(rawEnabled))) return { error: "enabled must be true or false.", field: "enabled" }

  // Events are stored in the catalogue's order, so they read the same everywhere.
  return { input: { url: checked.url, description: rawDescription.trim().slice(0, 200), events: EVENT_TYPES.filter((e) => events.includes(e)), enabled } }
}

export async function createWebhook(env: Env, input: WebhookInput): Promise<{ webhook: Webhook } | { error: string }> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks").first<{ n: number }>()
  if ((count?.n ?? 0) >= MAX_WEBHOOKS) return { error: `An installation can have at most ${MAX_WEBHOOKS} webhooks.` }
  const now = Date.now()
  const id = newId("whk")
  await env.DB.prepare("INSERT INTO webhooks (id, url, description, events, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.url, input.description, input.events.join(","), input.enabled ? 1 : 0, now, now)
    .run()
  return { webhook: (await getWebhook(env, id))! }
}

export async function updateWebhook(env: Env, webhook: Webhook, input: WebhookInput): Promise<Webhook> {
  await env.DB.prepare("UPDATE webhooks SET url = ?, description = ?, events = ?, enabled = ?, updated_at = ? WHERE id = ?")
    .bind(input.url, input.description, input.events.join(","), input.enabled ? 1 : 0, Date.now(), webhook.id)
    .run()
  return (await getWebhook(env, webhook.id))!
}

export async function deleteWebhook(env: Env, webhook: Webhook): Promise<void> {
  await env.DB.batch([env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").bind(webhook.id), env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(webhook.id)])
}

// ---- the public address -------------------------------------------------------------

// Payloads carry the licence's check URL, which needs the address the dashboard and API are reached at. Requests
// record it; the scheduled run, which has no request, reads the last one recorded.
let knownOrigin: string | null = null

/** Records the address the installation is reached at. Written to the database only when it changes. */
export function rememberOrigin(env: Env, ctx: ExecutionContext, origin: string) {
  if (knownOrigin === origin) return
  knownOrigin = origin
  ctx.waitUntil(
    env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('public_origin', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(JSON.stringify(origin), Date.now())
      .run()
      .catch((error) => console.error("Failed to record the public address:", error)),
  )
}

async function publicOrigin(env: Env): Promise<string> {
  if (knownOrigin) return knownOrigin
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'public_origin'").first<{ value: string }>()
  try {
    return row ? (JSON.parse(row.value) as string) : ""
  } catch {
    return ""
  }
}

/** Forgets the recorded address. Only tests need this. */
export function resetOriginCache() {
  knownOrigin = null
}

// ---- events -------------------------------------------------------------------------

// Set when this instance wrote deliveries, so the request that caused them sends them right after its response.
let pendingHere = false

/**
 * Writes an event to the outbox of every enabled endpoint subscribed to it. `data` is the event's payload data.
 * Returns the number of deliveries written.
 */
export async function emitEvent(env: Env, type: string, data: Record<string, unknown>, licenseId: string | null, now = Date.now(), only?: Webhook): Promise<number> {
  const targets = only ? [only] : (await env.DB.prepare("SELECT * FROM webhooks WHERE enabled = 1").all<Webhook>()).results.filter((w) => webhookEvents(w).includes(type))
  if (targets.length === 0) return 0
  const eventId = newId("evt")
  const payload = JSON.stringify({ id: eventId, type, created_at: new Date(now).toISOString(), data })
  await env.DB.batch(
    targets.map((w) =>
      env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event, license_id, payload, state, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(
        newId("dlv"),
        w.id,
        eventId,
        type,
        licenseId,
        payload,
        now,
        now,
      ),
    ),
  )
  pendingHere = true
  return targets.length
}

/**
 * Writes a licence event, with the licence as the API returns it. The change that caused the event is already saved,
 * so a failure here is logged and does not fail the request.
 */
export async function emitLicenseEvent(env: Env, type: string, license: License, extra: Record<string, unknown> = {}, now = Date.now()): Promise<number> {
  try {
    const subscribed = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE enabled = 1 AND instr(',' || events || ',', ?) > 0").bind(`,${type},`).first<{ n: number }>()
    if (!subscribed?.n) return 0
    const set = await getStatusSetForLicense(env, license)
    return await emitEvent(env, type, { license: license.expiry_mode && license.expiry_mode !== "legacy" ? await serializeBundle(env,license,await publicOrigin(env)) : serializeLicense(license, await publicOrigin(env), set), ...extra }, license.id, now)
  } catch (error) {
    console.error(`Failed to write the webhook event ${type}:`, error)
    return 0
  }
}

/** After a request that may have written events: sends them once the response is out. */
export function flushAfterResponse(env: Env, ctx: ExecutionContext) {
  if (!pendingHere) return
  pendingHere = false
  ctx.waitUntil(deliverDue(env).catch((error) => console.error("Webhook delivery failed:", error)))
}

// ---- delivery -----------------------------------------------------------------------

/** Sends the deliveries that are due, oldest first, at most `limit` per run. Returns how many were attempted. */
export async function deliverDue(env: Env, now = Date.now(), limit = 25): Promise<number> {
  const due = (
    await env.DB.prepare(
      `SELECT d.* FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
       WHERE d.state IN ('pending', 'sending') AND d.next_attempt_at <= ? AND w.enabled = 1 ORDER BY d.next_attempt_at, d.id LIMIT ?`,
    )
      .bind(now, limit)
      .all<Delivery>()
  ).results
  let attempted = 0
  await Promise.all(
    due.map(async (row) => {
      // Claim the row: only the run that changes it sends it.
      const claimed = await env.DB.prepare("UPDATE webhook_deliveries SET state = 'sending', next_attempt_at = ? WHERE id = ? AND next_attempt_at = ? AND state IN ('pending', 'sending')")
        .bind(now + CLAIM_MS, row.id, row.next_attempt_at)
        .run()
      if (claimed.meta.changes !== 1) return
      attempted++
      await attempt(env, row, now)
    }),
  )
  return attempted
}

async function attempt(env: Env, row: Delivery, now: number): Promise<Delivery> {
  const webhook = await getWebhook(env, row.webhook_id)
  const result = webhook ? await send(env, webhook, row) : { ok: false, status: null, error: "The webhook was deleted." }
  const attempts = row.attempts + 1
  if (result.ok) {
    await env.DB.prepare("UPDATE webhook_deliveries SET state = 'delivered', attempts = ?, last_status = ?, last_error = '', last_attempt_at = ?, delivered_at = ? WHERE id = ?")
      .bind(attempts, result.status, now, now, row.id)
      .run()
    return { ...row, state: "delivered", attempts, last_status: result.status, last_error: "", last_attempt_at: now, delivered_at: now }
  }
  const failed = attempts >= MAX_ATTEMPTS || row.event === TEST_EVENT
  const next = failed ? now : now + RETRY_DELAYS_MS[attempts - 1]
  const state: DeliveryState = failed ? "failed" : "pending"
  await env.DB.prepare("UPDATE webhook_deliveries SET state = ?, attempts = ?, last_status = ?, last_error = ?, last_attempt_at = ?, next_attempt_at = ? WHERE id = ?")
    .bind(state, attempts, result.status, result.error, now, next, row.id)
    .run()
  return { ...row, state, attempts, last_status: result.status, last_error: result.error, last_attempt_at: now, next_attempt_at: next }
}

async function send(env: Env, webhook: Webhook, row: Delivery): Promise<{ ok: boolean; status: number | null; error: string }> {
  const key = await getSigningKey(env)
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": `Warden-Webhooks/${VERSION}`,
    "x-warden-event": row.event,
    "x-warden-event-id": row.event_id,
    "x-warden-delivery": row.id,
    ...(await signatureHeaders(key, row.payload)),
  }
  try {
    const response = await fetch(webhook.url, { method: "POST", headers, body: row.payload, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    // The body is not used; reading a little of it lets the connection be reused and shows the receiver's error.
    const text = (await response.text().catch(() => "")).slice(0, 200)
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, error: "" }
    const redirect = response.status >= 300 && response.status < 400 ? " Redirects are not followed: use the final address." : ""
    return { ok: false, status: response.status, error: `${redirect.trim()}${text ? `${redirect ? " " : ""}Response: ${text}` : ""}`.trim() }
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    return { ok: false, status: null, error: timeout ? `No answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.` : `Could not connect: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }
  }
}

/** Sends a test event to one endpoint now, whatever its events, and returns the delivery. */
export async function sendTest(env: Env, webhook: Webhook, now = Date.now()): Promise<Delivery> {
  await emitEvent(env, TEST_EVENT, { webhook: { id: webhook.id, url: webhook.url }, message: "This is a test event sent from Warden." }, null, now, webhook)
  pendingHere = false
  const row = (await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? AND event = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(webhook.id, TEST_EVENT).first<Delivery>())!
  await env.DB.prepare("UPDATE webhook_deliveries SET state = 'sending', next_attempt_at = ? WHERE id = ?").bind(now + CLAIM_MS, row.id).run()
  return attempt(env, row, now)
}

/** Queues a delivery again, now. */
export async function retryDelivery(env: Env, webhook: Webhook, deliveryId: string, now = Date.now()): Promise<{ delivery: Delivery } | { error: string; status: number }> {
  const row = await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?").bind(deliveryId, webhook.id).first<Delivery>()
  if (!row) return { error: "No delivery with this id.", status: 404 }
  if (row.state === "delivered" || row.state === "sending") return { error: row.state === "delivered" ? "This delivery succeeded already." : "This delivery is being sent.", status: 409 }
  await env.DB.prepare("UPDATE webhook_deliveries SET state = 'pending', next_attempt_at = ? WHERE id = ?").bind(now, row.id).run()
  pendingHere = true
  return { delivery: { ...row, state: "pending", next_attempt_at: now } }
}

export async function listDeliveries(env: Env, webhookId: string, limit = 100): Promise<Delivery[]> {
  return (await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").bind(webhookId, limit).all<Delivery>()).results
}

/** Counts per endpoint for the dashboard: deliveries waiting to be sent or retried, and failed ones in the retention period. */
export async function deliveryCounts(env: Env): Promise<Record<string, { pending: number; failed: number }>> {
  const counts = (await env.DB.prepare("SELECT webhook_id, state, COUNT(*) AS n FROM webhook_deliveries GROUP BY webhook_id, state").all<{ webhook_id: string; state: DeliveryState; n: number }>()).results
  const out: Record<string, { pending: number; failed: number }> = {}
  for (const c of counts) {
    out[c.webhook_id] ??= { pending: 0, failed: 0 }
    if (c.state === "pending" || c.state === "sending") out[c.webhook_id].pending += c.n
    if (c.state === "failed") out[c.webhook_id].failed += c.n
  }
  return out
}

/** Daily clean-up: deliveries older than the retention period. */
export async function pruneDeliveries(env: Env, now = Date.now()) {
  await env.DB.prepare("DELETE FROM webhook_deliveries WHERE created_at < ? AND state IN ('delivered', 'failed')").bind(now - DELIVERY_RETENTION_DAYS * DAY_MS).run()
}

// ---- API shapes ---------------------------------------------------------------------

export const serializeWebhook = (w: Webhook) => ({
  id: w.id,
  url: w.url,
  description: w.description,
  events: webhookEvents(w),
  enabled: w.enabled === 1,
  created_at: iso(w.created_at),
  updated_at: iso(w.updated_at),
})

export const serializeDelivery = (d: Delivery) => ({
  id: d.id,
  event: d.event,
  event_id: d.event_id,
  license_id: d.license_id,
  state: d.state,
  attempts: d.attempts,
  last_status: d.last_status,
  last_error: d.last_error,
  next_attempt_at: d.state === "pending" ? iso(d.next_attempt_at) : null,
  last_attempt_at: iso(d.last_attempt_at),
  created_at: iso(d.created_at),
  delivered_at: iso(d.delivered_at),
})
