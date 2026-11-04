# API reference

Base URL: `https://<your-worker>/api/v1`. JSON in, JSON out. `/api/v1/openapi.json` is the machine-readable reference and requires no key.

## Authentication

Create a key on **API keys** and send `Authorization: Bearer wk_...` or `X-API-Key: wk_...`. Keys are shown once.

| Scope | Permission |
|---|---|
| read | GET requests |
| manage | Also create, edit, change statuses, renew and release sites |
| full | Also delete licences, apps, tracks and templates, regenerate licence keys, and manage webhooks and protection settings |

Keys act across the installation. They are separate from the licence key used by a customer's site.

## Errors

Errors are `{ "error": { "code": "...", "message": "..." } }`. Branch on `code`.

| HTTP | Meaning and examples |
|---|---|
| 400 | Invalid JSON or malformed path |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `license_not_found`, `app_not_found`, `attachment_not_found`, `template_not_found`, other resource-specific codes, or `not_found` |
| 405 | `method_not_allowed` |
| 409 | `app_owned`, `template_name_taken`, `app_not_empty`, `statuses_in_use`, or a resource conflict |
| 413 | Body too large (JSON bodies are capped at 64 KB) |
| 422 | `shared_expiry`, `invalid_apps`, `invalid_expiry_mode`, `invalid_template`, `invalid_status`, `invalid_expires_at`, `invalid_grace_days`, `tag_required`, or another invalid field |
| 429 | Rate limit; retry after the `Retry-After` header |

`shared_expiry` is returned with 422 when a renewal incorrectly supplies a tag in shared mode. Public check and download errors use their signed public response shapes; see [checking.md](checking.md) and [files.md](files.md).

## Lists and paging

Lists return `{ "data": [...], "next": null }`. Use `limit` (1–100, default 50) and the previous `next` as `cursor`. Short bounded lists, including status sets and tracks, are returned whole. Licence templates support paging. The old `before` alias on the licence list is deprecated until 1.0.

## Creating a licence

```bash
curl -X POST https://<worker>/api/v1/licenses \
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Harbor Studio website","customer_name":"Harbor Studio","domains":["harborstudio.com"],"max_sites":1,"expiry_mode":"shared","expires_at":"2027-11-03","external_ref":"order-1042","apps":[{"tag":"parent-theme","app":"harbor-theme"},{"tag":"child-theme","app":"harbor-studio-child","status":"completed"}]}'
```

`external_ref` is a unique order or invoice reference. Repeating it returns the existing licence with HTTP 200 and `Idempotent-Replayed: true`, preserving its key. A new licence returns 201. Licence details include `name`, `customer_name`, `customer_email`, `domains`, `max_sites`, `message`, `notes`, and `grace_days`.

| Field | Meaning |
|---|---|
| `apps` | 1–50 app attachments |
| `apps[].tag` | Unique tag, matching `[a-z][a-z0-9_-]{0,47}` |
| `apps[].app` | App id or slug; may be omitted if the template slot supplies it |
| `apps[].status` | A status key defined by the app; omitted uses its default |
| `apps[].expires_at` | Separate expiry mode: date, ISO date-time, or null; omitted uses the app's default duration on a new attachment |
| `apps[].grace_days` | null inherits the app; 0 disables grace; otherwise 1–365 days |
| `apps[].message` | App-specific public message; defaults to the app default |
| `expiry_mode` | `shared` (default), or `separate` |
| `expires_at` | Shared expiry date, valid through end of day UTC; ISO date-time or null also accepted |
| `grace_days` | Licence-wide override, 0–365, or null to inherit each attachment/app setting |
| `template` | Template id, create only |

The licence response has `id`, `key`, `check_url`, customer details, `expiry_mode`, `expires_at` (null in separate mode), domains, site limit, messages, timestamps and `apps`. Each app entry includes its attachment `id`, `tag`, `app: { id, slug, name }`, effective `status`, `stored_status`, `valid`, effective `expires_at`, grace fields, message, check count, last check and tagged `check_url`. There is no top-level status or validity for a tagged-app licence.

## Editing and renewing

| Request | Behaviour |
|---|---|
| `GET /licenses` | List. Filters: `q`, `app` (id or slug), `status`, `external_ref` |
| `GET /licenses/{id}` | Read by licence id or key |
| `PATCH /licenses/{id}` | Edit details and attachments |
| `DELETE /licenses/{id}` | Delete the licence, preserving apps and their releases |
| `POST /licenses/{id}/status` | `{ "tag": "parent-theme", "status": "suspended" }` |
| `POST /licenses/{id}/renew` | Shared: `{ "days": 30 }`; separate: `{ "tag": "parent-theme", "days": 30 }`. `until` may replace days |
| `POST /licenses/{id}/regenerate-key` | Regenerate the key for every attached app |
| `GET /licenses/{id}/activity` | Paged events, including `app_id` and `tag` |
| `GET /licenses/{id}/activations` | Registered domains; `versions` maps tags to installed versions |
| `DELETE /licenses/{id}/activations/{domain}` | Free the shared domain slot and clear its version reports |

On PATCH, omitted `apps` preserves attachments. A supplied `apps` array replaces the complete list; omitted tags are removed. Existing tags keep their selected settings when fields are omitted. Changing the app under a tag resets its reported versions and uses the newly selected app's defaults. Dates retained while in shared mode are not effective until separate mode is selected.

Separate mode rejects a top-level non-null `expires_at` or `duration_days`; put dates on the app entries. Switching to separate expiry without an `apps` array copies the shared date. Switching from separate to shared requires explicit `expires_at`, including null for no expiry. Shared renewal rejects `tag`; separate renewal requires it. Completed statuses remain Completed on renewal. Renewal during grace extends from the original date.

## Licence templates

| Request | Behaviour |
|---|---|
| `GET /license-templates` | Paged list |
| `POST /license-templates` | Create (manage) |
| `GET /license-templates/{template}` | Read |
| `PATCH /license-templates/{template}` | Edit future defaults (manage) |
| `DELETE /license-templates/{template}` | Delete, preserving existing licences (full) |

```json
{
  "name": "WordPress website",
  "expiry_mode": "shared",
  "slots": [
    { "tag": "parent-theme", "app": "harbor-theme", "required": true },
    { "tag": "child-theme", "app": null, "required": true },
    { "tag": "booking", "app": null, "required": false }
  ]
}
```

A template has an id, name, description, expiry mode, 1–50 slots, and creation/update timestamps in milliseconds. Required defaults to true. When creating with a template, supply the app for each required slot that has no default. If `apps` is supplied, it is the complete attachment list and must include every required tag. Without `apps`, only slots with default apps are filled, and missing required slots cause 422. Editing a template never changes existing licences.

## Apps, statuses and releases

Apps are referenced by id or slug. Files, tracks, status definitions and repository connections belong to apps.

| Request | Behaviour |
|---|---|
| `GET, POST /apps` | List/create apps |
| `GET, PATCH, DELETE /apps/{app}` | Read/edit/delete; deletion requires no licence, template or inherited-release references |
| `GET /apps/{app}/licenses` | Licences containing this app |
| `GET /apps/{app}/versions` | Installed versions reported for this app's attachments |
| `GET /statuses` | Built-in status definitions |
| `GET /apps/{app}/statuses` | App's effective status definitions |
| `POST /apps/{app}/statuses/customize` | Start customising |
| `POST /apps/{app}/statuses` | Add a status |
| `PATCH, DELETE /apps/{app}/statuses/{key}` | Edit/delete; `move_to` is required if in use |
| `POST /apps/{app}/statuses/order` | `{ "keys": [...] }` |
| `DELETE /apps/{app}/statuses` | Reset to defaults; map unsupported keys with `{ "mapping": {...} }` |
| `GET, PUT /apps/{app}/files` | List/upload; PUT uses raw bytes and Content-Length, max 100 MB |
| `PATCH, DELETE /apps/{app}/files/{fileId}` | Edit metadata/withdraw/delete |
| `GET, POST /apps/{app}/tracks` | List/create release tracks |
| `GET, PATCH, DELETE /apps/{app}/tracks/{track}` | Manage tracks; deletion can use `move_to`. `keep_releases` (1–1000, or `null` for all) is the release limit: setting it deletes the oldest releases beyond it at once and the PATCH response adds `pruned`, the number deleted. New releases are pruned the same way ([releases.md](releases.md#release-limit)) |
| `GET, PUT, DELETE .../tracks/{track}/source` | Repository connection |
| `POST .../tracks/{track}/source/regenerate-secret` | Rotate repository webhook secret |
| `GET, POST .../tracks/{track}/source/imports` | History or import `{ "tag": "v1.4.0" }` |
| `POST .../source/imports/{id}/retry` | Retry an import |

Upload query options: `name`, `version`, `track`, `statuses`, `check_domain`, `channel`, `changelog`, `notes`. Releases take their rule from their track; files without a version keep their own rule. See [files.md](files.md), [releases.md](releases.md), [statuses.md](statuses.md) and [repositories.md](repositories.md).

## Other endpoints

`GET /me` returns the API key identity and scope. `GET /stats` counts licence bundles: valid means every attachment is valid; invalid means any attachment is invalid. `by_status` counts attachments. Expiring and silent counts match any attachment. These summaries ignore domain checks.

`GET /signing-key` returns the public Ed25519 key and its id. See [checking.md](checking.md#verifying-the-signature).

`GET /analytics?app=&license=&days=` returns traffic for 7, 30 or 90 days. App traffic uses the app recorded on each event. See [analytics.md](analytics.md).

`GET, POST /webhooks`, `GET, PATCH, DELETE /webhooks/{id}`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/deliveries/{delivery}/retry`: see [webhooks.md](webhooks.md).

`GET, POST /ip-blocks`, `DELETE /ip-blocks/{id}`, `GET, PATCH /protection`: see [protection.md](protection.md). `GET /integrations/github` and `/integrations/github/repositories` inspect the GitHub connection without returning private credentials.

## Deprecated legacy contract

Until 1.0, a request using the old singular `app` field (or omitting app selection entirely) still creates a legacy licence. Legacy responses retain singular `app`, `status`, `stored_status`, `valid` and grace fields. Legacy licence-owned files, tracks, status sets and repository endpoints retain their earlier behaviour. Prefer the tagged `apps` model for new integrations.

Existing licences migrated by 0016 use the new response contract. Reads of `/licenses/{id}/files`, `/tracks` or `/statuses` require `?tag=` when several apps are attached and select the app resource. Writes return `409 app_owned`; use `/apps/{app}/...`. Upgrading site clients and management integrations is described in [upgrade-notes.md](upgrade-notes.md).
