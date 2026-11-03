# Checking a licence from a site

Enforcement lives in the customer site's code. Warden only reports the status of a licence.

```
GET https://<your-worker>/check/<licence key>?tag=parent-theme&domain=client-site.org
```

```json
{ "tag": "parent-theme", "valid": true, "status": "active", "message": "", "name": "Harbor Studio website", "app": { "id": "app_...", "slug": "harbor-theme", "name": "Harbor Theme" }, "expires_at": "2027-03-31T23:59:59.999Z", "grace_ends_at": null, "checked_at": "2026-10-11T16:17:30.248Z", "license_key": "WRD-7KQ4M-X2PHR-9TCVN-B3WZD", "domain": "client-site.org", "nonce": null }
```

Select the app using its attachment tag. The same key can check `parent-theme`, `child-theme`, or any other tag attached to the licence. An unknown tag returns a signed 404 with `status: "attachment_not_found"`.

Without a tag, a multi-app licence returns `{ license_key, domain, nonce, checked_at, apps: [...] }`, with an independent result for each tag. It has no top-level `valid`, `status` or `update`. A single-app licence retains a scalar result when the tag is omitted, preserving existing check URLs.

For a batch update check, POST `{ "domain": "harborstudio.com", "versions": { "parent-theme": "1.3.0", "child-theme": "1.0.0" } }`. A single `version` requires a tag when several apps are attached. Each update is selected only from that app's permitted releases.

`grace_ends_at` is set while the licence is in its grace period: its expiry date has passed, but it stays valid until then ([statuses.md](statuses.md#grace-period)). It is `null` otherwise. `license_key`, `domain` and `nonce` repeat what the response answers: the key that was checked, the domain as Warden read it (`null` when none was sent), and the `nonce` the site sent (below), or `null`.

| `status` | `valid` | Meaning |
|---|---|---|
| a status key, such as `active` or `completed` | true | The status is valid, its expiry rule has not triggered, and the domain is allowed |
| a status key, such as `pending`, `suspended`, `disabled` or `expired` | false | The status does not let sites run. Which statuses exist, and which let sites run, is configured per app ([statuses.md](statuses.md)) |
| `domain_mismatch` | false | The site sent a domain that is not allowed for the licence, or no domain although the licence has a site limit |
| `site_limit_reached` | false | The licence is already used on its maximum number of sites, and this domain is not one of them |
| `unknown` | false | No such key (HTTP 404) |
| `blocked` | false | The caller's IP address is blocked (HTTP 403, unsigned: no licence was read). See [protection.md](protection.md) |

Every answer from the check endpoint is signed, including `unknown`. The two answers sent before any licence is read, `blocked` (403) and `rate_limited` (429), are not: treat them like a network error.

A check can also receive **HTTP 429** (`"status": "rate_limited"`, no `valid` field, `Retry-After: 60`) when it goes over a rate limit. That is not a verdict on the licence: keep the last answer and try again later.

Send the installed version as well (`&version=1.3.0`) and the response includes an `update` block: the newest release the licence can download and whether it is newer. See [releases.md](releases.md).

`status` is the key of the licence's status among the statuses that apply to it. The table above shows the defaults; you can add, rename and remove statuses, so decide by `valid` rather than by a fixed list of keys. `message` is the licence's public message, or the message of its status, meant to be shown to the site's owner.

## Rules of thumb for the site

1. **Check about every 12 hours**, not on every page view. Store the response (WordPress: a transient or option) with the time you got it.
2. **Fail open on errors.** If the request times out, fails, returns 429 or a 5xx, or something that is not the JSON above, keep the last known response. Only change behaviour on a response you could read and verify. A Warden outage must never lock a client out.
3. **Verify the signature** before trusting a response (below). An unsigned or wrongly signed response is an error, not a verdict.
4. **Always send `domain`** so domain-locked licences work.
5. Decide what "not valid" does: a notice in the admin area, a maintenance page, disabling a feature. That part is yours.

## Verifying the signature

Every response is signed with your installation's **Ed25519 signing key**:

| Header | Content |
|---|---|
| `X-Warden-Signature-Ed25519` | Ed25519 signature of the **raw response body** (the exact bytes received), base64 |
| `X-Warden-Key-Id` | Identifier of the signing key (16 hex characters) |

The site verifies the signature with the **public key**, which you put in the site's code. Holding the public key or the licence key does not allow creating a signature, so a site's owner cannot fake a valid answer, for example by pointing the check at a server of their own.

**Where to find the public key:** on any licence page, *Integration* tab, *Public signing key*; or `GET /api/v1/signing-key` ([api.md](api.md)). It is the same for every licence of the installation, and it does not change. It is given in two forms: `public_key`, the raw 32-byte key in base64 (libsodium, PHP), and `public_key_pem` (OpenSSL, Node.js).

**Freshness.** A signed answer stays valid forever, so an old "valid" answer could be replayed later. Send a random `nonce` with each check (8 to 64 letters, digits, `.`, `_`, `~` or `-`) and accept the answer only if it echoes it. Also compare `tag` and the returned app identity with the intended product, and `license_key` with the site's key, so an answer for another licence is not accepted. A nonce in another format is ignored and the answer has `"nonce": null`.

PHP (libsodium is part of PHP 7.2 and later):

```php
const WARDEN_PUBLIC_KEY = 'base64 public key from the licence page';

function warden_signed( $signature, $message ) {
    $sig = base64_decode( (string) $signature, true );
    return $sig !== false && strlen( $sig ) === SODIUM_CRYPTO_SIGN_BYTES
        && sodium_crypto_sign_verify_detached( $sig, $message, base64_decode( WARDEN_PUBLIC_KEY ) );
}

$nonce = bin2hex( random_bytes( 16 ) );
$res   = wp_remote_get( "https://your-worker.example/check/$key?tag=parent-theme&domain=" . rawurlencode( $domain ) . "&nonce=$nonce", [ 'timeout' => 10 ] );
if ( is_wp_error( $res ) ) { return; }                                                                   // keep the last known state
$body = wp_remote_retrieve_body( $res );
if ( ! warden_signed( wp_remote_retrieve_header( $res, 'x-warden-signature-ed25519' ), $body ) ) { return; } // not from Warden
$result = json_decode( $body, true );
if ( $result['license_key'] !== $key || $result['nonce'] !== $nonce || $result['tag'] !== 'parent-theme' ) { return; }                          // an answer to another request
update_option( 'my_licence_state', [ 'valid' => $result['valid'], 'status' => $result['status'], 'message' => $result['message'], 'at' => time() ] );
```

JavaScript (Node 22 or later, a Worker, or a current browser):

```js
const PUBLIC_KEY = "base64 public key from the licence page"
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

const nonce = crypto.randomUUID()
const res = await fetch(`https://your-worker.example/check/${key}?tag=parent-theme&domain=${encodeURIComponent(domain)}&nonce=${nonce}`)
const body = await res.text()
const publicKey = await crypto.subtle.importKey("raw", bytes(PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"])
const signed = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, bytes(res.headers.get("x-warden-signature-ed25519") ?? ""), new TextEncoder().encode(body))
if (!signed) throw new Error("response was not signed by Warden")
const result = JSON.parse(body)
if (result.license_key !== key || result.nonce !== nonce || result.tag !== "parent-theme") throw new Error("answer to another request")
```

Verify the body exactly as received, before parsing it: re-encoding the JSON changes the bytes. The download endpoint signs its JSON answers the same way, and each release carries a signature of its checksum ([releases.md](releases.md#verifying-a-package)).

### The signing key

The key pair is created the first time it is needed and stored in the installation's D1 database. Back up the database ([upgrade-notes.md](upgrade-notes.md#before-you-upgrade)): an installation started on a new, empty database has a new key, and sites that pin the old public key then reject every answer, keeping their last known state, until their code has the new key. `X-Warden-Key-Id` lets a site report which key signed an answer it rejected.

### Earlier signature (deprecated)

`X-Warden-Signature`, the lowercase hex HMAC-SHA256 of the body keyed with the licence key, is still sent on answers for known keys and is **removed in 1.0.0**. Anyone holding the licence key can compute it, including the site's owner, so it only shows that a response was not altered in transit. Move site code to the Ed25519 signature.

Treat a 404 (`unknown`) as "invalid key" only if you are sure the URL is right; if you deleted the licence on purpose, that is the intended effect.
