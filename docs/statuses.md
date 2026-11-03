# Statuses

Each app defines a set of statuses. Each tagged app attachment on a licence selects one status from that set. The parent theme can be Active while the child theme is Completed, even though they share one key.

## Where statuses come from

Edit definitions on **Apps → app → Statuses**. Apps without custom definitions use the built-in defaults. A licence inherits each attached app's definitions and cannot define a status set of its own. Changing a definition applies to every attachment of that app.

Choose an attachment's current status on its licence page. This changes access to that app only. There is no single selected status for a licence covering several apps.

## The default statuses

| Status | Valid | Expiry date | Meaning |
|---|---|---|---|
| Pending | No | Does not apply | Issued but not valid yet, for example until the first payment |
| Active | Yes | Becomes Expired | Valid. The default for new licences |
| Completed | Yes | Does not apply | Paid in full. Permanent |
| Suspended | No | Does not apply | Temporarily on hold, for example for a late payment |
| Disabled | No | Does not apply | Permanently switched off |
| Expired | No | Does not apply | Past its expiry date. Applied automatically |

Once customised, these are ordinary statuses: you can delete any of them, including Expired, as long as the set keeps at least one status and one default.

## What a status contains

| Field | Meaning |
|---|---|
| **Label** | The name shown in the dashboard, up to 40 characters |
| **Identifier** (`key`) | Stored on licences and used in the API. Lowercase letters, digits and underscores, starting with a letter, up to 32 characters. Generated from the label. **It cannot be changed after the status is created**; rename the label instead. `unknown`, `domain_mismatch` and `site_limit_reached` are reserved for check results |
| **Description** | Explains the status to you. Shown in the status menu |
| **Colour** (`color`) | The badge colour, any hex colour such as `#16a34a`. The editor offers a colour picker and presets for green, teal, blue, purple, pink, amber, red and grey |
| **Valid status** (`grants_access`) | When on, checks return `valid: true`. When off, checks return `valid: false` and the site applies its own handling |
| **When the expiry date passes** (`on_expiry`) | The status a licence takes on, as seen by sites, once its expiry date has passed. Active becomes Expired by default. Choose "Nothing" for statuses the expiry date should not affect, such as a paid-in-full status |
| **Message to sites** (`check_message`) | Returned in the check response when the licence has no public message of its own |
| **Default for new licences** | New licences start with this status. Exactly one per set |

The licence keeps its stored status; the expiry rule is applied when the licence is read. A licence stored as Active with a past expiry date is reported to sites as Expired, shown as Expired in the dashboard, and extending its expiry date makes it Active again without any change to the stored status.

## Grace period

The effective expiry date is the licence's date in shared mode, or the attachment's date in separate mode. The grace period comes from the licence override, then the attachment override, then the app's live setting, otherwise zero. Zero explicitly disables grace; null inherits.

During grace, Active remains valid, `grace_ends_at` names the end, and the check message reminds the site owner to renew unless a public message overrides it. When grace ends, the app status's expiry rule applies. Completed has no expiry rule and ignores both date and grace.

A shared date can therefore produce different grace-end times on different apps. Set a licence-wide grace override for one common grace period. Renewal while any selected app is in grace extends from the original date. Once grace is over it extends from today. Separate renewal affects only the selected tag.

## Editing and deleting definitions

Customise a copy of the defaults when creating an app or from its Statuses tab. Definitions can be reordered, edited, added and removed. Keys remain stable; labels and colours can change. Exactly one status must be the default.

Deleting a status in use requires a replacement from the same app. Attachments using it move to that replacement. File, track and repository rules are updated, and expiry rules pointing to the removed key are cleared. Resetting to the built-in defaults requires mapping any unsupported status in use.

A migrated custom project has its own app. If it inherits releases from an earlier app, its status keys must continue matching the inherited release rules. Configure app tracks to override a status when the project needs different files.

## Check response

```json
{ "tag": "parent-theme", "app": { "id": "app_...", "slug": "harbor-theme", "name": "Harbor Theme" }, "valid": true, "status": "active", "message": "", "expires_at": "2027-11-03T23:59:59.999Z" }
```

Without a tag, a multi-app check returns an `apps` array with one independent result per tag. Decide by that app's `valid`, and show its `message`. See [checking.md](checking.md).

## API

Use `/apps/{app}/statuses` to read definitions, `/statuses/customize` to start customising, and `/statuses/{key}` to edit or delete. Set a selected status with `POST /licenses/{id}/status` and `{ "tag": "parent-theme", "status": "suspended" }`. See [api.md](api.md).
