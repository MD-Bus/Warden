import { VERSION } from "../lib/version"
import { EVENT_TYPES } from "../lib/webhooks"

/** OpenAPI 3.1 description of the API, served at /api/v1/openapi.json. */
export function openApiSpec(origin: string) {
  const idParam = { name: "id", in: "path", required: true, description: "Licence id (lic_...) or the licence key (WRD-...).", schema: { type: "string" } }
  const ok = (description: string, ref = "License") => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } })
  const err = { $ref: "#/components/responses/Error" }
  const body = (schema: object) => ({ required: true, content: { "application/json": { schema } } })
  const secured = [{ bearer: [] }]
  const appParam = { name: "app", in: "path", required: true, description: "App id (app_...) or slug.", schema: { type: "string" } }
  /** Query parameters of a paged list. */
  const pageParams = [
    { name: "limit", in: "query", description: "Items per page", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
    { name: "cursor", in: "query", description: "The `next` value of the previous page. An unknown cursor answers 422 `invalid_cursor`", schema: { type: "string" } },
  ]

  // A repository connected to an app or a licence (docs/repositories.md). Both owners have the same endpoints.
  const sourceDoc = "{ id, track_id, tag_prefix, connection (app | token), provider, repository, trigger, package_folder, has_token, enabled, webhook_url, webhook_secret, created_at, updated_at, last_delivery_at }. webhook_secret is omitted for read keys; the access token is never returned."
  const importDoc = "{ id, tag, version, commit, state (pending | imported | skipped | failed), detail, file_id, started_at, finished_at }"
  const trackDoc = "{ id, name, statuses, check_domain, position, keep_releases (null = every release is kept), releases, source (see the track's /source) | null, created_at, updated_at }"
  const trackParam = { name: "track", in: "path", required: true, description: "Track id (trk_...) or name.", schema: { type: "string" } }
  const trackBody = {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 60 },
      statuses: { description: "Status keys this track serves (array or comma separated). Each status belongs to one track of the app or licence at most." },
      check_domain: { type: "boolean", default: true },
      position: { type: "integer", minimum: 0 },
      keep_releases: { type: ["integer", "null"], minimum: 1, maximum: 1000, description: "Release limit: the track keeps this many releases, the newest by version. Older ones are deleted with their files when a release is added, and at once when the limit is set or lowered (the response of a PATCH then has `pruned`). The newest stable and the newest beta release are never deleted. null keeps every release." },
    },
  }
  // Release tracks of an app or a licence, each with an optional connected repository (docs/releases.md, docs/repositories.md).
  const trackPaths = (prefix: string, param: Record<string, unknown>) => ({
    [`${prefix}/tracks`]: {
      parameters: [param],
      get: {
        summary: "Release tracks. For a licence, also `app_tracks` and `receives`: the track that serves its current status.",
        responses: { 200: { description: `{ data: [${trackDoc}], next: null, conflicts: [{ status, tracks }], app_tracks?, receives? }. Always complete` } },
      },
      post: { summary: "Create a track (permission: manage)", requestBody: body(trackBody), responses: { 201: { description: trackDoc }, 409: { description: "A status already belongs to another track" }, 422: err } },
    },
    [`${prefix}/tracks/{track}`]: {
      parameters: [param, trackParam],
      get: { summary: "A track", responses: { 200: { description: trackDoc }, 404: err } },
      patch: { summary: "Change a track (permission: manage). Its statuses and domain check are applied to its releases. A new `keep_releases` deletes the releases beyond it now: the response adds `pruned`.", requestBody: body(trackBody), responses: { 200: { description: trackDoc }, 409: err, 422: err } },
      delete: {
        summary: "Delete a track (permission: full). Its releases move to `move_to`; refused while it has releases and no `move_to` is given.",
        parameters: [{ name: "move_to", in: "query", schema: { type: "string" } }],
        responses: { 200: { description: "{ deleted: true, id }" }, 409: err, 422: err },
      },
    },
    ...sourcePaths(`${prefix}/tracks/{track}`, [param, trackParam]),
  })
  const sourcePaths = (prefix: string, params: Record<string, unknown>[]) => ({
    [`${prefix}/source`]: {
      parameters: params,
      get: { summary: "The repository connected to the track", responses: { 200: { description: sourceDoc }, 404: { description: "No repository is connected" } } },
      put: {
        summary: "Connect or edit the track's repository (permission: manage). Fields left out keep their value; the repository is checked with the provider first. Availability comes from the track.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connection: { type: "string", enum: ["app", "token"], description: "app: through the install's GitHub App; token: an optional access token and a webhook of its own. Default for a new source: app when the GitHub App is connected and no token is sent." },
                  provider: { type: "string", enum: ["github"], default: "github" },
                  repository: { type: "string", description: "owner/name or its github.com address" },
                  trigger: { type: "string", enum: ["tag"], default: "tag" },
                  package_folder: { type: "string", description: "Top-level folder inside the published zip. Defaults to the repository name." },
                  tag_prefix: { type: "string", description: "Tags of this track start with this text: \"final-\" takes final-v1.4.0. Default: no prefix." },
                  token: { type: "string", description: "Access token for a private repository; empty string removes it" },
                  enabled: { type: "boolean", default: true },
                },
              },
            },
          },
        },
        responses: { 200: { description: sourceDoc }, 201: { description: sourceDoc }, 403: { description: "Permission denied" }, 422: { description: "Invalid settings, or the repository cannot be read" } },
      },
      delete: { summary: "Disconnect the repository (permission: manage). Published releases stay.", responses: { 200: { description: "{ deleted: true, id }" }, 404: { description: "No repository is connected" } } },
    },
    [`${prefix}/source/regenerate-secret`]: { parameters: params, post: { summary: "Replace the webhook secret (permission: manage)", responses: { 200: { description: sourceDoc } } } },
    [`${prefix}/source/imports`]: {
      parameters: params,
      get: { summary: "Tags and their state, newest first", parameters: pageParams, responses: { 200: { description: `{ data: [${importDoc}], next }` } } },
      post: {
        summary: "Publish an existing tag (permission: manage). Runs in the background; poll the list for the result.",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["tag"], properties: { tag: { type: "string", example: "v1.4.0" } } } } } },
        responses: { 202: { description: importDoc } },
      },
    },
    [`${prefix}/source/imports/{importId}/retry`]: {
      parameters: [...params, { name: "importId", in: "path", required: true, schema: { type: "string" } }],
      post: { summary: "Retry a failed or skipped tag (permission: manage)", responses: { 202: { description: importDoc }, 404: { description: "Unknown import" }, 409: { description: "In progress or already published" } } },
    },
  })
  /** Query parameters of an upload that describe the file as a release. */
  const releaseParams = [
    { name: "version", in: "query", description: "Makes the file a release, offered as an update. Numbers separated by dots with an optional suffix: 1.4.0, 2.0.0-beta.1", schema: { type: "string", maxLength: 40 } },
    { name: "channel", in: "query", description: "Beta releases are offered only to sites that check with channel=beta", schema: { enum: ["stable", "beta"], default: "stable" } },
    { name: "changelog", in: "query", description: "Public release notes, returned to sites with the release. Can also be set afterwards with PATCH", schema: { type: "string", maxLength: 10000 } },
    { name: "notes", in: "query", description: "Internal notes, never sent to sites", schema: { type: "string" } },
  ]

  /** The endpoints that manage the statuses of an app or of a licence. */
  const statusPaths = (base: string, params: object[], owner: string) => ({
    [base]: {
      parameters: params,
      get: { summary: `The statuses that apply to the ${owner}`, description: "`custom` is true when the " + owner + " has statuses of its own. `source` is `" + owner + "`, `app` or `default`: where the statuses in effect come from.", responses: { 200: { description: "{ custom, source, data: Status[], next: null }. Always complete" }, 404: err } },
      post: { summary: `Add a status to the ${owner}'s own statuses (permission: manage). Customize them first`, requestBody: body({ $ref: "#/components/schemas/StatusInput" }), responses: { 201: { description: "The status" }, 403: err, 409: err, 422: err } },
      delete: {
        summary: `Remove the ${owner}'s own statuses so it uses the inherited statuses again (permission: full)`,
        description: "Licences that use a status the inherited statuses lack must be mapped: send `{ \"mapping\": { \"custom_key\": \"inherited_key\" } }`.",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { mapping: { type: "object", additionalProperties: { type: "string" } } } } } } },
        responses: { 200: { description: "{ custom: false, data: Status[] }" }, 403: err, 409: err },
      },
    },
    [`${base}/customize`]: {
      parameters: params,
      post: { summary: `Give the ${owner} its own statuses, starting as a copy of the ones it uses now (permission: manage)`, responses: { 201: { description: "{ custom: true, data: Status[] }" }, 403: err, 409: err } },
    },
    [`${base}/order`]: {
      parameters: params,
      post: { summary: `Reorder the ${owner}'s own statuses (permission: manage)`, requestBody: body({ type: "object", required: ["keys"], properties: { keys: { type: "array", items: { type: "string" } } } }), responses: { 200: { description: "{ data: Status[] }" }, 403: err, 409: err, 422: err } },
    },
    [`${base}/{key}`]: {
      parameters: [...params, { name: "key", in: "path", required: true, schema: { type: "string" } }],
      patch: { summary: `Change a status of the ${owner}'s own statuses (permission: manage). The key cannot be changed`, requestBody: body({ $ref: "#/components/schemas/StatusInput" }), responses: { 200: { description: "The status" }, 403: err, 404: err, 409: err, 422: err } },
      delete: {
        summary: `Delete a status of the ${owner}'s own statuses (permission: full)`,
        description: "Licences that use the status move to `move_to`, which is required when any licence uses it. File release rules and the app default that name it are updated.",
        parameters: [{ name: "move_to", in: "query", description: "Key of the status the licences move to", schema: { type: "string" } }],
        responses: { 200: { description: "{ data: Status[] }" }, 403: err, 404: err, 409: err },
      },
    },
  })

  return {
    openapi: "3.1.0",
    info: {
      title: "Warden API",
      version: VERSION,
      description:
        "Create and manage licences from your own code. Authenticate with an API key created in the dashboard (API keys page): `Authorization: Bearer wk_...`. Scopes: `read` (GET), `manage` (also create, edit, status, renew), `full` (also delete and regenerate keys). Each key is rate limited (600 requests per minute by default); over the limit the API answers `429` with `Retry-After`. Errors are `{ error: { code, message } }`; branch on `code`. Lists answer `{ data, next }`: pass `next` as `cursor` for the following page (`limit` 1 to 100, default 50); `next` is null on the last page, and always null for lists that are never long (statuses, tracks, repositories).",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: secured,
    paths: {
      "/license-templates": {
        get: { summary: "Licence templates", parameters: pageParams, responses: { 200: { description: "{ data: LicenseTemplate[], next }", content: { "application/json": { schema: { type:"object", properties:{data:{type:"array",items:{$ref:"#/components/schemas/LicenseTemplate"}},next:{type:["string","null"]}} } } } } } },
        post: { summary: "Create a licence template (manage)", requestBody: body({$ref:"#/components/schemas/LicenseTemplateInput"}), responses:{201:ok("Template","LicenseTemplate"),403:err,409:err,422:err} },
      },
      "/license-templates/{template}": {
        parameters:[{name:"template",in:"path",required:true,schema:{type:"string"}}],
        get:{summary:"A licence template",responses:{200:ok("Template","LicenseTemplate"),404:err}},
        patch:{summary:"Edit a template for future licences (manage)",requestBody:body({$ref:"#/components/schemas/LicenseTemplateInput"}),responses:{200:ok("Template","LicenseTemplate"),403:err,404:err,409:err,422:err}},
        delete:{summary:"Delete a template, preserving existing licences (full)",responses:{200:{description:"{ deleted: true, id }"},403:err,404:err}},
      },
      "/check/{key}": {
        servers:[{url:origin}], security:[], parameters:[{name:"key",in:"path",required:true,schema:{type:"string"}},{name:"tag",in:"query",schema:{type:"string"},description:"App attachment tag. Omit to check all apps. A multi-app response has apps and no top-level valid, status or update."},{name:"domain",in:"query",schema:{type:"string"}},{name:"version",in:"query",schema:{type:"string"},description:"Requires tag when the licence has several apps."},{name:"channel",in:"query",schema:{enum:["stable","beta"]}},{name:"nonce",in:"query",schema:{type:"string",pattern:"^[A-Za-z0-9._~-]{8,64}$"}}],
        get:{summary:"Signed licence check by tag or for every app",responses:{200:{description:"A CheckResult, or { license_key, domain, nonce, checked_at, apps: CheckResult[] }. JSON is signed with X-Warden-Signature-Ed25519 over the raw body; X-Warden-Key-Id identifies the key."},403:err,404:err,422:err,429:err}},
        post:{summary:"Check with JSON fields; versions can map each tag to its installed version",requestBody:body({type:"object",properties:{tag:{type:"string"},domain:{type:"string"},nonce:{type:"string"},version:{type:"string"},channel:{enum:["stable","beta"]},versions:{type:"object",additionalProperties:{type:"string"}}}}),responses:{200:{description:"Same signed response as GET"},404:err,422:err,429:err}},
      },
      "/download/{key}": {
        servers:[{url:origin}],security:[],parameters:[{name:"key",in:"path",required:true,schema:{type:"string"}},{name:"tag",in:"query",schema:{type:"string"}},{name:"domain",in:"query",schema:{type:"string"}},{name:"channel",in:"query",schema:{enum:["stable","beta"]}}],
        get:{summary:"Signed download list, grouped by app when tag is omitted",responses:{200:{description:"Selected app: { tag, app, valid, status, latest, files }. Several apps: { license_key, checked_at, apps: [...] }. Each file has a download_url: a signed link (/download/t/{token}) for that file and tag, valid 7 days, without the licence key."},404:err,429:err}},
      },
      "/download/t/{token}": {
        servers:[{url:origin}],security:[],parameters:[{name:"token",in:"path",required:true,schema:{type:"string"}},{name:"domain",in:"query",schema:{type:"string"},description:"Used only when the link carries no domain."}],
        get:{summary:"Download through a signed link from a check or download list",responses:{200:{description:"File bytes with X-Warden-Sha256 and X-Warden-Release-Signature"},403:err,404:err,410:{description:"The link expired or the key was regenerated (status link_expired), or the release was withdrawn"},429:err}},
      },
      "/download/{key}/{fileId}": {
        servers:[{url:origin}],security:[],parameters:[{name:"key",in:"path",required:true,schema:{type:"string"}},{name:"fileId",in:"path",required:true,schema:{type:"string"}},{name:"tag",in:"query",schema:{type:"string"}},{name:"domain",in:"query",schema:{type:"string"}}],
        get:{summary:"Download after evaluating the selected app's status and domain rules",responses:{200:{description:"File bytes with X-Warden-Sha256 and X-Warden-Release-Signature"},403:err,404:err,410:err,429:err}},
      },
      "/me": { get: { summary: "Who the key belongs to", responses: { 200: { description: "Key name and scope" }, 401: err } } },
      "/stats": { get: { summary: "Licence statistics", responses: { 200: { description: "{ total, valid, invalid, expiring_within_14_days, not_checked_for_3_days, by_status }" }, 401: err } } },
      "/signing-key": {
        get: {
          summary: "The install's public signing key",
          description:
            "Ed25519 public key that signs check responses and download responses (`X-Warden-Signature-Ed25519` over the raw body, with `X-Warden-Key-Id`) and releases (`signature` over the 64 hex characters of `sha256`). Put it in the site's code. `public_key` is the raw 32-byte key in base64 (libsodium); `public_key_pem` is the same key as SubjectPublicKeyInfo PEM (OpenSSL, Node.js, WebCrypto). Created on first use; it does not change.",
          responses: { 200: { description: "{ algorithm: \"Ed25519\", key_id, public_key, public_key_pem, created_at }" }, 401: err },
        },
      },
      "/webhooks": {
        get: { summary: "Outgoing webhooks (docs/webhooks.md)", responses: { 200: { description: "{ data: Webhook[], next: null }" }, 401: err } },
        post: {
          summary: "Create a webhook (permission: full)",
          description: "Warden sends a signed POST (X-Warden-Signature-Ed25519 over the body, verified with GET /signing-key) to `url` for each event in `events`, retrying failures for about a day. At most 10 webhooks.",
          requestBody: body({ $ref: "#/components/schemas/WebhookInput" }),
          responses: { 201: { description: "The webhook" }, 403: err, 409: { description: "`too_many_webhooks`" }, 422: err },
        },
      },
      "/webhooks/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "A webhook", responses: { 200: { description: "{ id, url, description, events, enabled, created_at, updated_at }" }, 404: err } },
        patch: { summary: "Change a webhook (permission: full). Only the fields sent", requestBody: body({ $ref: "#/components/schemas/WebhookInput" }), responses: { 200: { description: "The webhook" }, 403: err, 404: err, 422: err } },
        delete: { summary: "Delete a webhook and its deliveries (permission: full)", responses: { 200: { description: "{ deleted: true, id }" }, 403: err, 404: err } },
      },
      "/webhooks/{id}/test": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Send a webhook.test event to this webhook now, even when paused (permission: full)", responses: { 200: { description: "The delivery, with its result" }, 403: err, 404: err } },
      },
      "/webhooks/{id}/deliveries": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          summary: "Deliveries of a webhook, newest first (kept 30 days)",
          parameters: pageParams,
          responses: { 200: { description: "{ data: [{ id, event, event_id, license_id, state (pending | sending | delivered | failed), attempts, last_status, last_error, last_attempt_at, next_attempt_at, created_at, delivered_at }], next }" }, 404: err },
        },
      },
      "/webhooks/{id}/deliveries/{delivery}/retry": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "delivery", in: "path", required: true, schema: { type: "string" } }],
        post: { summary: "Send a waiting or failed delivery again now (permission: full)", responses: { 202: { description: "The delivery" }, 404: err, 409: { description: "`cannot_retry`: delivered already, or being sent" } } },
      },
      "/ip-blocks": {
        get: {
          summary: "Blocked IP addresses and ranges",
          parameters: pageParams,
          responses: { 200: { description: "{ next, data: [{ id, ip, source, reason, created_at, expires_at, hits, last_hit_at }] }. `ip` is an address or a CIDR range; `source` is manual or auto (created by a protection rule); `hits` is approximate." }, 401: err },
        },
        post: {
          summary: "Block an IP address or range (permission: manage)",
          description: "Checks and downloads from the address receive 403 before any licence is read. The dashboard and the API are not affected. Takes effect within 30 seconds.",
          requestBody: body({
            type: "object",
            required: ["ip"],
            properties: {
              ip: { type: "string", description: "IPv4 or IPv6 address, or a CIDR range (at most /8 for IPv4, /16 for IPv6)", example: "203.0.113.0/24" },
              reason: { type: "string", maxLength: 200, description: "Internal note" },
              expires_at: { type: ["string", "null"], format: "date-time", description: "End of the block; null or absent for a permanent block" },
            },
          }),
          responses: { 201: { description: "The block" }, 403: err, 409: { description: "Already blocked (`already_blocked`)" }, 422: err },
        },
      },
      "/protection": {
        get: {
          summary: "Protection settings: rate limits, automatic blocking rules, never-block list",
          responses: { 200: { description: "{ limits: { check_ip, check_key, download_ip, api_key }, rules: { invalid_keys, invalid_checks, licenses_per_ip, rate_limit_violations: { enabled, count, minutes, block_hours } }, never_block: string[] }" }, 401: err },
        },
        patch: {
          summary: "Change protection settings (permission: full)",
          description:
            "Send only what changes. Limits are requests per minute: 0 (off), 30, 60, 120, 300, 600 or 1200. Rules: `count` 2 to 10000, `minutes` 5, 10, 30, 60, 360 or 1440, `block_hours` 1, 6, 24, 168, 720 or 0 (permanent). `never_block` (the allowlist) replaces the whole list. Changes apply within 30 seconds.",
          requestBody: body({ type: "object", example: { limits: { check_ip: 300 }, rules: { invalid_checks: { enabled: true, count: 100 } } } }),
          responses: { 200: { description: "The complete settings" }, 403: err, 422: err },
        },
      },
      "/ip-blocks/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        delete: { summary: "Remove a block (permission: manage)", responses: { 200: { description: "{ deleted: true, id }" }, 403: err, 404: err } },
      },
      "/analytics": {
        get: {
          summary: "Traffic analytics",
          description:
            "Checks and downloads per UTC day over a period, with totals, invalid checks by reason, and top licences, files and IP addresses. Validity is evaluated against the current status configuration. Check history is retained for 90 days.",
          parameters: [
            { name: "days", in: "query", description: "Length of the period, ending today", schema: { type: "integer", enum: [7, 30, 90], default: 30 } },
            { name: "app", in: "query", description: "Only the licences of this app (id or slug), or `none` for standalone licences", schema: { type: "string" } },
            { name: "license", in: "query", description: "Only this licence (id or key). Takes precedence over `app`.", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "{ days, from, to, series: [{ date, valid, invalid, sites, downloads }], totals: { checks, valid, invalid, sites, new_sites, downloads, denied_downloads, blocked, rate_limited }, reasons: [{ key, label, checks }], licenses: [{ id, name, app_name, checks, invalid, last_check_at }], files: [{ name, downloads }], ips: [{ ip, checks, invalid, downloads, licenses, blocked }] }. Lists hold at most 100 rows. `blocked` and `rate_limited` count requests rejected before licence validation (approximate); they are null when the report is filtered" },
            401: err,
            404: err,
            422: err,
          },
        },
      },
      "/licenses": {
        get: {
          summary: "List licences",
          description: "Newest first. Pass the `next` value of the previous page as `cursor` to continue. `before` is the earlier name of `cursor`, accepted until 1.0.0.",
          parameters: [
            { name: "status", in: "query", description: "A status key, matched on the status reported to sites (an expiry rule that has triggered counts)", schema: { type: "string", example: "active" } },
            { name: "q", in: "query", description: "Search name, customer, key, domains, external_ref and app name", schema: { type: "string" } },
            { name: "app", in: "query", description: "Only licences of this app (id or slug)", schema: { type: "string" } },
            { name: "external_ref", in: "query", schema: { type: "string" } },
            ...pageParams,
            { name: "before", in: "query", deprecated: true, description: "Earlier name of `cursor`, removed in 1.0.0", schema: { type: "string" } },
          ],
          responses: { 200: { description: "A page of licences: { data: License[], next: string | null }" }, 401: err },
        },
        post: {
          summary: "Create a licence",
          description: "With `external_ref`, creating twice returns the first licence (HTTP 200, header `Idempotent-Replayed: true`) instead of a duplicate, so retries and repeated webhooks are safe.",
          requestBody: body({ $ref: "#/components/schemas/LicenseInput" }),
          responses: { 201: ok("Created"), 200: ok("Already existed (same external_ref)"), 401: err, 403: err, 422: err },
        },
      },
      "/licenses/{id}": {
        parameters: [idParam],
        get: { summary: "Get a licence", responses: { 200: ok("The licence"), 401: err, 404: err } },
        patch: { summary: "Edit a licence (only the fields you send)", requestBody: body({ $ref: "#/components/schemas/LicenseInput" }), responses: { 200: ok("Updated"), 401: err, 403: err, 404: err, 422: err } },
        delete: { summary: "Delete a licence and its history (scope full)", responses: { 200: { description: "{ deleted: true, id }" }, 401: err, 403: err, 404: err } },
      },
      "/licenses/{id}/status": {
        parameters: [idParam],
        post: { summary: "Set the status", requestBody: body({ type: "object", required: ["status"], properties: { tag:{type:"string",description:"Required for tagged-app licences."}, status: { type: "string", description: "A status key of the statuses that apply to the licence" } } }), responses: { 200: ok("Updated"), 403: err, 404: err, 422: err } },
      },
      "/licenses/{id}/renew": {
        parameters: [idParam],
        post: {
          summary: "Renew",
          description: "`days` moves the end date forward (from the current end date, or from today if it has passed). `until` sets the end date. A licence that had expired becomes active again; a suspended or disabled one keeps its status.",
          requestBody: body({ type: "object", properties: { tag:{type:"string",description:"Required in separate expiry mode; omit in shared mode."}, days: { type: "integer", minimum: 1, maximum: 3650 }, until: { type: "string", description: "YYYY-MM-DD or ISO date-time, in the future" } } }),
          responses: { 200: ok("Renewed"), 403: err, 404: err, 422: err },
        },
      },
      "/licenses/{id}/regenerate-key": { parameters: [idParam], post: { summary: "Replace the key (scope full). The old key and check URL stop working.", responses: { 200: ok("Updated, with the new key"), 403: err, 404: err } } },
      "/licenses/{id}/files": {
        parameters: [idParam],
        get: { summary: "List the files attached to a licence, newest first", parameters: pageParams, responses: { 200: { description: "{ data: File[], next }" }, 404: err } },
        put: {
          summary: "Upload a file (permission: manage)",
          description:
            "The request body is the raw file, not multipart, and the request needs a Content-Length header. Maximum size 100 MB. The file can be downloaded while the licence status is one of `statuses`.",
          parameters: [
            { name: "name", in: "query", required: true, description: "Download file name", schema: { type: "string" } },
            { name: "track", in: "query", description: "Releases (with a version): the track, by id or name. Without it: the only track, or a new track Releases when there is none.", schema: { type: "string" } },
            { name: "statuses", in: "query", description: "Attachments: the statuses in which the file is available. Releases without `track`: picks the track with exactly these statuses, or creates one.", schema: { type: "string", default: "active,completed", example: "active,completed" } },
            { name: "check_domain", in: "query", description: "Require the requesting domain to match the licence's allowed domains", schema: { type: "boolean", default: true } },
            ...releaseParams,
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: { 201: ok("The file", "File"), 403: err, 413: err, 422: err, 501: err },
        },
      },
      "/licenses/{id}/files/{fileId}": {
        parameters: [idParam, { name: "fileId", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          summary: "Update a file's release rule or metadata (permission: manage)",
          requestBody: body({ $ref: "#/components/schemas/FileChanges" }),
          responses: { 200: ok("The file", "File"), 403: err, 404: err, 422: err },
        },
        delete: { summary: "Delete a file (permission: manage)", responses: { 200: { description: "{ deleted: true, id }" }, 404: err } },
      },
      "/licenses/{id}/activations": {
        parameters: [idParam],
        get: { summary: "Sites (domains) registered for the licence", parameters: pageParams, responses: { 200: { description: "{ max_sites, data: [{ domain, version, first_seen_at, last_seen_at, check_count, last_ip }], next }" }, 404: err } },
      },
      "/licenses/{id}/activations/{domain}": {
        parameters: [idParam, { name: "domain", in: "path", required: true, schema: { type: "string" } }],
        delete: { summary: "Release a site to free its slot (permission: manage)", responses: { 200: { description: "{ released: true, domain }" }, 403: err, 404: err } },
      },
      "/statuses": {
        get: { summary: "The built-in default statuses (read only)", description: "What an app or a licence uses until its statuses are customised. Customise them per app (`/apps/{app}/statuses`) or per licence (`/licenses/{id}/statuses`).", responses: { 200: { description: "{ data: Status[], next: null }" }, 401: err } },
      },
      ...statusPaths("/apps/{app}/statuses", [appParam], "app"),
      ...statusPaths("/licenses/{id}/statuses", [idParam], "licence"),
      "/apps": {
        get: { summary: "List apps with their statistics, by name", parameters: pageParams, responses: { 200: { description: "{ data: App[], next }. App: { id, name, slug, description, default_*, notes, licenses, licenses_valid, sites, files, latest_version, created_at, updated_at }" }, 401: err } },
        post: {
          summary: "Create an app (permission: manage)",
          requestBody: body({ $ref: "#/components/schemas/AppInput" }),
          responses: { 201: { description: "The app" }, 403: err, 409: err, 422: err },
        },
      },
      "/apps/{app}": {
        parameters: [appParam],
        get: { summary: "Get an app", responses: { 200: { description: "The app" }, 404: err } },
        patch: { summary: "Update an app (permission: manage)", requestBody: body({ $ref: "#/components/schemas/AppInput" }), responses: { 200: { description: "The app" }, 403: err, 404: err, 409: err, 422: err } },
        delete: { summary: "Delete an app and its files (permission: full). Refused while the app has licences", responses: { 200: { description: "{ deleted: true, id }" }, 403: err, 404: err, 409: err } },
      },
      "/apps/{app}/licenses": {
        parameters: [appParam],
        get: { summary: "List the licences of an app", description: "Same filters and paging as GET /licenses.", responses: { 200: { description: "{ data: License[], next }" }, 404: err } },
        post: { summary: "Issue a licence under the app (permission: manage)", description: "Same as POST /licenses with this app. The app's defaults apply to every field not sent.", requestBody: body({ $ref: "#/components/schemas/LicenseInput" }), responses: { 201: ok("Created"), 200: ok("Already existed (same external_ref)"), 403: err, 404: err, 422: err } },
      },
      "/apps/{app}/files": {
        parameters: [appParam],
        get: { summary: "List the files shared by the app, newest first", parameters: pageParams, responses: { 200: { description: "{ data: File[], next }" }, 404: err } },
        put: {
          summary: "Upload a file shared by every licence of the app (permission: manage)",
          description: "Same body and query parameters as PUT /licenses/{id}/files. Licences of the app see the file in their download list, subject to the file's release statuses.",
          parameters: [
            { name: "name", in: "query", required: true, schema: { type: "string" } },
            { name: "track", in: "query", description: "Releases: the track, by id or name.", schema: { type: "string" } },
            { name: "statuses", in: "query", description: "Attachments: availability. Releases without `track`: picks or creates a track.", schema: { type: "string", default: "active,completed" } },
            { name: "check_domain", in: "query", schema: { type: "boolean", default: true } },
            ...releaseParams,
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: { 201: ok("The file", "File"), 403: err, 413: err, 422: err, 501: err },
        },
      },
      "/integrations/github": {
        get: {
          summary: "The install's GitHub App (created in the dashboard under Integrations)",
          responses: { 200: { description: "{ connected, app: { app_id, slug, name, owner, html_url, created_at, last_delivery_at } | null, installations: [{ id, account, account_type, repository_selection, html_url }] }" }, 502: err },
        },
      },
      "/integrations/github/repositories": {
        get: { summary: "Repositories the GitHub App can access", responses: { 200: { description: "{ data: [{ id, full_name, private, account }], next: null }" }, 404: err, 502: err } },
      },
      ...trackPaths("/apps/{app}", appParam),
      ...trackPaths("/licenses/{id}", idParam),
      "/apps/{app}/versions": {
        parameters: [appParam],
        get: {
          summary: "Versions the sites of the app run",
          description: "Built from the version each site reports with its check (`?version=`). `outdated` counts sites on a version older than `latest_version`, the highest stable release.",
          responses: { 200: { description: "{ latest_version, sites, outdated, data: [{ version, sites, outdated }] }" }, 404: err },
        },
      },
      "/apps/{app}/files/{fileId}": {
        parameters: [appParam, { name: "fileId", in: "path", required: true, schema: { type: "string" } }],
        patch: { summary: "Update a shared file's release rule or metadata (permission: manage)", requestBody: body({ $ref: "#/components/schemas/FileChanges" }), responses: { 200: ok("The file", "File"), 403: err, 404: err, 422: err } },
        delete: { summary: "Delete a shared file (permission: manage)", responses: { 200: { description: "{ deleted: true, id }" }, 404: err } },
      },
      "/licenses/{id}/activity": {
        parameters: [idParam],
        get: {
          summary: "Checks, downloads and changes, newest first",
          parameters: pageParams,
          responses: { 200: { description: "{ data: [{ at, event, status, domain, ip, detail }], next }. `ip` is the caller of a check or a download (null for changes, and after 90 days). Checks are kept 90 days." }, 404: err },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "API key, wk_..." } },
      responses: { Error: { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } } } },
      schemas: {
        LicenseAppInput:{type:"object",required:["tag"],properties:{tag:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,47}$"},app:{type:"string",description:"App id or slug. Required unless supplied by this template slot."},status:{type:"string",description:"Selected status from the app's definitions; defaults to the app default."},expires_at:{type:["string","null"],description:"Used in separate expiry mode; null means no expiry."},grace_days:{type:["integer","null"],minimum:0,maximum:365},message:{type:"string",maxLength:300}}},
        LicenseApp:{type:"object",properties:{id:{type:"string"},tag:{type:"string"},app:{type:"object",properties:{id:{type:"string"},slug:{type:"string"},name:{type:"string"}}},status:{type:"string"},stored_status:{type:"string"},valid:{type:"boolean"},expires_at:{type:["string","null"]},grace_days:{type:["integer","null"]},effective_grace_days:{type:"integer"},grace_ends_at:{type:["string","null"]},message:{type:"string"},last_check_at:{type:["string","null"]},check_count:{type:"integer"},check_url:{type:"string"}}},
        LicenseTemplateInput:{type:"object",properties:{name:{type:"string",minLength:1,maxLength:80},description:{type:"string",maxLength:500},expiry_mode:{enum:["shared","separate"]},slots:{type:"array",minItems:1,maxItems:50,items:{type:"object",required:["tag"],properties:{tag:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,47}$"},app:{type:["string","null"]},required:{type:"boolean",default:true}}}}}},
        LicenseTemplate:{allOf:[{$ref:"#/components/schemas/LicenseTemplateInput"},{type:"object",properties:{id:{type:"string"},created_at:{type:"integer"},updated_at:{type:"integer"}}}]},
        LicenseInput: {
          type: "object",
          properties: {
            apps:{type:"array",minItems:1,maxItems:50,description:"Complete attachment list on PATCH; omitted preserves the list. Removing a tag revokes its access and removes its reported versions.",items:{$ref:"#/components/schemas/LicenseAppInput"}},
            expiry_mode:{enum:["shared","separate"],description:"One licence date, or independent app dates. Switching to shared requires an explicit expires_at, including null for no expiry."},
            template:{type:"string",description:"Template id, create only. Required tags must have an app; default apps may be omitted from each submitted slot."},
            name: { type: "string", maxLength: 120 },
            customer_name: { type: "string", maxLength: 120 },
            customer_email: { type: "string", maxLength: 200 },
            app: { deprecated:true, type: ["string", "null"], description: "App id or slug, or null for a standalone licence. On create, the app's defaults fill every field not sent" },
            max_sites: { type: ["integer", "null"], minimum: 1, description: "Maximum number of distinct sites (domains) that may use the licence. null for unlimited" },
            grace_days: { type: ["integer", "null"], minimum: 0, maximum: 365, description: "Days the licence stays valid after its expiry date. null: its app's setting; 0: none" },
            status: { type: "string", description: "A status key of the licence's status set (GET /statuses, or GET /apps/{app}/statuses). Defaults to the default status of the set" },
            expires_at: { type: ["string", "null"], description: "YYYY-MM-DD (end of that day, UTC), an ISO date-time, or null for no end date" },
            duration_days: { type: "integer", description: "On create or edit: end date = today + this many days (ignored when expires_at is sent)" },
            domains: { type: "array", items: { type: "string" } },
            message: { type: "string", maxLength: 300 },
            notes: { type: "string", maxLength: 4000 },
            external_ref: { type: "string", maxLength: 120, description: "Create only. Your own reference (order id), unique" },
          },
        },
        StatusInput: {
          type: "object",
          properties: {
            label: { type: "string", maxLength: 40 },
            key: { type: "string", description: "Identifier: lowercase letters, digits and underscores, starting with a letter. Generated from the label if omitted. Create only" },
            description: { type: "string", maxLength: 200 },
            color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", default: "#6b7280", description: "Badge colour as #rrggbb. Any colour can be used" },
            grants_access: { type: "boolean", default: false, description: "Sites can run under this status: the check response has valid = true" },
            on_expiry: { type: ["string", "null"], description: "Key of the status a licence takes on, as seen by sites, after its expiry date. null: the expiry date does not apply" },
            check_message: { type: "string", maxLength: 300, description: "Message returned to sites for this status when the licence has no public message" },
            is_default: { type: "boolean", description: "New licences start with this status. Exactly one status of a set is the default" },
          },
        },
        File: {
          type: "object",
          properties: {
            id: { type: "string" }, name: { type: "string" }, track: { type: ["string", "null"], description: "The track of a release; null for an attachment" },
            version: { type: "string", description: "Empty for an attachment. A file with a version is a release" },
            channel: { enum: ["stable", "beta"] }, changelog: { type: "string", description: "Public release notes" }, notes: { type: "string", description: "Internal" },
            size: { type: "integer" }, content_type: { type: "string" }, sha256: { type: ["string", "null"], description: "Hex SHA-256 of the file. null for files uploaded before checksums were recorded" },
            signature: { type: ["string", "null"], description: "Ed25519 signature of `sha256` (its 64 hex characters), base64; verify with GET /signing-key. null when `sha256` is null" },
            withdrawn: { type: "boolean", description: "A withdrawn release is not offered and cannot be downloaded (HTTP 410)" }, withdrawn_at: { type: ["string", "null"] },
            statuses: { type: "array", items: { type: "string" } }, check_domain: { type: "boolean" },
            available: { type: "boolean", description: "Licence files only: downloadable now, ignoring the domain check" }, download_url: { type: "string", description: "Licence files only" },
            uploaded_at: { type: "string" }, download_count: { type: "integer" }, last_download_at: { type: ["string", "null"] },
          },
        },
        FileChanges: {
          type: "object",
          properties: {
            statuses: { type: "array", items: { type: "string" }, description: "Attachments only: a release is available according to its track" },
            check_domain: { type: "boolean", description: "Attachments only" },
            track: { type: "string", description: "Releases: move the release to this track (id or name)" },
            version: { type: "string", description: "Empty string turns a release into an attachment" }, channel: { enum: ["stable", "beta"] },
            changelog: { type: "string", maxLength: 10000 }, notes: { type: "string", maxLength: 500 },
            withdrawn: { type: "boolean", description: "true withdraws the release, false restores it" },
          },
        },
        AppInput: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 80 },
            slug: { type: "string", description: "Lowercase letters, digits and hyphens, 2 to 48 characters. Generated from the name if omitted" },
            description: { type: "string", maxLength: 500 },
            default_status: { type: "string", description: "Status key new licences of the app start with" },
            default_duration_days: { type: ["integer", "null"], description: "Days a new licence is valid. null for no expiry" },
            default_max_sites: { type: ["integer", "null"], description: "Maximum sites of a new licence. null for unlimited" },
            default_message: { type: "string", maxLength: 300 },
            grace_days: { type: ["integer", "null"], minimum: 1, maximum: 365, description: "Days the app's licences stay valid after their expiry date, unless a licence has its own setting. null: none" },
            notes: { type: "string", maxLength: 4000 },
          },
        },
        WebhookInput: {
          type: "object",
          properties: {
            url: { type: "string", description: "https:// address (http:// only for localhost). Required on create" },
            events: { type: "array", items: { enum: [...EVENT_TYPES] }, description: "Required on create, at least one" },
            description: { type: "string", maxLength: 200 },
            enabled: { type: "boolean", default: true },
          },
        },
        License: {
          type: "object",
          properties: {
            expiry_mode:{enum:["shared","separate"],description:"Tagged-app licences have no top-level status or valid. Read each apps entry."},
            apps:{type:"array",items:{$ref:"#/components/schemas/LicenseApp"}},
            id: { type: "string" }, name: { type: "string" }, customer_name: { type: "string" }, customer_email: { type: "string" }, app: { type: ["object", "null"], properties: { id: { type: "string" }, slug: { type: "string" }, name: { type: "string" } } }, max_sites: { type: ["integer", "null"] }, sites_used: { type: "integer" }, key: { type: "string" }, check_url: { type: "string" },
            status: { type: "string", description: "The status reported to sites: the stored status, or the status its expiry rule points to once the expiry date and any grace period have passed" },
            stored_status: { type: "string" }, valid: { type: "boolean", description: "true when the reported status is valid (grants_access; by default Active and Completed)" }, expires_at: { type: ["string", "null"] },
            grace_days: { type: ["integer", "null"], description: "The licence's own grace period; null: its app's" },
            effective_grace_days: { type: "integer", description: "The grace period in effect, in days" },
            grace_ends_at: { type: ["string", "null"], description: "Set while the licence is in its grace period: expiry date passed, still valid until then" }, domains: { type: "array", items: { type: "string" } },
            message: { type: "string" }, notes: { type: "string" }, external_ref: { type: ["string", "null"] },
            created_at: { type: "string" }, updated_at: { type: "string" }, last_check_at: { type: ["string", "null"] }, last_check_domain: { type: ["string", "null"] }, check_count: { type: "integer" },
          },
        },
      },
    },
  }
}
