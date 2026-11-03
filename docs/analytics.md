# Analytics

The **Analytics** page shows the licence traffic of the installation: the checks your customers' sites make and the downloads of your files, per day. It answers questions such as:

![The Analytics page](screenshots/analytics.jpg)

- Are sites still checking in, or did checks drop (sites offline, the check removed from their code)?
- How many checks are invalid, and why: a suspended or expired licence, a domain that is not allowed, a site limit reached?
- How many sites are active, and how many are new?
- Which licences generate the most checks, and which files are downloaded?

It is not visitor analytics for your customers' websites: Warden only sees the calls to its check and download URLs.

## On the page

| Part | What it shows |
|---|---|
| Period and app | 7, 30 or 90 days, ending today; every licence, the licences of one app, or one licence. Both are kept in the address, so a view can be bookmarked |
| Checks | Every call of a check URL in the period, and the share answered as valid |
| Invalid checks | Checks answered with `valid: false` |
| Active sites | Distinct sites (a licence on a domain) that checked in during the period, and how many registered for the first time |
| Downloads | Completed file downloads, and denied downloads (requests for a file the licence's status does not release) |
| Checks per day | Valid and invalid checks, stacked |
| Active sites per day, downloads per day | One column per day |
| Invalid checks by reason | The status returned (for example *Suspended* or *Expired*), *Domain not allowed* or *Site limit reached* |
| Top licences by checks | Licences ranked by checks, with their invalid checks |
| Top files by downloads | Files ranked by completed downloads |
| Top IP addresses | Checks, invalid checks, downloads and distinct licences per client IP address. Select an address to block it ([protection.md](protection.md)) |
| Blocked and rate-limited requests | Checks and downloads rejected before licence validation (all licences only, approximate) |

Lists show their first eight rows; **View all** shows up to 100. The charts on the overview, an app and a licence have **View all**, which opens this page filtered on them.

Hover a day (or focus a chart and use the arrow keys) to read its values. **Table** switches any chart to a table of every day.

The overview shows the checks of the last 30 days across all licences, each app shows its own on its page, and each licence's activity log.

## How the figures are computed

- Days are calendar days in UTC.
- A check is **valid** if the status recorded with it is valid, read against the licence's statuses as they are today. If you later change whether a status is valid, its past checks are counted the new way.
- Checks rejected for the domain or the site limit do not register a site, so they do not count towards active sites.
- Checks are deleted after 90 days by the daily scheduled job, which is why no period goes further back. Downloads and changes are kept.
- Nothing is pre-aggregated: the figures are read from the activity log each time a page is opened. D1 bills rows read. A site checking about twice a day adds about 60 check rows per 30 days. The overview chart reads those rows once (300 sites: about 18,000 rows per load). The Analytics page reads them about six times (300 sites over 90 days: about 330,000 rows). The D1 free plan allows 5 million rows read per day.

## API

`GET /api/v1/analytics` returns the same report (scope `read`):

| Parameter | Values |
|---|---|
| `days` | `7`, `30` (default) or `90` |
| `app` | An app id or slug. `none` is retained for legacy API-created standalone licences |
| `license` | A licence id or key (takes precedence over `app`) |

The report also has `ips` (top IP addresses) and, for all licences, `totals.blocked` and `totals.rate_limited`.

```json
{
  "days": 30,
  "from": 1757548800000,
  "to": 1760097600000,
  "series": [{ "date": "2026-09-11", "valid": 18, "invalid": 0, "sites": 8, "downloads": 0 }],
  "totals": { "checks": 742, "valid": 683, "invalid": 59, "sites": 10, "new_sites": 10, "downloads": 23, "denied_downloads": 1, "blocked": 0, "rate_limited": 0 },
  "reasons": [{ "key": "suspended", "label": "Suspended", "checks": 25 }],
  "licenses": [{ "id": "lic_...", "name": "Harbor Studio website", "app_name": "Harbor Theme", "checks": 213, "invalid": 3, "last_check_at": 1760090000000 }],
  "files": [{ "name": "harbor-theme-1.4.0.zip", "downloads": 15 }],
  "ips": [{ "ip": "198.51.100.23", "checks": 211, "invalid": 0, "downloads": 4, "licenses": 1, "blocked": false }]
}
```

## Tagged apps

Each check result and download records its app and tag. App reports use that event context, so checking the child theme does not count as parent-theme traffic. A batch check records one result per app. The licence list and overview count fully valid licences when every app is valid; invalid includes any invalid app. Version adoption uses the version reported for that app attachment.
