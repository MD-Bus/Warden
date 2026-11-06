# Security

Warden is **pre-1.0** (see [Roadmap.md](Roadmap.md)). It has had no independent security audit. Use it for what it is, a licence switch for your own client sites, and read the limits below before relying on it.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately to the maintainer by email at **momar.web54@gmail.com**, or through GitHub's "Report a vulnerability" button on the repository (Security tab) once it is public. Include what you found, how to reproduce it, and which version. You will get an acknowledgement, and a fix or a clear response, as fast as one person can manage. Credit is given unless you prefer otherwise.

Supported versions: only the latest release (there is no 1.0 yet, so none is long-term supported).

## What Warden protects, and how

| Area | Design |
|---|---|
| Dashboard login | One admin, from the Worker secrets `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Credentials are compared in constant time. The session cookie is an opaque random token (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS); the server keeps only its hash, so logging out or changing the password ends the session. |
| Brute force | 8 failed logins per IP per 15 minutes locks that IP out; a global delay slows distributed guessing. IPs are stored hashed. |
| CSRF | Every dashboard action rejects cross-origin posts, on top of `SameSite=Lax`. |
| Dashboard pages | Strict Content-Security-Policy with a per-request nonce, `X-Frame-Options: DENY`, HSTS on HTTPS. Pages are `no-store`; page data for in-app navigation may stay in the browser for 10 seconds (`private`, `Vary: Cookie`), and any change or logout rules it out. |
| Request size | API bodies are read up to 64 KB and check bodies up to 4 KB, stopping at the limit even without a Content-Length. Uploads are capped at 100 MB before anything is stored. |
| API keys | `wk_` plus 40 uniformly random letters and digits. Only a SHA-256 hash is stored; the key is shown once. Three scopes (`read`, `manage`, `full`), revocable at any time. Keys act as the admin account, so give each app its own key with the least access it needs. |
| Licence keys | `WRD-` plus 20 random characters from a 30-symbol alphabet (about 98 bits), generated with the platform's secure random source. Unknown keys get a generic 404. |
| Check responses | Signed with the installation's Ed25519 key (`X-Warden-Signature-Ed25519` over the raw body, `X-Warden-Key-Id`). A site verifies with the public key, which cannot create signatures, so neither a network attacker nor the site's owner can forge a valid answer. The body names the licence key, selected app and tag, the domain and the site's nonce, so an answer cannot be replayed for another licence or at a later check. Download responses are signed the same way. The earlier `X-Warden-Signature` (HMAC keyed with the licence key) is still sent and removed in 1.0.0. |
| Signing key | Created on first use with the platform's secure random source and stored in D1 (settings, `signing_key`), or kept in the `WARDEN_SIGNING_KEY` Worker secret ([docs/checking.md](docs/checking.md#the-signing-key)). The private key is never shown by the dashboard or the API; only the public key is. It does not change: once the public key is recorded, Warden stops with an error rather than create a replacement. A new database means a new key unless the secret is set. |
| File downloads | Files live in a private R2 bucket with no public URL; the Worker streams them only after checking the licence (the licence status against the file's release statuses, and the domain when the file requires it). Every download and denied download is logged. Names are sanitised and sent as attachments with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so an uploaded file can never run as a page on the dashboard's origin. Each file's SHA-256 is computed during the upload and sent with the release and as `X-Warden-Sha256`, with an Ed25519 signature of it (`signature`, `X-Warden-Release-Signature`), so an updater can check the package arrived intact and was published through your installation. |
| Update offers | The `update` block is part of the signed check response, so a site can trust the version, checksum and download link it is offered as much as the status. |
| CSV export | Cells that a spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@`) are prefixed with an apostrophe, so opening an export cannot run anything. |
| Database | Cloudflare D1, queries use bound parameters throughout. Check history older than 90 days is deleted daily. |
| Caller addresses | The IP address of each check and download (normally the customer's server, not a visitor) is stored with it, to investigate misuse and block addresses. Addresses go with the checks after 90 days, and are cleared from downloads after 90 days. Mention this in your privacy notice if your customers are in the EU. |
| GitHub App | Created by the admin through GitHub's manifest flow; the redirect back is tied to the request with a one-hour, `HttpOnly` state cookie. The app can only read repository contents and metadata. Warden signs a nine-minute JSON Web Token with the app's key to request installation tokens, which last one hour and are limited to the same permissions. The dashboard's form policy allows `https://github.com` for the manifest post, and no other external target. |
| Outgoing webhooks | Endpoints are set by the admin (API: `full` scope only), must use HTTPS (HTTP only for localhost), and receive licence data, including licence keys and customer contact details. Every request is signed with the installation's Ed25519 key (`X-Warden-Signature-Ed25519` over the body) and carries an event id and time, so a receiver can verify it and refuse duplicates and replays. Redirects are not followed; each request times out after 10 seconds. Deliveries are kept 30 days. |
| Repository webhooks | `POST /hooks/github-app` (the GitHub App) and `POST /hooks/github/{source id}` (token connections) accept only deliveries signed with their secret (HMAC-SHA256, compared in constant time). A valid delivery can only make Warden publish a tag that exists in a connected repository. |
| Blocking and rate limits | Blocked addresses and ranges get 403 on checks and downloads before any licence is read. Rate limits per address, per licence key and per API key (Workers rate limiting, approximate) answer 429. Blocking rules add addresses automatically (invalid licence keys, invalid checks, licences per IP address, rate limit violations). IP blocking never applies to the dashboard or the API. See [docs/protection.md](docs/protection.md). |

## Multiple apps under one key

A licence key grants access to every app attached to that licence. Tags select an attachment; they are not independent credentials. Use separate licences when products must have separate credentials. Revoking or regenerating a key affects every attached app.

Clients must verify the tag and app identity in the signed response in addition to the licence key, domain and nonce. Update selection and direct download authorization are evaluated within that app attachment. A response for one tag must not be accepted as the result for another.

## Limits you should know about

- **Enforcement is in your site's code, and the client controls the site.** Anyone who can edit the code on a server can remove the check. Warden tells your code what the licence status is; it cannot make a determined owner of a site comply. Treat it as a way to run a clear, fair commercial arrangement, together with a written agreement, not as copy protection.
- **Licence keys are stored readable** (the dashboard and API show them again on demand). Anyone with access to your D1 database or an API key can read them. Protect your Cloudflare account with a strong password and two-factor authentication.
- **By default the signing key is as safe as your D1 database.** Anyone who can read the database (your Cloudflare account, or a database export) can read the private key and sign answers. Protect exports like the dashboard password, or move the key to the `WARDEN_SIGNING_KEY` secret and remove the database copy. A Cloudflare account with full access can still replace the secret or the Worker, and the key cannot be rotated without updating every site. Sites that still verify the deprecated HMAC header can be fooled by anyone holding the licence key, including the site's owner: move them to the Ed25519 signature.
- **A signature does not make enforcement tamper-proof.** The site's owner can still remove the check from the code (first point above); signatures stop them from faking Warden's answer while the check is in place.
- **Rate limits and blocks are approximate and per address.** Cloudflare counts per location, so a caller spread over many locations, or many addresses, gets further than one address would. Blocking by address cannot stop someone with many addresses; a leaked licence key is stopped by regenerating it. Cloudflare's WAF can add stricter rules in front of `/check/*` and `/api/*`.
- **Single admin.** There are no separate users or roles. API key scopes are the only separation.
- **CORS is open (`*`) on `/check/*` and `/api/*`.** Those endpoints do not use cookies, so a web page cannot use your dashboard session against them; they authenticate with the key in the address or the `Authorization` header.
- **Site limits rely on the domain a site reports.** A customer could send another domain, or run the same code on several servers that all report the same domain. The limit controls honest use and makes sharing visible (the licence page lists every registered site); it does not technically prevent it.
- **Download links.** Checks and download lists give signed links (`/download/t/<token>`) instead of addresses containing the licence key, because updaters display and log the package address. A link opens one release for one tag for 7 days, or until the key is regenerated, and anyone who sees it can download that release during that time while the licence's status allows it. The key-based address `/download/<key>/<file id>` still works and still exposes the key wherever it is logged.
- **Downloaded files stay downloaded.** Cutting a licence off stops future downloads and updates, not copies already on a client's server. The final file, once released, cannot be taken back. Anyone who holds a valid licence key can download the files that licence allows, from anywhere, as often as they like (no download limits yet).
- **No malware scanning** of uploaded files; you are the only uploader, so scan your own builds. The release signature proves a package was published through your installation, not who uploaded it: anyone who can upload (you, an API key with `manage`, or a push of a tag to a connected repository) publishes a signed release.
- **The GitHub App's private key and repository access tokens are stored readable in D1**, like licence keys, because Warden must use them. Anyone with access to the database could read every repository the app is installed on. Install the app only on the repositories you publish (*selected repositories*), and prefer it to personal access tokens, which do not expire on their own. The dashboard and the API never show the key or a saved token.
- **A tag pushed to a connected repository is published.** Anyone who can push tags to that repository can publish a release to your customers; protect release tags with GitHub's tag protection rules.
- **Webhook endpoints receive licence keys and customer details.** Point them only at systems you control, and verify the signature there; anyone who learns an endpoint's address can send it requests, but cannot sign them.
- Not a general-purpose secret store. Do not put passwords or personal data in licence notes.

## Hardening checklist

1. Use a long random `ADMIN_PASSWORD` (12+ characters) and set `SESSION_SECRET` (`openssl rand -hex 32`).
2. Turn on two-factor authentication for the Cloudflare account that hosts Warden.
3. Create one API key per app, with the lowest scope that works. Revoke keys you no longer use.
4. In the client site, act only on an explicit response (`valid: false`) and keep the last known state when Warden cannot be reached, so an outage never locks a client out.
5. Verify the `X-Warden-Signature-Ed25519` header in the site with the public key, send a nonce with each check, and verify the signature of each package before installing it (see [docs/checking.md](docs/checking.md) and [docs/releases.md](docs/releases.md)).
6. Put a Cloudflare rate-limiting rule on `/api/*` if you expose keys to third-party systems.
