# Changelog

All notable changes, newest first. Warden follows [semantic versioning](https://semver.org/); while it is pre-1.0, a minor version (0.x.0) can change the API, the check response or the data model, and every such change is listed under **Changed** or **Removed** with what to do. Database migrations run by themselves on the first request after an update. See "Versioning" in [Roadmap.md](Roadmap.md).

**Next, towards 1.0.0** (details in [Roadmap.md](Roadmap.md)):

- **0.6.0, trust**: end-to-end tests on real Cloudflare (GitHub App, private repositories, phone width, CI), backups and export, two-factor sign-in or Cloudflare Access, a complete OpenAPI description checked by tests, independent security review
- **1.0.0**: the check response and the API are frozen

## 0.5.1 (unreleased)

### Fixed

- The licence page again has tabs (Apps, Integration, Sites, Activity) and a summary of check results, next expiry, sites and last check. Restored from 0.4: the details panel (expiry mode, allowed domains, site limit, grace override, public message, external reference, creation date, notes), the download list URL and example request, activity filters, blocked addresses and the update badges per reported version. Each app card shows its check result, expiry, grace period, last check and latest release; the status button shows when a change is being saved and errors appear on the card. The public signing key is on the Integration tab, as before 0.5.0.
- A check without a tag on a licence with several apps registered the domain and counted the site's check once per app. It now registers the domain once, reads the status sets and sites once, and records every app's check in one database batch.
- The page of an app now lists the project apps created from it by migration 0016, so licences that moved to a project app can be found from the original app. The project app's page loads its inherited releases in parallel with the rest.
- `npm run review` seeded the wrong server when port 5180 was already in use. It now stops instead, and `REVIEW_PORT` selects another port.

- Licence and template tag inputs used a pattern that modern browsers could not compile under HTML's Unicode sets rules. Both forms now use the shared server validation pattern with an escaped hyphen, restoring native input validation for tags such as `parent-theme` and `child_theme`. Existing tags, API validation rules and database data are unchanged. No migration is required.

## 0.5.0 (2026-11-03)

One licence key for several tagged apps, with shared or separate expiry dates and reusable licence templates. Migration 0016 runs on the first request. Read the [0.4 to 0.5 upgrade notes](docs/upgrade-notes.md) before updating API clients or attaching a second app to an existing licence.

### Added

- One licence key can cover up to 50 apps. Each attachment has a unique tag, its own selected status, public message and grace override.
- Shared or separate expiry dates; renewal extends every app in shared mode or the selected tag in separate mode.
- Licence templates prefill tags and optional default apps, with required and optional slots. Editing a template leaves existing licences intact.
- Tag-scoped checks, downloads, update selection, reported versions, activity and webhook events. Checks without a tag return separate app results for multi-app licences.
- `npm run review` starts a local instance with demonstration apps, releases, templates and both expiry modes. Credentials stay in process memory.

### Fixed

- The local review command disables Wrangler file logging directly. A null-device log path was interpreted as a directory and caused an additional startup error.

### Changed

- Apps own status definitions, files, release tracks and repository connections. The dashboard no longer creates standalone licences or licence-owned releases.
- Migration 0016 converts existing standalone projects to apps, preserving licence keys, file ids, checksums, R2 keys and download URLs. Custom licence releases become project apps that continue inheriting their original app's releases for statuses they do not override. No stored packages are copied or deleted.
- New licence API requests use `apps: [{ tag, app, status?, expires_at? }]` and `expiry_mode`; their responses contain `apps` rather than a top-level status or validity. Select `tag` on checks and downloads, and send it when changing a status or renewing separate expiry. See [upgrade notes](docs/upgrade-notes.md).
- The old singular `app`, status and licence-owned resource API remains available for legacy requests until 1.0. Migrated licences use the new model; their resource writes return `409 app_owned`. Manage releases and status definitions on their apps.
- Site limits count domains once across all attached apps. Installed versions are recorded per tag. CSV exports have one row per attached app, adding tag and expiry mode.
- Licence list validity means every attached app is valid; invalid includes licences with any invalid app. Expiring and silent views match any app.

## 0.4.1 (2026-10-28)

Bug fixes. Migration 0015 runs by itself on the first request; nothing to change on your side.

### Fixed: dashboard speed

- **Pages took several database round trips one after another.** The queries of each page are now sent together, and the status sets are read once per request instead of once per section: the overview, apps, app, analytics and licence pages wait for about half as many round trips as before.
- **The Worker now uses Smart Placement** (`wrangler.jsonc`, available on every plan): Cloudflare may run it close to the database rather than close to the visitor, which shortens each of those round trips. It takes effect on the next deploy.
- The sidebar marks the page you clicked at once, instead of dimming the previous one until the new page has loaded. Links to apps and licences on the overview and apps pages load their data on hover, as the sidebar and the licence list already did.

### Fixed: releases and webhooks

- **Uploading from the dashboard ignored the track chosen in the upload dialog.** For an app or licence with several tracks, every upload was refused with "choose a track".
- **A version could be published twice in the same track** by uploading it again, by changing a release's version or track, or by restoring a withdrawn release. These now return `409` naming the release that holds the version (`1.4.0` and `v1.4.0` count as the same version); withdraw or delete that release first. Releases already duplicated are left as they are.
- A tag whose build metadata contains a hyphen (`v1.4.0+build-7`) was published on the beta channel; only a pre-release suffix (`v1.4.0-rc.1`) selects beta.
- **Expiry events could be delayed indefinitely.** Each scheduled run looked at the first 500 expired licences, including licences in their grace period that had nothing left to report, so with many of those the expiry of others was never reported. The scan now selects only licences with an event due.
- The scheduled run delivers at most 40 webhooks per run (was 100), under the free plan's limit of 50 outgoing requests per invocation; the rest go out in the next runs.
- Deleting a licence, an app or a repository connection while an import was in progress left the partly written package in R2.
- The overview's "Needs attention" list said "Expires 8 days ago" for a licence in its grace period; it now says "Expired 8 days ago, in grace period".

### Fixed: publishing from GitHub

- **Publishing a large repository stopped the Worker** ("exceeded CPU time limit" or "exceeded memory limit"), on the Workers free plan from a few megabytes. An import used to hold the whole archive in memory twice and hash it chunk by chunk. It now streams the archive into R2 in 10 MB parts, repacks it part by part straight into the release's file and hashes each part once: a 46 MB WordPress archive takes about 0.2 s of CPU instead of being stopped at 1.7 s, with memory flat whatever the size ([docs/repositories.md](docs/repositories.md#limits)).
- **Uploads** (dashboard and API) are stored first, then hashed in 10 MB blocks, instead of hashed chunk by chunk as they arrived, which used most of the CPU time of large uploads.
- **Imports resume after a stop.** Each step of an import records its progress (migration 0015). If Cloudflare stops one midway, the scheduled run (every 10 minutes) continues it from the last part written, rather than the import failing after 15 minutes. An import is failed after 3 runs without progress or 6 hours in progress. While in progress, an import's `detail` names the current step.

### Changed

- A repository archive whose local file headers do not repeat the names of its central directory is refused as unsupported. GitHub archives are not affected.

## 0.4.0 (2026-10-11)

What to change on your side: [docs/upgrade-notes.md](docs/upgrade-notes.md), section "0.3 to 0.4".

### Added: grace period

- A **grace period** keeps a licence valid for some days after its expiry date. During it, checks return `valid: true`, the stored status, `grace_ends_at`, and a reminder in `message` when the licence has no public message of its own; then the expiry rule of its status applies
- Set it on an app (it applies to all of the app's licences, existing and new) or on a licence (overrides its app's; 0 for none). Dashboard: app form and licence form; the licence page shows the grace period and when it ends
- API: `grace_days` on apps and licences (create and edit); licences also return `effective_grace_days` and `grace_ends_at`. New error code `invalid_grace_days`
- Renewing a licence during its grace period extends it from its expiry date, so the grace days used are not given again
- docs/statuses.md, section "Grace period"

### Added: outgoing webhooks

- **Webhooks** (Integrations page, or `/api/v1/webhooks`): Warden calls your URLs on `license.created`, `license.updated`, `license.status_changed`, `license.renewed`, `license.grace_period_started`, `license.expired`, `license.silent` (no check for 3 days) and `license.deleted`, with the licence as the API returns it
- Requests are signed with the installation's Ed25519 key (`X-Warden-Signature-Ed25519`), carry an event id, and are sent right after the change. Failed deliveries are retried after 10 minutes, 30 minutes, 2, 6 and 24 hours, then marked failed
- Dashboard: add, edit, pause and delete webhooks, see the last result and the recent deliveries of each, retry a delivery, send a test event
- API: `GET|POST /webhooks`, `GET|PATCH|DELETE /webhooks/{id}`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/deliveries/{delivery}/retry`
- Migration 0014 (grace periods, webhooks and their deliveries); licences that had already expired or gone quiet before the upgrade are not reported
- docs/webhooks.md

### Changed

- The Cron Trigger runs every 10 minutes instead of once a day, to find time-based events and send due deliveries; the clean-up still runs once a day. Still one Cron Trigger per installation

## 0.3.0 (2026-10-11)

What to change on your side: [docs/upgrade-notes.md](docs/upgrade-notes.md), section "0.2 to 0.3".

### Added: signatures

- **Ed25519 signatures.** Each installation creates a signing key pair on first use (stored in D1). Every answer of the check and download endpoints is signed with it: `X-Warden-Signature-Ed25519` (over the raw body) and `X-Warden-Key-Id`. Sites verify with the public key, which cannot create signatures, so the site's owner can no longer fake a valid answer the way the licence-keyed HMAC allowed. Answers for unknown keys are signed too
- The check response names what it answers: `license_key`, `domain` and `nonce`. A site that sends `nonce` (8 to 64 letters, digits, `.`, `_`, `~`, `-`) with its check and compares it rejects replayed answers
- **Signed releases**: each release carries `signature`, the Ed25519 signature of its SHA-256, in the update offer, the download list and the API, and the downloaded file carries `X-Warden-Release-Signature`, so an updater can verify a package came from your installation before installing it
- The public key is shown on every licence page (*Integration* tab, *Public signing key*) and returned by `GET /api/v1/signing-key` (raw base64 for libsodium, and PEM)
- The download list includes `license_key` and `checked_at`
- docs/checking.md and docs/releases.md: verification in PHP, JavaScript and OpenSSL; docs/upgrade-notes.md: what to change when upgrading from 0.1 and from 0.2

### Changed: API (review before 1.0.0)

- Every list answers `{ data, next }` and pages the same way: `limit` (1 to 100, default 50) and `cursor` (the previous page's `next`). Apps, files, activations, IP blocks and repository imports are now paged; statuses, tracks and GitHub repositories are always complete and answer `next: null`. An unknown cursor answers `422 invalid_cursor`
- `GET /licenses`: the default page size is 50 (was 25), and `cursor` replaces `before`, which is accepted until 1.0.0
- `GET /licenses/{id}/activity`: at most 100 per page (was 200), paged with `cursor`
- Error codes name what was not found: `GET /analytics` answers `license_not_found` or `app_not_found` (was `not_found`), `DELETE /ip-blocks/{id}` answers `ip_block_not_found`. An unsupported method on `/protection` and `/ip-blocks` answers `405 method_not_allowed` instead of 404
- docs/api.md lists every error code and the paging rules
- New denied downloads are logged as "Download denied: …" (was "Download refused: …"); Analytics counts both

### Deprecated

- `X-Warden-Signature` (HMAC-SHA256 keyed with the licence key) is still sent and is removed in 1.0.0. Move site code to `X-Warden-Signature-Ed25519`
- `before` on `GET /licenses`, replaced by `cursor`; removed in 1.0.0

### Removed

- The deprecated aliases announced in 0.2.0: `in_force` and `not_in_force` in `GET /stats` (use `valid`, `invalid`), `licenses_in_force` in apps (use `licenses_valid`), and the licence list addresses `?view=in_force` and `?view=not_in_force` (use `?view=valid`, `?view=invalid`)

## 0.2.0 (2026-10-10)

### Added: dashboard

- Licence and app pages rebuilt around a summary strip (what sites see, expiry, sites, last check; licences, sites, latest release, sites on an old version) and tabs that are kept in the address
- Release manager: upload dialog with drag and drop, version filled in from the file name, channel and release notes; releases listed by version with the latest marked; edit, copy link or checksum, withdraw, restore and delete from a menu
- Versions in use per app, and per site on the licence page with "Update available"
- Overview with a *Needs attention* queue (expiring licences with one-click extend, silent licences), apps with sites on an old version, links from every number to the matching list, and recent activity across all licences
- Licence list: quick views (valid, invalid, expiring, no recent check), filters and sorting kept in the address, clickable rows, expiry shown as "in 5 days", and CSV export of the filtered list (spreadsheet formulas are neutralised)
- Quick search with Ctrl+K or Cmd+K (or `/`): licences by name, customer, key, reference or registered site domain, apps and pages
- Activity tab with filters for changes, checks and downloads
- File actions in the dashboard now report errors instead of failing silently

### Added: releases and updates

- A file with a version is a **release**. Releases have a channel (`stable` or `beta`), public release notes and a SHA-256 checksum computed during the upload, and can be **withdrawn** and restored. A withdrawn release is not listed and its download returns `410`
- The check endpoint accepts `version` (and `channel`) and answers with an `update` block: the newest release the licence can download for that domain and whether it is newer. The version is recorded for the site
- Versions are validated (`1.4.0`, `v2.1`, `2.0.0-beta.1`) and compared by semantic versioning precedence: `2.0.0-rc.1` now ranks below `2.0.0` (before, the suffix was ignored)
- Downloads carry `X-Warden-Sha256`; the download list includes `channel`, `changelog` and `sha256`, accepts `channel=beta`, and no longer includes the file's internal `notes`
- API: upload accepts `channel` and `changelog`; `PATCH` on a file accepts `channel`, `changelog` and `withdrawn`; files return `channel`, `changelog`, `sha256`, `withdrawn`, `withdrawn_at`; activations return `version`; new `GET /apps/{app}/versions`
- Migration 0007 (file channel, release notes, checksum, withdrawal; the version of each site)
- docs/releases.md

### Added: analytics

- **Analytics** page: valid and invalid checks per day, active sites and downloads per day, invalid checks by reason, top licences by checks and top files by downloads, over 7, 30 or 90 days, for every licence, one app or the standalone licences
- Checks of the last 30 days on the overview and on each licence's Activity tab
- Charts can be read by hovering, with the keyboard, or as a table; the charts on the overview, an app and a licence have **View all**, and ranked lists show eight rows with **View all** for up to 100
- API: `GET /analytics` (`days`, `app`, `license`)
- Migration 0008: index on activity (event, at), so each figure reads only checks or only downloads
- docs/analytics.md

### Added: protection

- The **IP address** of every check and download is recorded and shown in the activity log, on each site, in Analytics (top addresses) and in the API (`ip`, `last_ip`); quick search finds licences by address. Addresses are cleared after 90 days
- **Block an IP address or range** from any address in the dashboard, or directly on the new **Protection** page, for 1, 7 or 30 days or permanently, with a reason. Blocked clients receive `403` (`status: blocked`) on checks and downloads before any licence is read; the dashboard and the API are never blocked by address
- **Rate limits**, set in the dashboard: checks per address, checks per licence key, downloads per address and API requests per key (30 to 1,200 per minute, or off). Over a limit: `429` with `Retry-After`, and no verdict on checks
- **Blocking rules**, each with a threshold, a time window and a block duration: invalid licence keys (enabled), invalid checks, licences per IP address, rate limit violations (enabled). An allowlist exempts your own servers
- Analytics shows blocked and rate-limited requests
- API: `GET/POST /ip-blocks`, `DELETE /ip-blocks/{id}`, `GET/PATCH /protection`
- Migrations 0009 (IP addresses, blocklist, rejected request counts) and 0010 (settings, rule-based blocks, rule events)
- docs/protection.md

### Added: release tracks

- A **track** is what a set of licence statuses receives, for example Updates for Active licences, a Final build for Completed ones and a Maintenance version for Suspended ones. Each status belongs to one track of an app or licence at most, so a licence is offered the latest release of exactly one track: the one that serves its current status, even when another track has a higher version
- Releases belong to a track, which sets their statuses and domain check; changing a track applies to all its releases. Versions are unique per track, so two tracks can publish the same number. Files without a version (attachments) keep their own release rule
- A licence of an app can have tracks of its own, which replace the app's tracks for the statuses they serve (a custom build for one client)
- Each track can be fed by its own repository, or several tracks by one repository with **tag prefixes** (`v1.4.0` and `final-v1.4.0`); a tag goes to the track whose prefix it matches most specifically
- Dashboard: the *Releases* tab groups releases by track, with *New track*, edit and delete (moving the releases), the repository of each track, and on a licence page the track it receives now. Uploads and edits choose a track instead of statuses
- "Outdated sites" compares each site with the latest release its own licence is offered
- API: `GET|POST .../tracks`, `GET|PATCH|DELETE .../tracks/{track}` under apps and licences; uploads take `track`; files return `track`; `/apps/{app}/versions` data gains `behind`
- Migration 0013: existing releases are put into tracks (one per distinct release rule, so nobody gains or loses access) and connected repositories are attached to a track

### Added: publishing from a repository

- **Integrations** page: *Create GitHub App* creates a GitHub App for the install through GitHub's app manifest flow (read access to contents and metadata, push events). Install it on accounts or organisations, then pick repositories from a list in the *Connect repository* dialog, private ones included, with no token or webhook to copy. Access tokens are requested per hour with the app's key; one webhook (`/hooks/github-app`) serves every repository, matched by repository id so renames are followed
- Connect a **GitHub repository** to an app or a licence (*Releases* tab). Pushing a version tag (`v1.4.0`) publishes the repository at that tag as a release; a tag with a pre-release suffix goes to the beta channel, other tags are skipped
- The zip from GitHub is **repacked with a fixed top-level folder** (the package folder, by default the repository name), so every release installs into the same folder. Only the zip headers are rewritten
- Without the GitHub App, a repository can still be connected with an optional read-only access token and a webhook of its own, verified with a per-source secret
- Recent tags with their state (in progress, published, skipped, failed) and the reason, **Retry**, **Publish a tag** for existing tags, pause and disconnect. A redelivered webhook publishes a tag once
- Providers and triggers are a registry: further providers (for example GitLab) and triggers (for example a version header in a pushed file) can be added without a schema change
- API: `GET|PUT|DELETE .../tracks/{track}/source`, `POST .../source/regenerate-secret`, `GET|POST .../source/imports`, `POST .../source/imports/{id}/retry`, under apps and licences. Webhook endpoint `POST /hooks/github/{source id}`
- API: `GET /integrations/github`, `GET /integrations/github/repositories`; `PUT .../source` accepts `connection` (`app` or `token`)
- Migrations 0011 (release sources and their imports) and 0012 (GitHub App installation and repository id of a source)
- docs/repositories.md

### Changed: layout

- Dashboard pages with tables and charts (overview, licences, apps, an app, a licence, analytics, protection, API keys) use the full width of the window instead of stopping at 1,152 pixels. Forms and the Integrations page keep a readable width

### Changed: terminology

- The descriptions of the built-in statuses use the same terms: Pending is "not valid yet", Active and Completed are "valid"
- Checks are described as **valid** or **invalid** throughout the dashboard, the API and the docs. The licence list views are now `?view=valid` and `?view=invalid` (`in_force` and `not_in_force` still work in bookmarked addresses)
- API: `GET /stats` returns `valid` and `invalid`, and apps return `licenses_valid`. The earlier fields `in_force`, `not_in_force` and `licenses_in_force` are still returned as deprecated aliases and will be removed before 1.0

### Fixed

- Preview builds of pull requests (Cloudflare Workers Builds) failed with "Your Wrangler configuration is missing a `previews` block": `wrangler.jsonc` now gives previews rate limit counters of their own. Previews have no database by design, and show a notice saying so instead of "Database upgrade failed"
- The OpenAPI description listed only the built-in statuses for `status` filters and bodies, and described `valid` as "true for active and completed"; both now reflect configurable statuses

## 0.1.0 (2026-10-04)

First release: licences, the signed check, statuses, apps, site limits, files with release rules, and the API.

### Fixed (review)

- Downloads of files whose names are not plain ASCII (for example `主题.zip`) failed with an error: the header now carries an ASCII name and the exact UTF-8 name (`filename*`)
- HEAD requests on a download were counted and logged as downloads
- Deleting a status could change the release rule of a file that used a similar status key (`_` was treated as a wildcard); keys are now matched exactly
- The API status filter (`GET /licenses?status=`) built one SQL condition per customised app or licence and would exceed D1's limit of 100 bound values; it now filters in batches
- A malformed percent-encoded domain in `DELETE /licenses/{id}/activations/{domain}` returned an error page instead of `400`
- Two apps created at the same moment with the same identifier returned an error page instead of the duplicate-identifier message
- The sidebar links carried the source text of a function as a CSS class (and caused a hydration warning)
- "Extend expiry" is no longer offered for a licence without an expiry date, which it would have given one

### Security hardening (review)

- Downloads are sent with `Content-Security-Policy: default-src 'none'; sandbox`
- API and check request bodies are read only up to their limit, even without a Content-Length header
- API keys use an unbiased random generator; API responses carry `X-Content-Type-Options: nosniff`
- Oversized login fields are rejected before hashing and count as a failed attempt
- Removed the unused chart component and the `recharts` dependency

- Licences with key and check URL, five statuses, expiry dates, allowed domains, message for the site, private notes
- Signed check responses (`X-Warden-Signature`), activity log, overview
- Extend (30, 90, 365 days) and regenerate key
- API under `/api/v1` with `read`, `manage` and `full` keys: list (filter, search, paging), create (idempotent through `external_ref`), get, patch, status, renew, regenerate key, delete, activity, stats, OpenAPI description at `/api/v1/openapi.json`
- Dashboard page for API keys (shown once, stored as SHA-256 hashes, revocable)
- Status **completed** (paid in full): valid and permanent
- **Files per licence** stored in R2 (binding `FILES`), up to 100 MB, each with a release rule (licence statuses it is available in, optional domain check). Gated `/download/<key>[/<file id>]`, download counters and log, upload, edit and delete in the dashboard and by API
- **Apps**: a product licensed to many customers. Defaults for new licences (status, duration, maximum sites, public message), licences listed per app, files shared by all licences of an app, `latest` version in the download list, API under `/api/v1/apps`
- **Site limit and activations**: a licence can limit the number of sites; sites register on their first check and can be released. New check result `site_limit_reached`
- **Configurable statuses** at app level and licence level. A licence in an app uses its app's statuses; a standalone licence can have its own; everything else uses the built-in defaults (pending, active, completed, suspended, disabled, expired). Statuses can be renamed, changed, reordered, removed and extended. Each has a colour (any hex colour, with a picker and presets), a "sites can run" flag, an expiry rule and a message to sites. Editors on the app and licence pages, and in the create forms (the statuses are stored together with the new app or licence), and `/apps/{app}/statuses`, `/licenses/{id}/statuses` in the API. `GET /stats` now returns `in_force`, `not_in_force` and `by_status`
- Licences have `customer_name` and `customer_email` (`client` was renamed)
- Migrations 0001 (schema), 0002 (API keys, `external_ref`), 0003 (files), 0004 (file release rules, `activity.event`) and 0005 (apps, activations, shared files, customer fields) and 0006 (statuses)
- Docs: README, docs/api.md, docs/apps.md, docs/checking.md, docs/files.md, docs/statuses.md, Security.md, Roadmap.md, Licence.md
