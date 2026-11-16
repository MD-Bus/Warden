# Releases and updates

Warden can deliver the updates of what you sell. A **release** is a file with a version, stored in R2 like any other file ([files.md](files.md)). Releases are grouped in **tracks**: a track decides which licence statuses receive its releases. On top of that, a release has a channel, public release notes and a checksum, and the check endpoint tells each site whether a newer release is waiting for it.

![The Releases tab of an app: the Updates track, for Active licences, with its releases](screenshots/releases.jpg)

A file **without** a version is an *attachment* (a manual, a notice). It can be downloaded but is never offered as an update.

## Tracks

A track is what a set of licence statuses receives. An app has one or more tracks, for example:

| Track | For licences that are | Receives |
|---|---|---|
| Updates | Active | Regular builds, with the licence check built in |
| Final build | Completed | The licence-free build, once paid in full |
| Maintenance | Suspended | A maintenance version while a payment is late |

- **Each status belongs to one track at most**, so a status never has two packages. Warden refuses a track that claims a status another track serves, and names that track.
- A licence is offered **the latest release of the track that serves its current status**, nothing else: a Completed licence receives the latest Final build even when Updates has a higher version. When you change a licence's status, what its site is offered changes with it.
- **Versions are unique per track**, not per app: the Final build can be 1.0.0 while Updates is at 1.4.0, or both can be 1.4.0. Uploading a version the track already has (`v1.4.0` and `1.4.0` are the same), or changing or restoring a release to one, returns `409`; withdrawn releases do not count.
- A track also sets the **domain check** of its releases.
- A track receives releases by **upload**, or from a **connected repository** ([repositories.md](repositories.md)). Several tracks can be fed by one repository, told apart by tag prefix.
- Each tagged app attachment follows its app's tracks, selected by its own status. Migrated custom project apps retain their old release overrides and inherit the original app's tracks for other statuses. New custom projects use an app of their own.
- A status that no track serves receives no update.

Create, rename and delete tracks on the *Releases* tab (*New track*, and the track's menu). Changing a track's statuses applies to all its releases at once. Deleting a track moves its releases to another track first. A track can also limit how many releases it keeps ([below](#release-limit)) and defines the labels its releases carry ([below](#release-labels)).

### Release limit

A track that publishes often grows without end. Give it a **release limit** (*Edit track*, *Keep the newest releases*) and Warden deletes the oldest releases, with their files, beyond that number:

- It runs **whenever a release is added** (upload, API or repository import) and **when you lower the limit**. The edit dialog lists the releases that saving would delete, and the button says how many. Deleting cannot be undone; download anything you want to keep first.
- "Oldest" is by **version**, not upload date: `1.10.0` is newer than `1.9.2`. Withdrawn releases count towards the limit.
- The **newest release of every channel is never deleted**, whatever the limit, because it is what sites on that channel are offered.
- The release you have just added is kept even when its version is older than the others (a hotfix of an old line). The track then holds one more than its limit until the next release is added.
- A repository import does not publish a deleted version again: the tag stays recorded as imported.
- Leave the limit empty (the default) to keep every release. Attachments and other tracks are never touched. The limit is a whole number from 1 to 1000.

### Release labels

Labels say what kind of release it is: **Urgent**, **Security**, **Bug fix**, **New feature**, or anything you define. Sites receive them with the release, so their update code can act on them, for example install an urgent release at once instead of waiting for its share of a staged rollout.

- **Each track defines its labels**, each with a name and a colour (*Edit track*, *Release labels*). A new track starts with Urgent (`urgent`), Security (`security`), Bug fix (`bug_fix`) and New feature (`feature`); tracks created before 0.7.0 use the same four until you change them. Up to 20 labels per track.
- A label has a **key**, which is what sites receive. It is made from the name when you add the label (*Long-term support* gives `long_term_support`) and **stays fixed once saved**, so renaming or recolouring a label never breaks site code.
- **A release carries any number of its track's labels.** Choose them when you upload, in *Edit*, or from the release's menu, *Labels*. Each one shows as a badge in its colour.
- Removing a label from a track removes it from the track's releases. A release moved to another track keeps only the labels that track also has.
- Labels are public: they appear in the check answer and the download list, in `labels`, as a list of keys (`["urgent", "security"]`, or `[]`).

### Channels

A channel is a line of releases within a track: **Stable** for every site, **Beta** for sites that test early builds, or any channel you add (*Edit track*, *Channels*), such as *Release candidate* or *Nightly*. Up to 10 per track.

- **Stable always exists** and cannot be removed. A site that sends no channel, or a channel the track does not have, receives Stable. That is how every site built before channels existed keeps working.
- **No stable release means no update for sites without a channel.** Warden never falls back to another channel: a site that did not ask for beta builds is never offered one. Its licence stays valid; the check answers `available: false` and `latest: null` until a stable release is published, or a release is moved to Stable (*Edit*, *Channel*). The same applies to a site asking for a channel that has no release and includes none that has.
- A channel can also **receive the releases of other channels**. Beta includes Stable by default, so a beta site is offered the newest of both, as before. A *Nightly* channel that includes Stable and Beta is offered the newest release of the three.
- A channel has a **key**, which sites send (`?channel=release-candidate`). It is made from the name and stays fixed once saved.
- **Each channel can follow its own repository**, or the same repository on its own branch: Stable follows `main`, Beta follows `beta`, and a tag publishes on the channel whose branch has it ([repositories.md](repositories.md#channels-and-branches)).
- A channel that has releases or a repository cannot be removed: move its releases to another channel and disconnect its repository first. A release moved to a track without its channel becomes Stable.
- Tracks created before 0.8.0 have Stable and Beta until you change them.

Files without a version (attachments) are not in a track: each one keeps its own release rule ([files.md](files.md)).

**Earlier releases** (from before tracks existed) were put into tracks automatically, one per distinct release rule, so nobody gained or lost access. If two of them serve the same status, the *Releases* tab says so: edit the tracks until each status belongs to one.

## What a release has

| Field | Meaning |
|---|---|
| **Version** | Numbers separated by dots (one to four), an optional leading `v`, an optional pre-release suffix and an optional build suffix. Examples: `1.4.0`, `v2.1`, `2.0.0-beta.1`, `2.0.0+build.7`. Versions are compared by semantic versioning precedence: `1.10.0` is newer than `1.9.2`, `2.0` equals `2.0.0`, and `2.0.0` is newer than `2.0.0-rc.1`. |
| **Channel** | A channel of the track ([Channels](#channels)): `stable` (default), `beta`, or one the track defines. Sites receive stable releases unless they ask for another channel, in which case they receive the newest release of that channel and the channels it includes. |
| **Release notes** | Public text (up to 10,000 characters) returned with the release, so a site can show "what's new" before installing. |
| **Labels** | Public keys such as `urgent` or `security`, chosen among the labels of the release's track ([above](#release-labels)), returned with the release in `labels`. |
| **Checksum** | The SHA-256 of the file, computed by Warden during the upload. Returned with the release and sent as the `X-Warden-Sha256` header of the download, so an updater can verify what it received. Files uploaded before checksums were introduced have none. |
| **Signature** | Ed25519 signature of the checksum, made with the installation's signing key. Returned with the release (`signature`) and sent as the `X-Warden-Release-Signature` header of the download, so an updater can verify that the package was published by you ([below](#verifying-a-package)). `null` for a file without a checksum. |
| **Withdrawn** | A withdrawn release is no longer offered, no longer listed, and its download returns HTTP 410. It stays on record and can be restored. Use it to pull a bad build without losing its history. |
| **Internal notes** | For you only. Never sent to sites. |

Releases live on the **app**, including for a one-off project or a custom build. Attach that app to the customer's licence under the tag the site expects.

## Offering updates through the check

A site that sends its installed version with its regular check gets an `update` block back:

```
GET https://<your-worker>/check/<licence key>?tag=parent-theme&domain=harborstudio.com&version=1.3.0
```

```json
{
  "valid": true,
  "status": "active",
  "message": "",
  "name": "Harbor Studio website",
  "tag": "parent-theme",
  "app": { "id": "app_...", "slug": "harbor-theme", "name": "Harbor Theme" },
  "expires_at": "2027-10-04T23:59:59.999Z",
  "grace_ends_at": null,
  "checked_at": "2026-10-10T09:12:44.512Z",
  "license_key": "WRD-7KQ4M-X2PHR-9TCVN-B3WZD",
  "domain": "harborstudio.com",
  "nonce": null,
  "update": {
    "current": "1.3.0",
    "available": true,
    "latest": {
      "id": "fil_...",
      "name": "harbor-theme-1.4.0.zip",
      "version": "1.4.0",
      "channel": "stable",
      "changelog": "Faster gallery. Fixes the mobile menu.",
      "labels": ["security"],
      "size": 3145728,
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "signature": "<Ed25519 signature of sha256, base64>",
      "released_at": "2026-10-08T14:03:11.000Z",
      "download_url": "https://<your-worker>/download/t/eyJsIjoi..."
    }
  }
}
```

- `latest` is the newest release this licence can download **right now**, for this domain, in the site's channel: the release rule is applied exactly as for a download. A suspended licence is offered nothing; a release published only for Completed licences is offered once the licence is Completed. When the site's channel (and the channels it includes) has no release, `latest` is `null` ([Channels](#channels)).
- `available` is `true` when `latest` is newer than `current`.
- `labels` lists the keys of the release's labels, such as `urgent` ([release labels](#release-labels)); it is `[]` when the release has none.
- `download_url` is a signed download link valid for 7 days ([files.md](files.md#download-links)). It carries the tag and domain and does not contain the licence key, so the site can hand it to its updater as is.
- Add `&channel=beta` to receive beta releases too, or the key of another channel of the track. A channel the track does not have gives stable releases.
- The whole response, `update` included, is signed with the installation's Ed25519 key ([checking.md](checking.md#verifying-the-signature)).
- The `update` block appears only when the site sends a valid `version`. Older site code that does not send one gets the same response as before.

Tag selects the app, its status selects a track, and channel selects the channel within that track. Versions from different apps are never compared.

The same fields can be sent in a POST body: `{ "tag": "parent-theme", "domain": "harborstudio.com", "version": "1.3.0", "channel": "beta" }`.

### Urgent releases

Give the release the **Urgent** label. Sites read it in `update.latest.labels`; what it means is up to the site's updater, for example installing at once instead of waiting for a staged rollout:

```php
$urgent = in_array('urgent', $answer['update']['latest']['labels'] ?? [], true);
```

0.6.3 marked urgent releases with `[urgent]` in their release notes instead. Migration 0019 gives those releases the Urgent label and takes the marker out of their notes, so site code that looks for `[urgent]` in `changelog` must read `labels` from 0.7.0 on.

## Knowing which versions are installed

The version and channel a site sends are recorded with the site, per attached app, including while its licence is invalid. A site is compared with the release its own check offers: the latest release of the track serving its licence's status, on the channel the site checks. Each site has exactly one state:

| State | Meaning |
|---|---|
| Up to date | On the latest offered release, or newer |
| Behind | On an older version than the latest offered release |
| No release for this status | The status of the licence receives no release, or the site's channel has none (for example a track with only beta releases, and a site that asks for no channel), so there is nothing to compare with |
| Not reported | The site never sent a version |

- On a **licence**, the *Sites* tab lists each site with its version and state.
- On an **app**, the *Releases* tab shows which versions the app's sites run and how many sites are in each state. Equal versions written differently (`v1.4`, `1.4.0`) share a row.

A site checks about every 12 hours, so a site updated a moment ago stays behind until its next check.

Through the API: `GET /api/v1/licenses/{id}/activations` returns each site's `versions` by tag (and `version` when one app is attached), and `GET /api/v1/apps/{app}/versions` returns the distribution:

```json
{
  "latest_version": "1.4.0",
  "sites": 12,
  "outdated": 3,
  "up_to_date": 9,
  "no_release": 0,
  "not_reported": 0,
  "data": [
    { "version": "1.4.0", "sites": 9, "behind": 0, "up_to_date": 9, "no_release": 0, "outdated": false },
    { "version": "1.3.0", "sites": 3, "behind": 3, "up_to_date": 0, "no_release": 0, "outdated": true }
  ]
}
```

## Publishing a release

**Dashboard:** open the app (or the licence), *Releases* tab, *Upload*. Choose the file, enter the version, pick the channel and the **track**, and write the release notes. Each track lists its releases by version, newest first, with its latest marked; use the menu of a release to edit it (including moving it to another track), copy its checksum, withdraw or restore it, or delete it.

**API:**

```bash
curl -X PUT "https://<worker>/api/v1/apps/harbor-theme/files?name=harbor-theme-1.4.0.zip&version=1.4.0&track=Updates&changelog=Faster%20gallery." \
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/zip" --data-binary @harbor-theme-1.4.0.zip

# longer release notes, or a correction, afterwards
curl -X PATCH https://<worker>/api/v1/apps/harbor-theme/files/<file id> \
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/json" \
  -d '{"changelog":"Faster gallery.\nFixes the mobile menu."}'

# pull a bad build, and put it back later
curl -X PATCH https://<worker>/api/v1/apps/harbor-theme/files/<file id> -H "Authorization: Bearer $WARDEN_KEY" -d '{"withdrawn":true}'
curl -X PATCH https://<worker>/api/v1/apps/harbor-theme/files/<file id> -H "Authorization: Bearer $WARDEN_KEY" -d '{"withdrawn":false}'
```

Run it from your build pipeline to publish every release automatically.

**From a repository:** connect a GitHub repository to the app or licence, and every version tag you push is published as a release, with a fixed folder name inside the zip. See [repositories.md](repositories.md).

## Verifying a package

A release's `signature` is the Ed25519 signature of its `sha256`, the 64 lowercase hex characters as text, made with the installation's signing key ([checking.md](checking.md#verifying-the-signature)). Before installing a package, an updater:

1. computes the SHA-256 of the file it downloaded, in lowercase hex;
2. compares it with `sha256` from the signed check response (or the `X-Warden-Sha256` header);
3. verifies `signature` (or the `X-Warden-Release-Signature` header) against that hex text with the public key.

The checksum proves the file arrived intact; the signature proves it was published through your Warden installation and not replaced on the way or on a mirror. The check response that offered the release is signed too, so the version, checksum and signature it names come from you.

From the command line (OpenSSL 3), with the public key saved in PEM form (`public_key_pem` of `GET /api/v1/signing-key`) as `warden.pem`:

```bash
openssl dgst -sha256 -r harbor-theme-1.4.0.zip | cut -d' ' -f1 | tr -d '\n' > package.sha256
echo "<signature>" | base64 -d > package.sig
openssl pkeyutl -verify -pubin -inkey warden.pem -rawin -in package.sha256 -sigfile package.sig
```

## Example: an updater in WordPress

`warden_signed()` is the helper from [checking.md](checking.md#verifying-the-signature).

```php
function harbor_check_for_update( $key, $installed_version ) {
    $nonce = bin2hex( random_bytes( 16 ) );
    $url   = 'https://your-worker.example/check/' . $key . '?tag=parent-theme&domain=' . rawurlencode( wp_parse_url( home_url(), PHP_URL_HOST ) ) . '&version=' . rawurlencode( $installed_version ) . '&nonce=' . $nonce;
    $res   = wp_remote_get( $url, [ 'timeout' => 10 ] );
    if ( is_wp_error( $res ) ) { return null; } // keep the last known state
    $body = wp_remote_retrieve_body( $res );
    if ( ! warden_signed( wp_remote_retrieve_header( $res, 'x-warden-signature-ed25519' ), $body ) ) { return null; }
    $result = json_decode( $body, true );
    if ( $result['license_key'] !== $key || $result['nonce'] !== $nonce || $result['tag'] !== 'parent-theme' ) { return null; }
    return ! empty( $result['update']['available'] ) ? $result['update']['latest'] : null;
}

// After downloading the package with download_url( $latest['download_url'] ), verify it before installing:
function harbor_package_ok( $package, $latest ) {
    $hash = hash_file( 'sha256', $package );
    return hash_equals( (string) $latest['sha256'], $hash ) && warden_signed( $latest['signature'], $hash );
}
```

Hook the result into the `pre_set_site_transient_update_themes` (or `_plugins`) filter to show the update in the WordPress admin, and install with the regular upgrader.

## Good practice

- Give each audience its own track (Updates, Final build, Maintenance) rather than mixing them: what a licence receives then follows from its status, with nothing to calculate.
- Upload each build with its version, and keep older releases in the track: they stay on record, and withdrawing the newest one makes the previous one the latest again.
- Use the beta channel for early builds and promote a build by changing its channel to stable. With a repository, let each channel follow its branch: tag on `beta` for testers, merge and tag on `main` for everyone.
- Withdraw instead of deleting when a release turns out to be broken: sites stop being offered it, and you keep its record and download count.
- Have the site verify the signature of the check, and the checksum and signature of the package, before installing anything.
