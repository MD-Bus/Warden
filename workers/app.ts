import { createRequestHandler } from "react-router"
import { handleApi } from "../app/server/api.server"
import { handleCheck } from "../app/server/check.server"
import { handleDownload, handleLinkDownload } from "../app/server/download.server"
import { guardPublic } from "../app/server/guard.server"
import { pruneBlocks } from "../app/server/ip-blocks.server"
import { pruneIpEvents } from "../app/server/protection.server"
import { pruneActivity, scanLicenseEvents } from "../app/server/licenses.server"
import { deliverDue, flushAfterResponse, pruneDeliveries, rememberOrigin } from "../app/server/webhooks.server"
import { handleAppWebhook, handleWebhook, pruneImports, resumeImports } from "../app/server/sources.server"
import { withDashboardHeaders } from "../app/server/headers.server"
import { initRequestCache } from "../app/server/request-cache.server"
import { ensureMigrated, migrationFailureResponse, type Migration } from "../app/server/migrate.server"

// Migration files are bundled so the Worker can bring an older database up to date by itself.
const migrations: Migration[] = Object.entries(
  import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>
).map(([path, sql]) => ({ name: path.split("/").pop()!, sql }))

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env
      ctx: ExecutionContext
      /** Per-request CSP nonce for inline scripts. */
      nonce: string
    }
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Worker Previews (preview builds of pull requests) have no database: say so instead of reporting a failed upgrade.
    if (!env.DB) return previewWithoutDatabase(request)

    try {
      await ensureMigrated(env.DB, migrations)
    } catch (error) {
      return migrationFailureResponse(request, error)
    }

    if (url.pathname.startsWith("/api/v1")) {
      rememberOrigin(env, ctx, url.origin)
      const response = await handleApi(request, env, ctx)
      flushAfterResponse(env, ctx)
      return response
    }

    // Public endpoint that authenticates with the licence key in the address.
    const check = url.pathname.match(/^\/check\/([A-Za-z0-9-]{10,40})\/?$/)
    if (check) return (await guardPublic(request, env, ctx, "check", check[1].toUpperCase())) ?? handleCheck(request, env, ctx, check[1].toUpperCase())

    // Signed download link from a check or download answer: the token is the credential, not the licence key.
    const link = url.pathname.match(/^\/download\/t\/([A-Za-z0-9_.-]{1,1024})\/?$/)
    if (link) return (await guardPublic(request, env, ctx, "download", "")) ?? handleLinkDownload(request, env, ctx, link[1])

    const download = url.pathname.match(/^\/download\/([A-Za-z0-9-]{10,40})(?:\/(fil_[a-z0-9]+))?\/?$/)
    if (download) return (await guardPublic(request, env, ctx, "download", download[1].toUpperCase())) ?? handleDownload(request, env, ctx, download[1].toUpperCase(), download[2] ?? null)

    // Webhooks of connected repositories, authenticated by their signature: the GitHub App's, and per-source ones.
    if (url.pathname === "/hooks/github-app") return handleAppWebhook(request, env, ctx)
    const hook = url.pathname.match(/^\/hooks\/([a-z]+)\/(src_[a-z0-9]+)\/?$/)
    if (hook) return handleWebhook(request, env, ctx, hook[1], hook[2])

    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    // A per-request copy of env: it is the key of the request-scoped cache (see request-cache.server.ts).
    const requestEnv = { ...env } as Env
    initRequestCache(requestEnv, request)
    rememberOrigin(env, ctx, url.origin)
    const response = await requestHandler(request, { cloudflare: { env: requestEnv, ctx, nonce } })
    // Changes made in the dashboard can write webhook events: send them once the page is out.
    flushAfterResponse(env, ctx)
    return withDashboardHeaders(response, request)
  },

  // Runs every 10 minutes (wrangler.jsonc): time-based webhook events, due deliveries and a stopped release import
  // each time, the clean-up once a day. One cron trigger only, since an account has a limited number of them.
  async scheduled(controller, env, ctx) {
    await ensureMigrated(env.DB, migrations)
    const now = controller.scheduledTime
    ctx.waitUntil(
      scanLicenseEvents(env, now)
        // At most 40 deliveries per run: the free plan allows 50 outgoing requests per invocation, and a resumed
        // release import (below) needs a few. Deliveries left over go out on the next run.
        .then(() => deliverDue(env, now, 40))
        .catch((error) => console.error("Warden webhooks failed:", error)),
    )
    ctx.waitUntil(resumeImports(env, now).catch((error) => console.error("Warden import resume failed:", error)))
    const at = new Date(now)
    if (at.getUTCHours() !== 3 || at.getUTCMinutes() >= 10) return
    ctx.waitUntil(pruneActivity(env).catch((error) => console.error("Warden prune failed:", error)))
    ctx.waitUntil(pruneBlocks(env).catch((error) => console.error("Warden block clean-up failed:", error)))
    ctx.waitUntil(pruneIpEvents(env).catch((error) => console.error("Warden event clean-up failed:", error)))
    ctx.waitUntil(pruneImports(env).catch((error) => console.error("Warden import clean-up failed:", error)))
    ctx.waitUntil(pruneDeliveries(env, now).catch((error) => console.error("Warden delivery clean-up failed:", error)))
  },
} satisfies ExportedHandler<Env>

function previewWithoutDatabase(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return Response.json({ error: { code: "no_database", message: "This Worker has no D1 database bound (DB). Previews of pull requests run without one." } }, { status: 503 })
  }
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview without a database</title>
<body style="font-family:system-ui;max-width:560px;margin:15vh auto;padding:0 20px;line-height:1.5">
<h1>Preview without a database</h1>
<p>This build of Warden runs without a database: Cloudflare does not give previews of pull requests access to the production database, by design.
The build itself succeeded; merge the pull request to deploy it.</p>
<p>If this is not a preview, bind a D1 database as <code>DB</code> in the Worker's settings.</p>
</body>`
  return new Response(page, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
}
