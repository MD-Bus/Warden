# Upgrade notes

What to change on your side when you move to a new version: in site code that checks licences, in code that calls the API, and in bookmarks. Each section lists only the changes that need action; everything else is in [CHANGELOG.md](../CHANGELOG.md).

Upgrade one version at a time in this list, or apply every section between your version and the new one. Your version is shown in the dashboard's account menu and in `/api/v1/openapi.json`.

## Before you upgrade

Export the database:

```bash
npx wrangler d1 export <worker-name>-db --remote --output warden-backup.sql
```

The export contains everything Warden stores, including the private signing key (from 0.3.0) and the GitHub App's key: keep it as private as the dashboard password. D1's Time Travel can also restore the database to any minute of the last 7 days (30 on the paid plan).

Database migrations run by themselves on the first request after the update, and only move forward: to go back to an earlier version, restore the export.

## 0.5 to 0.6

Back up D1 first. Migrations 0017 (release limit per track) and 0018 (channel on reported versions) run by themselves. Site code needs no change: the check response and download links are the same.

- API additions: tracks have `keep_releases` and `PATCH` reports `pruned`; `GET /apps/{app}/versions` adds `up_to_date`, `no_release` and `not_reported`; `GET /licenses/{id}/activations` fills `version` again for licences with one app.
- A track keeps every release until you set a limit. Setting one deletes older releases and their files.
- The first request records the public signing key as `signing_key_public`. From then on Warden does not create a new key by itself: if the private key is removed, checks and downloads fail until it is restored. Starting a new install on a new database still creates a new key.
- Moving the private key to the `WARDEN_SIGNING_KEY` secret is optional: see [checking.md](checking.md#the-signing-key).

## 0.5.1 to 0.5.2

No migration. `download_url` in check and download answers is now a signed link, `/download/t/<token>`, that does not contain the licence key ([files.md](files.md#download-links)). Site code that passes it to its updater as is needs no change. Code that reads the file id or the tag out of that address must read the response's `id` and `tag` fields instead. A link is valid for 7 days: code that stores it longer should run a new check before downloading.

## 0.4 to 0.5

Back up D1 and R2 before upgrading. Migration 0016 is automatic and preserves licence keys, the installation's signing key, file ids, checksums, R2 object keys, repository credentials, import progress and download URLs.

- Existing standalone projects become apps and are attached under `default`. Custom status definitions move to the project app. Existing app licences also receive a `default` attachment.
- A licence with its own releases, tracks or repository connections gets a project app. Its original app continues supplying releases for statuses the project's tracks do not override. Status definitions are copied to the project app and can then be edited independently. The base app cannot be deleted while this inheritance exists. R2 packages are not copied.
- Existing licences start with shared expiry and their original date. Registered domains and versions are preserved. Old single-app check and download URLs continue working without a tag.
- Management API responses for migrated licences now contain `apps`, with per-tag status and validity. Update consumers of singular `app`, `status`, `stored_status`, `valid` and grace fields to read each app entry.
- New integrations create licences with `apps` and `expiry_mode`. Each selected status comes from its app. Status changes require `tag`; separate renewals require it, shared renewals omit it.
- Writes to migrated licence-owned files, tracks and statuses return `409 app_owned`. Manage those resources on their apps. Reads select `?tag=` when multiple apps are attached.
- Before adding a second app to a licence, update its site code to select the intended tag. Without a tag, a multi-app check returns `apps` and has no top-level validity/update. Verify the signed response's tag and app identity as well as key, domain and nonce.
- Templates apply only at creation. Switching separate dates to shared requires an explicit shared date or null. Grace periods still follow the licence override, then attachment override, then app setting.
- CSV exports have one row per app attachment and add `tag` and `expiry_mode`. Historical events retain their migrated app/tag attribution.

The legacy singular request format remains available until 1.0 for older integrations; prefer the tagged model. See [api.md](api.md) and [apps.md](apps.md).

## 0.3 to 0.4

Migration 0014 runs on the first request: it adds grace periods and webhooks. Nothing breaks; there is nothing to change unless you use the features below.

- **Cron Trigger.** It now runs every 10 minutes (`*/10 * * * *` in `wrangler.jsonc`) instead of once a day. A deploy updates it. It is still a single trigger, so it does not count against Cloudflare's per-account limit more than before.
- **Check response.** It has a new field, `grace_ends_at` (`null` unless the licence is in its grace period). While a licence is in its grace period, `valid` is `true` and `message` holds a reminder when the licence has no public message. Site code that shows `message` when it is not empty will show that reminder: decide whether that is what you want.
- **Licences and apps in the API** have new fields: `grace_days` (both), `effective_grace_days` and `grace_ends_at` (licences).
- **Renewals during a grace period** extend from the expiry date, not from the day of the renewal.

## 0.2 to 0.3

No database migration. The signing key is created on the first check, download or dashboard visit after the update.

**Site code (check and download).** Nothing breaks: existing site code keeps working until 1.0.0. Plan the move now:

- Responses are signed with the installation's **Ed25519 key** (`X-Warden-Signature-Ed25519`, `X-Warden-Key-Id`). Copy the public key from a licence page (*Integration* tab) or `GET /api/v1/signing-key`, and verify with it as shown in [checking.md](checking.md#verifying-the-signature). Ship this to every site before 1.0.0.
- `X-Warden-Signature` (HMAC keyed with the licence key) is **deprecated** and removed in 1.0.0.
- Send a `nonce` with each check and compare it, and `license_key`, with the response, to reject replayed answers.
- Releases carry `signature`; the downloaded file carries `X-Warden-Release-Signature`. Verify the package before installing it ([releases.md](releases.md#verifying-a-package)).
- The check response has three new fields, `license_key`, `domain` and `nonce`; the download list has `license_key` and `checked_at`. Code that reads fields by name is not affected.

**API.**

| Before (0.2) | Now (0.3) | What to do |
|---|---|---|
| `GET /stats` returned `in_force` and `not_in_force` | Removed | Read `valid` and `invalid` |
| Apps returned `licenses_in_force` | Removed | Read `licenses_valid` |
| `GET /licenses`: 25 per page by default, `before` to continue | 50 per page by default, `cursor` to continue | Pass `next` as `cursor`. `before` still works until 1.0.0 |
| Apps, files, activations, IP blocks and repository imports were returned whole | Paged: `{ data, next }`, 50 per page by default, at most 100 | Follow `next` with `cursor` until it is `null` |
| `GET /licenses/{id}/activity` took `limit` up to 200 | Up to 100, paged with `cursor` | Follow `next` |
| `GET /analytics` with an unknown licence or app: code `not_found` | `license_not_found` or `app_not_found` | Update error handling that matched `not_found` |
| `DELETE /ip-blocks/{id}` for an unknown block: code `not_found` | `ip_block_not_found` | Same |
| An unsupported method on `/protection` or `/ip-blocks` answered 404 | 405 `method_not_allowed` | None, unless you relied on the 404 |

Lists that are never long (statuses, tracks, GitHub repositories) are returned whole, with `next: null`.

**Dashboard.** The licence list addresses `?view=in_force` and `?view=not_in_force` no longer work: update bookmarks to `?view=valid` and `?view=invalid`. New denied downloads are logged as "Download denied" (earlier entries keep "Download refused"); Analytics counts both.

## 0.1 to 0.2

Migrations 0007 to 0013 run on the first request. Existing releases are put into release tracks (one per distinct release rule), so no licence gains or loses access.

**Site code.**

- Versions are compared by semantic versioning precedence: `2.0.0-rc.1` now ranks below `2.0.0`. Sites on a pre-release are offered the final release.
- The download list no longer includes a file's internal `notes`.
- Checks and downloads can receive `403` (`status: blocked`, the caller's IP address is blocked) or `429` (rate limited, no `valid` field, `Retry-After: 60`). Keep the last known state on both ([checking.md](checking.md)).

**API.**

- `GET /stats` returns `valid` and `invalid`; apps return `licenses_valid`. The earlier names were kept as deprecated aliases in 0.2 and are removed in 0.3.
- Uploads of releases choose a **track** (`track=`); without it, the only track of the app or licence is used, or a track named Releases is created. See [releases.md](releases.md#tracks).
- Files return `track`, `channel`, `changelog`, `sha256`, `withdrawn` and `withdrawn_at`; activations return `version` and `last_ip`; activity returns `ip`.

**Dashboard.** Licence list views are `?view=valid` and `?view=invalid` (the earlier names worked in 0.2 only).
