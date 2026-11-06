/** Security headers for the dashboard (React Router) responses. */
export function dashboardCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // github.com receives the GitHub App manifest (Integrations), the only form posted elsewhere.
    "form-action 'self' https://github.com",
    "object-src 'none'",
  ].join("; ")
}

/**
 * How long the browser may keep a page's data: long enough for a link's prefetch on hover to serve the click, short
 * enough that figures stay current. Everything else stays no-store.
 */
const PAGE_DATA_SECONDS = 10
const REVISION_COOKIE = "wd_rev"

export function withDashboardHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers)
  const url = new URL(request.url)
  if (request.method === "GET" && response.status === 200 && url.pathname.endsWith(".data") && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", `private, max-age=${PAGE_DATA_SECONDS}`)
    headers.append("Vary", "Cookie")
  }
  // Any change gives the browser a new cookie, and Vary: Cookie then rules out all kept page data, so a save or a
  // logout is never followed by old data.
  if (request.method !== "GET" && request.method !== "HEAD") {
    const secure = url.protocol === "https:" ? "; Secure" : ""
    headers.append("Set-Cookie", `${REVISION_COOKIE}=${crypto.randomUUID()}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secure}`)
  }
  headers.set("X-Frame-Options", "DENY")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
  headers.set("Cross-Origin-Opener-Policy", "same-origin")
  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  }
  // Everything the dashboard serves is per-user and must not sit in shared caches.
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
