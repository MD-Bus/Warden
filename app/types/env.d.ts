// Secrets are configured in the Cloudflare dashboard (or `wrangler secret put`),
// so `wrangler types` does not know about them unless they exist in .dev.vars.
interface Env {
  DB: D1Database
  ADMIN_USERNAME: string
  ADMIN_PASSWORD: string
  SESSION_SECRET?: string
  /** Optional: the Ed25519 signing key as JSON, so it does not have to live in the database. */
  WARDEN_SIGNING_KEY?: string
}
