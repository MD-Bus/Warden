# Webhooks

Warden can call your own URLs when something happens to a licence: it is created, renewed or deleted, its status changes, its grace period starts, it expires, or no site has checked it for a while. Use them to update a billing system, open a support ticket or send the customer a reminder from your own tools (Warden sends no email itself).

Set them up in the dashboard under **Integrations**, *Webhooks*, or through the API (`/api/v1/webhooks`, below). An installation can have up to 10 webhooks, each with its own address and events.

## Tagged app context

The `license` in each event carries `expiry_mode` and `apps`. App status changes and time events also carry `tag` and `app_id`. Expiry and grace events run independently for each app; shared dates can produce separate events when apps have different status rules or grace settings. Separate renewal names the renewed tag; shared renewal uses `tag: null`. Deletion still sends the complete licence before removing it.

## Events

| Event | Sent when | Extra data |
|---|---|---|
| `license.created` | A licence was created, in the dashboard or through the API | |
| `license.updated` | Fields of a licence were changed (including a new key) | `changes`: what changed, as listed in the licence's activity |
| `license.status_changed` | The stored status was changed, by you or by a renewal | `previous_status` |
| `license.renewed` | The expiry date was extended (*Extend*, `/renew`) | `previous_expires_at` |
| `license.grace_period_started` | The expiry date passed and the licence is in its grace period ([statuses.md](statuses.md#grace-period)); still valid until `license.grace_ends_at` | |
| `license.expired` | The expiry rule of the licence's status took effect: checks now report the status it points to, for example Expired | `previous_status`: the status reported before |
| `license.silent` | No site has checked this valid licence for 3 days (the dashboard's *No check in 3+ days* view) | |
| `license.deleted` | A licence was deleted | `license` is the licence as it was |

The last three come from the passing of time. Warden looks for them every 10 minutes, so they arrive up to about 10 minutes after the moment itself. Each is sent once: an expiry again only after the licence has been renewed and has expired again, a *silent* event again only after a new check. Licences that had already expired or gone quiet when you upgraded to 0.4.0 are not reported.

## The request

Each event is a `POST` with a JSON body:

```json
{
  "id": "evt_0mv3wd4z5s2230v97m001",
  "type": "license.expired",
  "created_at": "2026-10-17T00:10:00.000Z",
  "data": {
    "license": { "id": "lic_...", "name": "Harbor Studio website", "key": "WRD-...", "status": "expired", "valid": false, "expires_at": "2026-10-09T23:59:59.999Z", "grace_ends_at": null, "...": "..." },
    "previous_status": "active"
  }
}
```

`data.license` is the licence exactly as the API returns it (see [api.md](api.md#the-licence-object)), at the time of the event.

| Header | Content |
|---|---|
| `X-Warden-Event` | The event type, such as `license.expired` |
| `X-Warden-Event-Id` | The event's `id`. The same event sent to several endpoints, or sent again, has the same id |
| `X-Warden-Delivery` | The id of this delivery (one per event and endpoint) |
| `X-Warden-Signature-Ed25519` | Ed25519 signature of the raw body, base64 |
| `X-Warden-Key-Id` | The signing key's identifier |
| `User-Agent` | `Warden-Webhooks/<version>` |

Answer with any `2xx` status, quickly (within 10 seconds), and do the work afterwards. Redirects are not followed.

## Verifying a request

Requests are signed with the same key as check responses, so you verify them with your installation's public signing key (licence page, *Integration* tab, or `GET /api/v1/signing-key`). Verify the raw body before parsing it, then:

- ignore an `id` you have already processed: an event can arrive more than once (after a timeout, for example);
- ignore a request whose `created_at` is old, if you want to refuse replayed requests.

Node.js:

```js
import { createPublicKey, verify } from "node:crypto"

const WARDEN_PUBLIC_KEY = createPublicKey("-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----") // public_key_pem

export async function handle(request) {
  const body = await request.text()
  const signature = Buffer.from(request.headers.get("x-warden-signature-ed25519") ?? "", "base64")
  if (!verify(null, Buffer.from(body), WARDEN_PUBLIC_KEY, signature)) return new Response("invalid signature", { status: 401 })
  const event = JSON.parse(body)
  // ... skip event.id if already seen, then act on event.type and event.data.license
  return new Response(null, { status: 204 })
}
```

PHP, with `warden_signed()` from [checking.md](checking.md#verifying-the-signature):

```php
$body = file_get_contents( 'php://input' );
if ( ! warden_signed( $_SERVER['HTTP_X_WARDEN_SIGNATURE_ED25519'] ?? '', $body ) ) { http_response_code( 401 ); exit; }
$event = json_decode( $body, true );
// ... skip $event['id'] if already seen, then act on $event['type']
http_response_code( 204 );
```

## Retries

A delivery that fails (no answer within 10 seconds, a connection error, or a status other than 2xx) is retried after 10 minutes, 30 minutes, 2 hours, 6 hours and 24 hours: six attempts over about a day and a half. Then it is marked *failed*. Events of one endpoint can therefore arrive out of order; use `created_at` and the licence's state in `data.license`.

The dashboard shows, for each webhook, the result of the last attempt, how many deliveries are waiting for a retry or have failed, and its recent deliveries with their results. **Retry** sends a waiting or failed delivery again now. Deliveries are kept 30 days.

**Send test event** (in the webhook's menu, or `POST /api/v1/webhooks/{id}/test`) sends a `webhook.test` event to that endpoint at once, whatever events it is subscribed to and even when it is paused, and shows the result. A test event is not retried.

Pausing a webhook (the switch) keeps its settings but stops it: events that happen while it is paused are not recorded for it, and deliveries already waiting for a retry wait until you resume it.

## Addresses

The address must use `https://`. `http://` is accepted only for `localhost`, to test with a receiver on your own machine through `npm run dev`. Put any credentials your endpoint needs in its query string or check the signature instead; addresses with a user name and password are refused.

## API

All under `/api/v1`. Reading needs the `read` scope; creating, changing, deleting, testing and retrying need `full`, since an endpoint receives licence data.

| Method and path | Description |
|---|---|
| `GET /webhooks` | `{ data: [{ id, url, description, events, enabled, created_at, updated_at }], next: null }` |
| `POST /webhooks` | Create: `{ "url": "https://billing.harborstudio.com/hooks/warden", "events": ["license.expired", "license.renewed"], "description": "Billing", "enabled": true }` (201). `409 too_many_webhooks` over 10 |
| `GET /webhooks/{id}` | One webhook |
| `PATCH /webhooks/{id}` | Change `url`, `events`, `description` or `enabled` (only what you send) |
| `DELETE /webhooks/{id}` | Delete it and its deliveries |
| `POST /webhooks/{id}/test` | Send a test event now; returns the delivery |
| `GET /webhooks/{id}/deliveries` | Deliveries, newest first, paged: `{ id, event, event_id, license_id, state, attempts, last_status, last_error, last_attempt_at, next_attempt_at, created_at, delivered_at }`. `state` is `pending` (waiting to be sent or retried), `sending`, `delivered` or `failed` |
| `POST /webhooks/{id}/deliveries/{delivery}/retry` | Send a waiting or failed delivery again now (202) |

Errors: `invalid_url`, `invalid_events`, `invalid_description` or `invalid_enabled` (422), `webhook_not_found`, `delivery_not_found` (404), `cannot_retry` (409, already delivered or being sent).
