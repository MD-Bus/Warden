import { useEffect, useState } from "react"
import { Link, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router"
import { ArrowDownToLine, KeyRound, Plus, Search, X } from "lucide-react"
import type { Route } from "./+types/licenses"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { LicensesTable, SORTS, sortLicenses, type Sort, type SortKey } from "#/components/licenses-table"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { NativeSelect } from "#/components/ui/native-select"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty"
import { statusSetForLicense, useAllStatuses, useStatusSets } from "#/components/status-context"
import { filterLicenses, inView, LICENSE_VIEWS, readLicenseFilter, VIEW_LABELS } from "#/lib/views"
import { cn } from "#/lib/utils"
import { requireAuth } from "~/server/auth.server"
import { listApps } from "~/server/apps.server"
import { queryLicenses } from "~/server/licenses.server"

/** The dashboard list shows the newest licences up to this number. The API and the CSV export reach all of them. */
const LIST_LIMIT = 1000

export const meta: Route.MetaFunction = () => [{ title: "Licences | Warden" }]

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const [licenses, apps] = await Promise.all([queryLicenses(env, { limit: LIST_LIMIT + 1 }), listApps(env)])
  return { licenses: licenses.slice(0, LIST_LIMIT), truncated: licenses.length > LIST_LIMIT, apps: apps.map((a) => ({ id: a.id, name: a.name })) }
}

/** Filtering and sorting happen in the page; changing them needs no new data. */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname) return false
  return defaultShouldRevalidate
}

export default function Licenses({ loaderData }: Route.ComponentProps) {
  const { licenses, apps, truncated } = loaderData
  const [params, setParams] = useSearchParams()
  const filter = readLicenseFilter(params)
  const sortParam = params.get("sort") ?? ""
  const sort: Sort = { key: (SORTS as readonly string[]).includes(sortParam) ? (sortParam as SortKey) : "created", dir: params.get("dir") === "asc" ? "asc" : "desc" }
  const sets = useStatusSets()
  const allStatuses = useAllStatuses()
  const now = Date.now()
  const setOf = (l: (typeof licenses)[number]) => statusSetForLicense(sets, l)

  // The search box updates the address after a short pause, so typing stays fluid.
  const [query, setQuery] = useState(filter.q)
  useEffect(() => setQuery(filter.q), [filter.q])
  useEffect(() => {
    if (query === filter.q) return
    const timer = setTimeout(() => update({ q: query }), 200)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  function update(changes: Record<string, string>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      },
      { replace: true, preventScrollReset: true }
    )
  }

  const shown = sortLicenses(filterLicenses(licenses, filter, setOf, now), sort)
  const viewCounts = Object.fromEntries(LICENSE_VIEWS.map((v) => [v, licenses.filter((l) => inView(l, setOf(l), v, now)).length]))
  const filtered = Boolean(filter.q || filter.status || filter.app || filter.view)
  const exportQuery = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString()

  return (
    <>
      <PageHeader crumbs={[{ label: "Licences" }]} />
      <div className="space-y-5 p-4 pt-0 lg:px-6">
        <PageTitle
          title="Licences"
          description={`${licenses.length}${truncated ? "+" : ""} licence${licenses.length === 1 ? "" : "s"} across ${apps.length} app${apps.length === 1 ? "" : "s"}.`}
          actions={
            <>
              {licenses.length > 0 && (
                <Button asChild variant="outline">
                  <a href={`/licenses/export.csv${exportQuery ? `?${exportQuery}` : ""}`} download>
                    <ArrowDownToLine /> Export CSV
                  </a>
                </Button>
              )}
              <Button asChild>
                <Link to="/licenses/new">
                  <Plus /> New licence
                </Link>
              </Button>
            </>
          }
        />

        {licenses.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRound />
              </EmptyMedia>
              <EmptyTitle>No licences yet</EmptyTitle>
              <EmptyDescription>Issue a licence for a customer&apos;s site. You get a licence key and a check URL to put in that site&apos;s code.</EmptyDescription>
            </EmptyHeader>
            <Button asChild>
              <Link to="/licenses/new">
                <Plus /> New licence
              </Link>
            </Button>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick views">
              {[{ id: "", label: "All", count: licenses.length }, ...LICENSE_VIEWS.map((v) => ({ id: v, label: VIEW_LABELS[v], count: viewCounts[v] }))].map((v) => (
                <button
                  key={v.id || "all"}
                  type="button"
                  aria-pressed={filter.view === v.id}
                  onClick={() => update({ view: v.id })}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    filter.view === v.id ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                    (v.id === "expiring" || v.id === "silent") && v.count > 0 && filter.view !== v.id && "border-amber-500/50 text-amber-700 dark:text-amber-400"
                  )}
                >
                  {v.label} <span className="tabular-nums opacity-70">{v.count}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-52 flex-1 sm:max-w-sm">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 opacity-50" />
                <Input className="pl-9" placeholder="Name, customer, key, domain or reference" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search licences" />
              </div>
              <div className="w-48">
                <NativeSelect value={filter.app} onChange={(e) => update({ app: e.target.value })} aria-label="Filter by app">
                  <option value="">All apps</option>
                  {apps.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="w-44">
                <NativeSelect value={filter.status} onChange={(e) => update({ status: e.target.value })} aria-label="Filter by status">
                  <option value="">All statuses</option>
                  {allStatuses.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {filtered && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setQuery("")
                    update({ q: "", app: "", status: "", view: "" })
                  }}
                >
                  <X /> Clear filters
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground">Valid means every attached app is valid. Invalid includes licences with any invalid app. Expiring and silent match any attached app.</p>
            <LicensesTable
              licenses={shown}
              sort={sort}
              onSort={(next) => update({ sort: next.key === "created" ? "" : next.key, dir: next.key === "created" && next.dir === "desc" ? "" : next.dir })}
              empty={filtered ? "No licence matches these filters." : "No licences."}
            />
            <p className="text-xs text-muted-foreground">
              {shown.length === licenses.length ? `${shown.length} licences` : `${shown.length} of ${licenses.length} licences`}
              {truncated && `. The list shows the newest ${LIST_LIMIT}; the CSV export and the API include all of them.`}
            </p>
          </>
        )}
      </div>
    </>
  )
}
