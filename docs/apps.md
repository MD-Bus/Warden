# Apps and licences

An **app** is a product or a custom project: a parent theme, a child theme, a plugin, or a website delivered to one customer. Apps own status definitions, release tracks, files and repository connections.

A **licence** gives a customer access to one or more apps through one key. Each app attachment has a **tag**, a selected status, and optionally its own expiry date. The licence holds the customer details, allowed domains and shared site limit.

## Example: parent and child themes

| Tag | Attached app | Selected status |
|---|---|---|
| `parent-theme` | Harbor Theme | Active |
| `child-theme` | Harbor Studio Child | Completed |
| `booking` | Atlas Booking | Active |

The customer's site stores one licence key. It checks `?tag=parent-theme` for the parent theme and `?tag=child-theme` for its child theme. Other customers can attach different child-theme apps under the same tag.

Tags are unique within a licence. They start with a lowercase letter and contain up to 48 lowercase letters, digits, underscores or hyphens. Keep them stable after a site starts using them. Tags identify app attachments; they are separate from Git version tags and release tracks. An app may appear under several different tags, with independent access settings.

## Creating an app

Open **Apps → New app**. Set its name, identifier, description and optional defaults. Customise its status definitions there if needed. A custom project uses the same app form as a shared product.

An app's default status, duration and public message initialise a new attachment. Duration is used for separate expiry dates. Issuing from an app also prefills the shared expiry and site limit. When attaching several apps from the licence form, choose the shared expiry and site limit explicitly. Grace periods apply live unless overridden on an attachment or licence.

## Creating a licence

Open **Licences → New licence**. Enter customer details and attach apps. For each row, enter a tag, select an app, then choose one of that app's statuses. Up to 50 app attachments are supported.

| Expiry mode | Meaning |
|---|---|
| Shared expiry | One date on the licence applies to every attached app. Renewal extends all of them. |
| Separate expiry | Each attachment has its own date. Renewal names the tag to extend. |

An empty date means no expiry. Statuses without an expiry rule, such as Completed, ignore the date. Shared expiry does not merge statuses or grace periods: apps can have different statuses and different effective grace periods.

Switching from shared to separate in the dashboard copies the shared date into each row. Switching back requires choosing a shared date, or explicitly leaving it empty for no expiry. Review the dates before saving.

## Licence templates

Open **Licence templates** to define reusable tag slots, a default expiry mode, and optional default apps. Slots can be required or optional. Required slots need an app when issuing a licence; optional empty slots are skipped. Selecting an app supplies its status choices.

For a WordPress template, prefill `parent-theme` with Harbor Theme and leave `child-theme` ready for the customer's custom app. Template changes affect future licences only. Existing licences keep their tags, apps and settings.

## Shared site limits and reported versions

Allowed domains and the site limit apply to the entire licence. Parent and child themes checking from `harborstudio.com` consume one slot. Versions are recorded independently for each tag on that domain.

A valid check registers the site. A new domain beyond the limit returns `site_limit_reached`; existing domains keep their slot. **Release site** frees the domain for every attachment and clears its per-tag version reports. The site can register again on its next valid check.

## Releases and deletion

Upload releases and connect repositories on the app. Its selected status determines which track an attachment receives. See [releases.md](releases.md).

Removing an attachment revokes that tag's access and deletes its reported versions. Deleting a licence leaves its apps and their releases intact. Regenerating a key invalidates the previous key for every attachment.

An app cannot be deleted while any licence attaches it, a template selects it, or a migrated project app inherits its releases. Remove those references first.

## Existing installations

Migration 0016 converts standalone licences into project apps and attaches them under `default`. Existing keys and file links keep working. A licence with custom releases gets a project app that retains its overrides and inherits the original app's releases for other statuses. See [upgrade-notes.md](upgrade-notes.md).
