import { Link, useFetcher } from "react-router"
import { ArrowDownToLine, CircleCheck, Plus, RefreshCw, SquarePen } from "lucide-react"
import type { Route } from "./+types/overview"
import { ColumnChart } from "#/components/column-chart"
import { Fact, FactStrip } from "#/components/fact-strip"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { Ago } from "#/components/time"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { StatusBadge } from "#/components/status-badge"
import { useAllStatuses, useStatusLabel } from "#/components/status-context"
import { DEFAULT_COLOR } from "#/lib/statuses"
import { daysUntil, describeExpiry, EXPIRING_WINDOW_DAYS, LAPSED_ATTENTION_DAYS, SILENT_AFTER_DAYS, VIEW_LABELS } from "#/lib/views"
import { cn } from "#/lib/utils"
import { dailyTraffic } from "~/server/analytics.server"
import { requireAuth } from "~/server/auth.server"
import { listApps, outdatedSitesByApp } from "~/server/apps.server"
import { attentionLists, overviewStats, recentEvents } from "~/server/licenses.server"

export const meta: Route.MetaFunction = () => [{ title: "Overview | Warden" }]

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  // The outdated counts depend only on the apps, so they run alongside the other reads.
  const appsWithOutdated = listApps(env).then(async (apps) => ({ apps, outdated: await outdatedSitesByApp(env, apps) }))
  const [stats, attention, events, { apps, outdated }, traffic] = await Promise.all([overviewStats(env), attentionLists(env), recentEvents(env, 60), appsWithOutdated, dailyTraffic(env, {}, 30, Date.now(), "checks")])
  return { stats, attention, events, traffic: traffic.series, apps: apps.map((a) => ({ id: a.id, name: a.name, licenses: a.licenses, valid: a.valid, sites: a.sites, latest_version: a.latest_version, outdated: outdated[a.id] ?? 0 })) }
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { stats, attention, events, apps, traffic } = loaderData
  const checks = traffic.reduce((n, d) => n + d.valid + d.invalid, 0)
  const invalid = traffic.reduce((n, d) => n + d.invalid, 0)
  const statusLabel = useStatusLabel()
  const allStatuses = useAllStatuses()
  const byStatus = Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])
  const needsAttention = attention.expiring.length + attention.lapsed.length + attention.silent.length

  return (
    <>
      <PageHeader crumbs={[{ label: "Overview" }]} />
      <div className="space-y-8 p-4 pt-0 lg:px-6">
        <PageTitle
          title="Overview"
          description={stats.total === 0 ? "Nothing issued yet. Create apps for your products or custom projects, then attach them to a licence." : `${stats.total} licence${stats.total === 1 ? "" : "s"}, ${stats.valid} valid.`}
          actions={
            <>
              <Button asChild variant="outline">
                <Link to="/apps/new">New app</Link>
              </Button>
              <Button asChild>
                <Link to="/licenses/new">
                  <Plus /> New licence
                </Link>
              </Button>
            </>
          }
        />

        <FactStrip>
          <Fact label="Valid licences" to="/licenses?view=valid" value={stats.valid} detail={`of ${stats.total} licences`} help="Licences for which every attached app is valid." />
          <Fact label="Invalid licences" to="/licenses?view=invalid" value={stats.invalid} detail="At least one app is invalid" help="Licences with at least one invalid app, such as pending, suspended, disabled or expired access." />
          <Fact
            label={VIEW_LABELS.expiring}
            to="/licenses?view=expiring&sort=expires&dir=asc"
            value={stats.endingSoon}
            detail="Extend or let them lapse"
            tone={stats.endingSoon > 0 ? "warning" : "default"}
            help={`Valid licences whose expiry date is within the next ${EXPIRING_WINDOW_DAYS} days.`}
          />
          <Fact
            label={VIEW_LABELS.silent}
            to="/licenses?view=silent&sort=last_check&dir=asc"
            value={stats.silent}
            detail="Site offline or check removed"
            tone={stats.silent > 0 ? "warning" : "default"}
            help={`Valid licences with no check in the last ${SILENT_AFTER_DAYS} days. The site may be offline, or the licence check may have been removed from its code.`}
          />
        </FactStrip>

        <section className="rounded-lg border bg-card p-4">
          <ColumnChart
            title="Licence checks, last 30 days"
            description="Checks from customer sites across all licences."
            data={traffic}
            series={[
              { key: "valid", label: "Valid", color: "var(--chart-1)" },
              { key: "invalid", label: "Invalid", color: "var(--chart-2)" },
            ]}
            height={150}
            summary={
              <span className="tabular-nums">
                {checks.toLocaleString("en-GB")} checks{invalid > 0 ? `, ${invalid.toLocaleString("en-GB")} invalid` : ""}
              </span>
            }
            viewAll="/analytics"
          />
        </section>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section className="space-y-3">
            <h2 className="font-semibold">Needs attention</h2>
            {needsAttention === 0 ? (
              <div className="flex items-start gap-3 rounded-lg border bg-card p-4 text-sm">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-600" />
                <p className="text-muted-foreground">
                  No action required. No valid licence expires within {EXPIRING_WINDOW_DAYS} days, none expired in the last {LAPSED_ATTENTION_DAYS} days, and every valid licence has been checked within {SILENT_AFTER_DAYS} days.
                </p>
              </div>
            ) : (
              <div className="divide-y rounded-lg border bg-card">
                {attention.expiring.map((l) => (
                  <div key={`e-${l.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-48 flex-1">
                      <Link to={`/licenses/${l.id}`} prefetch="intent" className="font-medium hover:underline">
                        {l.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {l.app_name ?? "Standalone"}
                        {l.customer_name ? `, ${l.customer_name}` : ""}
                      </div>
                    </div>
                    <span className="text-sm text-amber-700 tabular-nums dark:text-amber-400">
                      {/* Listed licences are valid: one whose date has passed is in its grace period. */}
                      {l.expiry_mode === "separate" ? l.apps?.filter((e) => e.expiring).map((e) => `${e.tag}: ${describeExpiry(e.grace_ends_at ?? e.expires_at)}`).join(", ") : l.expires_at !== null && daysUntil(l.expires_at) < 0 ? `Expired ${describeExpiry(l.expires_at)}, in grace period` : `Expires ${describeExpiry(l.expires_at)}`}
                    </span>
                    {l.expiry_mode === "separate" ? <Button asChild variant="outline" size="sm"><Link to={`/licenses/${l.id}`}>Renew apps</Link></Button> : <QuickExtend licenseId={l.id} />}
                  </div>
                ))}
                {attention.lapsed.map((l) => {
                  const whole = !l.apps?.length || (l.expiry_mode !== "separate" && l.lapsed_tags.length === l.apps.length)
                  return (
                    <div key={`x-${l.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <div className="min-w-48 flex-1">
                        <Link to={`/licenses/${l.id}`} prefetch="intent" className="font-medium hover:underline">
                          {l.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {l.apps?.length ? l.apps.map((a) => a.app_name).join(", ") : (l.app_name ?? "Standalone")}
                          {l.customer_name ? `, ${l.customer_name}` : ""}
                        </div>
                      </div>
                      <span className="text-sm text-red-700 tabular-nums dark:text-red-400">
                        {whole ? `Expired ${describeExpiry(l.lapsed_at)}, sites see it as invalid` : `${l.lapsed_tags.join(", ")}: expired ${describeExpiry(l.lapsed_at)}, invalid`}
                      </span>
                      {l.expiry_mode === "separate" ? <Button asChild variant="outline" size="sm"><Link to={`/licenses/${l.id}`}>Renew apps</Link></Button> : <QuickExtend licenseId={l.id} />}
                    </div>
                  )
                })}
                {attention.silent.map((l) => (
                  <div key={`s-${l.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-48 flex-1">
                      <Link to={`/licenses/${l.id}`} prefetch="intent" className="font-medium hover:underline">
                        {l.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {l.app_name ?? "Standalone"}
                        {l.last_check_domain ? `, last from ${l.last_check_domain}` : ""}
                      </div>
                    </div>
                    <span className="text-sm text-muted-foreground">{l.last_check_at ? <>Last check <Ago ts={l.last_check_at} /></> : "Never checked"}</span>
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/licenses/${l.id}?tab=activity`}>View activity</Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {(stats.endingSoon > attention.expiring.length || stats.silent > attention.silent.length) && (
              <p className="text-xs text-muted-foreground">
                Showing the most urgent. See all{" "}
                <Link className="underline underline-offset-2" to="/licenses?view=expiring&sort=expires&dir=asc">
                  expiring
                </Link>{" "}
                or{" "}
                <Link className="underline underline-offset-2" to="/licenses?view=silent&sort=last_check&dir=asc">
                  silent
                </Link>{" "}
                licences.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Apps</h2>
              <Link to="/apps" className="text-sm text-muted-foreground hover:text-foreground">
                All apps
              </Link>
            </div>
            {apps.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                An app groups the licences of a product you sell to many customers, with shared releases and defaults.{" "}
                <Link to="/apps/new" className="text-foreground underline underline-offset-2">
                  Create one
                </Link>
                .
              </div>
            ) : (
              <ul className="divide-y rounded-lg border bg-card">
                {apps.slice(0, 6).map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <Link to={`/apps/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {a.valid} of {a.licenses} valid, {a.sites} site{a.sites === 1 ? "" : "s"}
                      </div>
                    </div>
                    {a.outdated > 0 && (
                      <Link to={`/apps/${a.id}?tab=releases`}>
                        <Badge variant="warning">{a.outdated} behind</Badge>
                      </Link>
                    )}
                    <span className={cn("font-mono text-xs", !a.latest_version && "font-sans text-muted-foreground")}>{a.latest_version ?? "No release"}</span>
                  </li>
                ))}
              </ul>
            )}

            {byStatus.length > 0 && (
              <div className="space-y-2 pt-2">
                <h3 className="text-sm font-medium">By status</h3>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {byStatus.map(([key, count]) => {
                    const def = allStatuses.find((s) => s.key === key)
                    return (
                      <Link key={key} to={`/licenses?status=${key}`} className="flex items-center gap-1.5 text-sm hover:opacity-80">
                        <StatusBadge status={def ?? { label: key, color: DEFAULT_COLOR }} />
                        <span className="text-muted-foreground tabular-nums">{count}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}
          </section>
        </div>

        <section className="space-y-3">
          <h2 className="font-semibold">Recent activity</h2>
          <div className="rounded-lg border bg-card">
            {events.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">No activity yet. Checks, downloads and changes appear here.</p>
            ) : (
              <ul className="divide-y">
                {groupRepeats(events).slice(0, 12).map(({ event: e, count }) => (
                  <li key={e.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]">
                    <span className="translate-y-0.5 text-muted-foreground" title={e.event === "check" ? "Check" : e.event === "download" ? "Download" : "Change"}>
                      {e.event === "check" ? <RefreshCw className="size-3.5" /> : e.event === "download" ? <ArrowDownToLine className="size-3.5" /> : <SquarePen className="size-3.5" />}
                    </span>
                    <span className="min-w-0 truncate">
                      <Link to={`/licenses/${e.license_id}`} className="font-medium hover:underline">
                        {e.name}
                      </Link>
                      <span className="text-muted-foreground">
                        {" "}
                        {e.event === "check"
                          ? `checked from ${e.domain ?? "no domain"}: ${statusLabel(e.status)}${e.detail ? `, ${e.detail.replace(/^Version /, "version ")}` : ""}`
                          : e.event === "download"
                            ? `${lowerFirst(e.detail)}${e.domain ? ` from ${e.domain}` : ""}`
                            : lowerFirst(e.detail)}
                      </span>
                    </span>
                    <span className="col-start-2 flex items-baseline gap-2 text-xs whitespace-nowrap text-muted-foreground sm:col-start-auto">
                      {count > 1 && <Badge variant="secondary" className="px-1.5 py-0 font-normal tabular-nums">{count}×</Badge>}
                      <Ago ts={e.at} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  )
}

/** Folds consecutive identical events (same licence, kind, status, domain and detail) into one row with a count, newest first. */
function groupRepeats<T extends { license_id: string; event: string; status: string | null; domain: string | null; detail: string }>(events: T[]): { event: T; count: number }[] {
  const out: { event: T; count: number }[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && last.event.license_id === e.license_id && last.event.event === e.event && last.event.status === e.status && last.event.domain === e.domain && last.event.detail === e.detail) last.count++
    else out.push({ event: e, count: 1 })
  }
  return out
}

/** Activity details follow the licence name in a sentence: "Harbor Studio website downloaded: theme.zip". */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** Extends a licence from the overview without opening it. */
function QuickExtend({ licenseId }: { licenseId: string }) {
  const fetcher = useFetcher()
  const busy = fetcher.state !== "idle"
  return (
    <div className="flex gap-1">
      {[30, 365].map((days) => (
        <Button key={days} variant="outline" size="sm" disabled={busy} onClick={() => fetcher.submit({ intent: "renew", days: String(days) }, { method: "post", action: `/licenses/${licenseId}` })}>
          +{days === 365 ? "1 year" : `${days} days`}
        </Button>
      ))}
    </div>
  )
}
