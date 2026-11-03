# Files

Apps own files and releases, whether the app is sold to many customers or belongs to a single custom project. A licence sees files through its tagged app attachments. A file with a version is a release; a file without one is an attachment.

## Release rule

A file can be downloaded when the attachment's effective status is in the file's release statuses and its domain rules pass. Releases take their rule from their app's release track. Files without a version keep their own rule.

| Purpose | Statuses | Domain check |
|---|---|---|
| Regular updates | active | on |
| Final build after full payment | completed | off |
| Maintenance notice | suspended, expired | off |

The status's expiry rule and grace period are evaluated independently for the selected tag. A permitted maintenance file can be downloadable even when the app's check is invalid. A withdrawn release returns 410.

## Endpoints

```
GET /download/<key>?tag=parent-theme&domain=harborstudio.com
GET /download/<key>/<file-id>?tag=parent-theme&domain=harborstudio.com
```

The list returns the selected app, tag, check validity, `latest`, and `files`. Files include version, channel, release notes, checksum, release signature, rule, availability and `download_url`. Internal notes are never public. Without a tag, a multi-app licence returns `apps` with independent lists; there is no combined latest release.

A tag scopes direct downloads too: a child-theme tag cannot download a parent-theme file. A direct URL without a tag is supported for existing links and resolves the app owning that file. If a licence attaches that app under several tags, supply a tag to select which access rules apply.

Listed download URLs contain the tag. Append the domain with `&domain=...`. Update URLs returned by `/check` already contain both tag and domain. JSON responses carry `X-Warden-Signature-Ed25519` and `X-Warden-Key-Id`. File bytes carry `X-Warden-Sha256` and `X-Warden-Release-Signature`; see [releases.md](releases.md#verifying-a-package).

## Managing files

Open **Apps → app → Releases** to upload, withdraw, restore or delete releases, edit attachment rules, or connect repositories. Maximum size is 100 MB. Deleting a licence leaves the app and its files intact.

```bash
curl -X PUT "https://<worker>/api/v1/apps/harbor-theme/files?name=harbor-theme.zip&version=1.4.0" \
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/zip" --data-binary @harbor-theme.zip
```

When an app has several release tracks, supply `track=<id-or-name>`. See [releases.md](releases.md) and [api.md](api.md).

## A project paid in instalments

Create an app for the project's child theme. Configure an Updates track for Active and a Final build track for Completed. Attach it to the customer's licence under `child-theme`. When the last payment arrives, set that attachment to Completed. Its final build becomes available and that app's access no longer expires. Other attached apps retain their own statuses and expiry rules.

## Limits

Downloaded copies cannot be recalled. A licence key grants access to every app attached to it; tags select among that access and are not separate credentials. Site limits rely on the domain reported by the site. See [Security.md](../Security.md).
