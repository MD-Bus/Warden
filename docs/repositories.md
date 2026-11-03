# Publishing releases from a repository

Each release track ([releases.md](releases.md#tracks)) can be connected to a GitHub repository. Connect GitHub once under **Integrations**, then pick a repository from a list. When you push a version tag, Warden downloads the repository at that tag as a zip, renames its top-level folder and publishes it into the track, exactly as if you had uploaded the file yourself. Sites whose licence status that track serves are then offered the update.

Several tracks can each have a repository (for example `harbor-theme` for Updates and `harbor-theme-final` for the Final build), or share one repository with different **tag prefixes** (`v1.4.0` for Updates, `final-v1.4.0` for the Final build).

![Connecting GitHub on the Integrations page](screenshots/integrations.jpg)

Nothing is built: the repository is published as it is. This suits themes and plugins whose repository is the package. A project that needs a build step can upload its build with the API from its pipeline instead (see [releases.md](releases.md)).

## Connecting GitHub (once)

Open **Integrations**, GitHub, **Create GitHub App**. Warden creates a GitHub App of its own through GitHub's app manifest flow:

1. GitHub shows the app Warden asks for, owned by your personal account or an organisation. It can read repository contents and metadata and receives push events, nothing else. You can change its name before confirming; names are unique across GitHub.
2. GitHub returns the app's credentials to Warden, and opens the installation page: install the app on the account or organisation that owns your repositories, for all repositories or selected ones.
3. Back on Integrations, Warden lists the installations. *Install on another account* adds one; *Configure on GitHub* changes which repositories an installation covers.

The app's webhook points at `https://<your-worker>/hooks/github-app`, one address for every repository, and is signed with a secret GitHub generated for the app. Nothing has to be copied by hand. Warden must be reachable at its public address for the app's webhook; GitHub does not deliver to `localhost`.

The app's private key and webhook secret are stored in your D1 database. Warden uses the key to request access tokens that last one hour and only read repository contents. *Remove from Warden* forgets the credentials (not possible while repositories still use the app); delete the app on GitHub as well, under the app's settings, *Advanced*.

## Connecting a repository

Open the app (or the licence), *Releases* tab, and *Connect repository* in the track that should receive the releases.

| Field | Meaning |
|---|---|
| Repository | Picked from the repositories the GitHub App can access, private ones included. A repository missing from the list is added to the installation on GitHub. |
| Trigger | *New tag*: pushing a tag publishes a release (see below). Other triggers can be added later. |
| Tag prefix | Optional. Tags of this track start with it: `final-` takes `final-v1.4.0`. Needed when two tracks use the same repository; each repository and prefix can feed one track only. |
| Package folder | The top-level folder inside the published zip, for example `harbor-theme`. Defaults to the repository name. |

Which licences receive the published releases, and the domain check, are the track's settings, not the repository's.

Warden checks that it can read the repository before saving. A repository is matched by its id, so renaming it on GitHub does not break the connection; Warden shows the new name after the next tag.

### Without the GitHub App: an access token and a webhook

*Connect with an access token and a webhook instead* (or the only option before GitHub is connected) works without installing an app, for one repository at a time:

| Field | Meaning |
|---|---|
| Repository | `owner/repository`, or its github.com address. |
| Access token | Only for a private repository: a fine-grained personal access token limited to that repository, with read-only access to *Contents*. Stored in your D1 database and never shown again. |

After connecting, Warden shows the values to enter in GitHub, under the repository's *Settings, Webhooks, Add webhook*:

- **Payload URL**: `https://<your-worker>/hooks/github/<source id>`
- **Content type**: `application/json`
- **Secret**: the secret Warden shows
- **Which events**: *Just the push event*

GitHub sends a test delivery when the webhook is created; the section then shows the time of the last delivery. Every delivery is signed with the secret (`X-Hub-Signature-256`), and Warden rejects deliveries with a wrong signature. *Generate a new secret* (in *Webhook setup*) replaces it; update it in GitHub afterwards.

## What a tag publishes

| Tag | Result |
|---|---|
| `v1.4.0` or `1.4.0` | Version `1.4.0` on the stable channel, file `<package folder>-1.4.0.zip`, in the track without prefix |
| `final-v1.4.0` | Version `1.4.0` in the track whose tag prefix is `final-` |
| `v2.0.0-beta.1` | Version `2.0.0-beta.1` on the beta channel |
| `nightly`, or any tag that is not a version after the prefix | Skipped |
| A version that is already published in the same track (and not withdrawn) | Skipped; withdraw or delete that release, then retry. Other tracks can publish the same version |

With several tracks on one repository, a tag goes to the track whose prefix it matches most specifically: `final-v1.4.0` goes to `final-`, not to the track without prefix.
| A branch push | Nothing |

The internal notes of each published release record the repository, the tag and the commit.

**The package folder.** GitHub wraps the archive in a folder named after the commit, such as `harbor-studio-harbor-theme-3f2a9c1/`. WordPress installs a theme or plugin into the folder found in the zip, so that name would change with every release. Warden renames it to the package folder, so every release installs into the same place. Only the zip's headers are rewritten; the files are copied unchanged, and the archive comment (GitHub stores the commit there) is kept.

To leave files out of the package, such as tests or development configuration, mark them `export-ignore` in the repository's `.gitattributes`; GitHub leaves them out of the archive:

```
/tests          export-ignore
/.github        export-ignore
phpunit.xml     export-ignore
```

## Recent tags

The section lists the latest tags with their state: *In progress* (with the current step, such as "Repacking the archive: part 3 of 5 written."), *Published*, *Skipped* or *Failed*, with the reason. *Retry* runs a failed or skipped tag again. GitHub may deliver the same webhook more than once; a tag is published only once.

*Publish a tag* publishes an existing tag by hand, for example one pushed before the webhook was added.

*Pause publishing* keeps the connection but ignores new tags; *Disconnect repository* removes it. Releases already published stay in both cases. For a repository connected with a token, remove its webhook in GitHub after disconnecting.

## Limits

- Packages are limited to 100 MB, like uploads. An archive over the limit is refused while it downloads.
- Publishing runs in the background after the webhook is answered, in three steps: the archive is downloaded into R2, repacked into the release's file 10 MB at a time, then recorded. Each step saves its progress, which keeps memory and CPU time low enough for the Workers free plan whatever the size of the repository (a 46 MB WordPress archive uses about 0.2 s of CPU).
- If Cloudflare stops an import midway (a Workers CPU, memory or time limit), the scheduled run resumes it from the last part written within 10 minutes. An import stopped 3 times without progress, or still in progress after 6 hours, is reported as failed and can be retried.
- To make archives smaller, leave out what the package does not need with `export-ignore` (see [What a tag publishes](#what-a-tag-publishes)).
- A repository connected with neither the GitHub App nor an access token is read anonymously: GitHub allows 60 API requests per hour from the Worker's address. Publishing a tag uses one or two.

## API

A track's repository is managed under the track: `/apps/{app}/tracks/{track}/source` (and `/apps/{app}/tracks/{track}/source`), where `{track}` is the track's id or name.

| Method and path | Scope | Description |
|---|---|---|
| `GET .../tracks/{track}/source` | read | The connected repository. `webhook_secret` is returned to keys with `manage` or `full` only; the access token is never returned (`has_token`) |
| `PUT .../tracks/{track}/source` | manage | Connect or edit: `connection` (`app` or `token`; a new source uses `app` when the GitHub App is connected and no token is sent), `provider`, `repository`, `trigger`, `tag_prefix`, `package_folder`, `token` (`""` removes it), `enabled`. Fields left out keep their value |
| `DELETE .../tracks/{track}/source` | manage | Disconnect |
| `POST .../tracks/{track}/source/regenerate-secret` | manage | Replace the webhook secret |
| `GET .../tracks/{track}/source/imports` | read | Latest tags and their state |
| `POST .../tracks/{track}/source/imports` | manage | Publish a tag: `{ "tag": "v1.4.0" }` |
| `POST .../tracks/{track}/source/imports/{id}/retry` | manage | Retry a failed or skipped tag |

| Method and path | Scope | Description |
|---|---|---|
| `GET /integrations/github` | read | `{ connected, app, installations }`: the app's name, owner and address, and each installation's account and repository selection. Never the app's key or secrets |
| `GET /integrations/github/repositories` | read | The repositories the app can access: `{ id, full_name, private, account }` |

The GitHub App itself is created in the dashboard, because GitHub's confirmation happens in the browser.

```bash
# a track for the final build, fed by the same repository with tags like final-v1.0.0
curl -X POST https://<worker>/api/v1/apps/harbor-theme/tracks \
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Final build","statuses":["completed"]}'
curl -X PUT "https://<worker>/api/v1/apps/harbor-theme/tracks/Final%20build/source" \
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/json" \
  -d '{"repository":"harbor-studio/harbor-theme","tag_prefix":"final-","package_folder":"harbor-theme"}'
```
