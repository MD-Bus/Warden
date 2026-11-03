import type { Route } from "./+types/licenses.export"
import { toCsv } from "#/lib/csv"
import { effectiveStatusKey, grantsAccess } from "#/lib/statuses"
import { filterLicenses, readLicenseFilter } from "#/lib/views"
import { requireAuth } from "~/server/auth.server"
import { queryLicenses } from "~/server/licenses.server"
import { loadStatusSets, setForLicense } from "~/server/statuses.server"

/** The most licences one export contains. */
const EXPORT_LIMIT = 50_000

const iso = (ts: number | null) => (ts ? new Date(ts).toISOString() : "")

/** GET /licenses/export.csv with the licence list's filters (q, status, app, view): the matching licences as CSV. */
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const filter = readLicenseFilter(new URL(request.url).searchParams)
  const sets = await loadStatusSets(env)
  const now = Date.now()
  const licenses = filterLicenses(await queryLicenses(env, { limit: EXPORT_LIMIT }), filter, (l) => setForLicense(sets, l), now)

  const header = ["id", "name", "customer_name", "customer_email", "app", "key", "status", "stored_status", "valid", "expires_at", "max_sites", "sites_used", "allowed_domains", "external_ref", "last_check_at", "last_check_domain", "check_count", "created_at", "tag", "expiry_mode"]
  const rows = licenses.flatMap((l) => {
    if(l.apps?.length) return l.apps.map((e) => [l.id,l.name,l.customer_name,l.customer_email,e.app_slug,l.license_key,e.effective_status,e.status,e.valid,iso(e.expires_at),l.max_sites ?? "",l.sites_used ?? 0,l.domains,l.external_ref ?? "",iso(e.last_check_at),l.last_check_domain ?? "",l.check_count,iso(l.created_at),e.tag,l.expiry_mode ?? "shared"])
    const set=setForLicense(sets,l), status=effectiveStatusKey(l,set,now)
    return [[l.id,l.name,l.customer_name,l.customer_email,l.app_slug ?? "",l.license_key,status,l.status,grantsAccess(set,status),iso(l.expires_at),l.max_sites ?? "",l.sites_used ?? 0,l.domains,l.external_ref ?? "",iso(l.last_check_at),l.last_check_domain ?? "",l.check_count,iso(l.created_at),"", "legacy"]]
  })
  const csv = toCsv([header, ...rows])
  const stamp = new Date(now).toISOString().slice(0, 10)
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="warden-licences-${stamp}.csv"`, "cache-control": "no-store" },
  })
}
