import type { AttachmentFacts } from "#/lib/entitlements"
import { Link, useNavigate } from "react-router"
import { ArrowDown, ArrowUp } from "lucide-react"
import { LicenseStatusBadge, StatusBadge } from "#/components/status-badge"
import { useStatusSets } from "#/components/status-context"
import { DEFAULT_COLOR, DEFAULT_STATUSES, findStatus, type StatusDef } from "#/lib/statuses"
import { Ago } from "#/components/time"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table"
import { daysUntil, describeExpiry, EXPIRING_WINDOW_DAYS } from "#/lib/views"
import { cn } from "#/lib/utils"

export type LicenseRowData = {
  id: string
  apps?: AttachmentFacts[]
  expiry_mode?: string
  name: string
  customer_name: string
  customer_email: string
  license_key: string
  status: string
  expires_at: number | null
  max_sites: number | null
  sites_used?: number
  last_check_at: number | null
  created_at: number
  app_id: string | null
  app_name?: string | null
}

export function formatSites(license: Pick<LicenseRowData, "max_sites" | "sites_used">): string {
  const used = license.sites_used ?? 0
  return license.max_sites === null ? `${used} (no limit)` : `${used} of ${license.max_sites}`
}

export const SORTS = ["created", "name", "expires", "last_check"] as const
export type SortKey = (typeof SORTS)[number]
export type Sort = { key: SortKey; dir: "asc" | "desc" }

/** Sorts licences. Missing dates (no expiry, never checked) go last in either direction. */
export function sortLicenses<T extends LicenseRowData>(licenses: T[], sort: Sort): T[] {
  const value = (l: T): string | number | null => (sort.key === "name" ? l.name.toLowerCase() : sort.key === "expires" ? l.expires_at : sort.key === "last_check" ? l.last_check_at : l.created_at)
  const sign = sort.dir === "asc" ? 1 : -1
  return [...licenses].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    return x < y ? -sign : x > y ? sign : 0
  })
}

function Expiry({ ts }: { ts: number | null }) {
  if (ts === null) return <span className="text-muted-foreground">Never</span>
  const days = daysUntil(ts)
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{new Date(ts).toISOString().slice(0, 10)}</span>
      <span className={cn("text-xs", days < 0 ? "text-red-700 dark:text-red-400" : days <= EXPIRING_WINDOW_DAYS ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{describeExpiry(ts)}</span>
    </span>
  )
}

/** The expiry shown under the licence name on phones, where the Expires column is hidden: the soonest date of its apps. */
function PhoneExpiry({ license }: { license: LicenseRowData }) {
  const dates = license.expiry_mode === "separate" ? (license.apps ?? []).flatMap((a) => (a.expires_at === null ? [] : [a.expires_at])) : license.expires_at === null ? [] : [license.expires_at]
  if (!dates.length) return null
  const ts = Math.min(...dates)
  const past = ts < Date.now()
  return (
    <div className={cn("text-xs md:hidden", past ? "text-red-700 dark:text-red-400" : daysUntil(ts) <= EXPIRING_WINDOW_DAYS ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
      {past ? "Expired" : "Expires"} {describeExpiry(ts)}
    </div>
  )
}

/** The status sites receive for each attached app, grouped when several apps share one. */
function AppStatuses({ apps }: { apps: AttachmentFacts[] }) {
  const sets = useStatusSets()
  const groups = new Map<string, { def: Pick<StatusDef, "label" | "color">; tags: string[] }>()
  for (const a of apps) {
    const def = findStatus(sets.byApp[a.app_id] ?? DEFAULT_STATUSES, a.effective_status) ?? { label: a.effective_status, color: DEFAULT_COLOR }
    const key = `${def.label}|${def.color}`
    const group = groups.get(key) ?? { def, tags: [] }
    group.tags.push(a.tag)
    groups.set(key, group)
  }
  const valid = apps.filter((a) => a.valid).length
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {[...groups.values()].map(({ def, tags }) => (
          <span key={`${def.label}${def.color}`} title={tags.join(", ")} className="inline-flex flex-col items-start gap-1 sm:flex-row sm:items-center">
            <StatusBadge status={def} />
            {groups.size > 1 && <span className="font-mono text-[11px] whitespace-normal text-muted-foreground">{tags.join(", ")}</span>}
          </span>
        ))}
      </div>
      {apps.length > 1 && valid !== apps.length && <span className="text-xs whitespace-normal text-muted-foreground">{valid} of {apps.length} apps valid</span>}
    </div>
  )
}

function SortHead({ label, by, sort, onSort, className }: { label: string; by: SortKey; sort?: Sort; onSort?: (sort: Sort) => void; className?: string }) {
  if (!sort || !onSort) return <TableHead className={className}>{label}</TableHead>
  const active = sort.key === by
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={cn("-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground", active && "text-foreground")}
        onClick={() => onSort({ key: by, dir: active ? (sort.dir === "asc" ? "desc" : "asc") : by === "name" || by === "expires" ? "asc" : "desc" })}
      >
        {label}
        {active && <Icon className="size-3.5" />}
      </button>
    </TableHead>
  )
}

/** A table of licences. Rows open the licence. The App column is shown for lists that mix apps; sorting when `onSort` is given. */
export function LicensesTable({ licenses, showApp = true, empty = "No licence matches.", sort, onSort }: { licenses: LicenseRowData[]; showApp?: boolean; empty?: React.ReactNode; sort?: Sort; onSort?: (sort: Sort) => void }) {
  const navigate = useNavigate()
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead label="Licence" by="name" sort={sort} onSort={onSort} />
            {showApp && <TableHead className="hidden lg:table-cell">App</TableHead>}
            <TableHead>Status</TableHead>
            <SortHead label="Expires" by="expires" sort={sort} onSort={onSort} className="hidden md:table-cell" />
            <TableHead className="hidden md:table-cell">Sites</TableHead>
            <SortHead label="Last check" by="last_check" sort={sort} onSort={onSort} className="hidden sm:table-cell" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {licenses.map((l) => (
            <TableRow
              key={l.id}
              className="cursor-pointer"
              onClick={(e) => {
                // Let links and text selection inside the row behave normally.
                if ((e.target as HTMLElement).closest("a") || window.getSelection()?.toString()) return
                navigate(`/licenses/${l.id}`)
              }}
            >
              <TableCell className="max-w-44 sm:max-w-72">
                <Link to={`/licenses/${l.id}`} prefetch="intent" className="block truncate font-medium hover:underline">
                  {l.name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{l.customer_name || l.customer_email || <span className="font-mono">{l.license_key}</span>}</div>
                <PhoneExpiry license={l} />
              </TableCell>
              {showApp && (
                <TableCell className="hidden lg:table-cell">
                  {l.apps?.length ? <div className="space-y-1">{l.apps.map((e) => <Link key={e.tag} to={`/apps/${e.app_id}`} className="block hover:underline">{e.app_name} <span className="font-mono text-xs text-muted-foreground">{e.tag}</span></Link>)}</div> : l.app_id ? (
                    <Link to={`/apps/${l.app_id}`} className="hover:underline">
                      {l.app_name}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Standalone</span>
                  )}
                </TableCell>
              )}
              <TableCell>
                {l.apps?.length ? <AppStatuses apps={l.apps} /> : <LicenseStatusBadge license={l} />}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {l.expiry_mode === "separate" ? <div className="space-y-2">{l.apps?.map((e) => <div key={e.tag}><span className="font-mono text-xs text-muted-foreground">{e.tag}</span><Expiry ts={e.expires_at} /></div>)}</div> : <Expiry ts={l.expires_at} />}
              </TableCell>
              <TableCell className="hidden tabular-nums md:table-cell">{l.max_sites === null ? (l.sites_used ?? 0) : `${l.sites_used ?? 0} / ${l.max_sites}`}</TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">
                <Ago ts={l.last_check_at} />
              </TableCell>
            </TableRow>
          ))}
          {licenses.length === 0 && (
            <TableRow>
              <TableCell colSpan={showApp ? 6 : 5} className="py-10 text-center text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
