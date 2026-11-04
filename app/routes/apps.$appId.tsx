import { useState } from "react"
import { Link, redirect, type ShouldRevalidateFunctionArgs } from "react-router"
import { ArrowDownToLine, ChartColumn, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import type { Route } from "./+types/apps.$appId"
import { ColumnChart } from "#/components/column-chart"
import { ConfirmAction } from "#/components/confirm-action"
import { Fact, FactStrip } from "#/components/fact-strip"
import { FilesSection } from "#/components/files-section"
import { LicensesTable } from "#/components/licenses-table"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { onlyTabChanged, RouteTabs, useRouteTab } from "#/components/route-tabs"
import { VersionAdoption } from "#/components/version-adoption"
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert"
import { Button } from "#/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu"
import { StatusSection } from "#/components/status-section"
import { DEFAULT_STATUSES, statusLabel } from "#/lib/statuses"
import { dailyTraffic } from "~/server/analytics.server"
import { requireAuth } from "~/server/auth.server"
import { deleteApp, getApp, getAppSummary, versionsInUse, type App } from "~/server/apps.server"
import { applyFileForm, listFiles, storageConfigured } from "~/server/files.server"
import { applySourceForm, trackPanels } from "~/server/sources.server"
import { applyTrackForm, listAppTracks } from "~/server/tracks.server"
import { getGitHubApp } from "~/server/github-app.server"
import { applyStatusForm, getStatusSetForApp, hasCustomSet, statusCounts } from "~/server/statuses.server"
import { queryLicenses } from "~/server/licenses.server"

export const meta: Route.MetaFunction = ({ data }) => [{ title: `${data?.app.name ?? "App"} | Warden` }]

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const app = await getAppSummary(env, params.appId)
  if (!app) throw new Response("App not found", { status: 404 })
  // Everything the page shows is read at once; only the status counts wait, and only for an app with its own statuses.
  const [custom, licenses, files, statuses, versions, traffic, tracks, githubApp, baseApp, baseFiles, baseTracks, projects] = await Promise.all([
    hasCustomSet(env, { app: app.id }),
    queryLicenses(env, { appId: app.id, limit: 1000 }),
    listFiles(env, { app }),
    getStatusSetForApp(env, app.id),
    versionsInUse(env, app.id),
    dailyTraffic(env, { app: app.id }, 30, Date.now(), "checks"),
    trackPanels(env, { app }, new URL(request.url).origin),
    getGitHubApp(env),
    // A project app created by migration 0016 inherits the releases of its base app.
    app.base_app_id ? getApp(env, app.base_app_id) : Promise.resolve(null),
    app.base_app_id ? listFiles(env, { app: { id: app.base_app_id } as App }) : Promise.resolve([]),
    app.base_app_id ? listAppTracks(env, app.base_app_id) : Promise.resolve([]),
    // And the other way round: the project apps that inherit this app's releases.
    env.DB.prepare("SELECT id, name FROM apps WHERE base_app_id = ? ORDER BY name").bind(app.id).all<{ id: string; name: string }>().then((r) => r.results),
  ])
  // The base app's releases apply only to the statuses the project's own tracks do not serve.
  const covered = new Set(tracks.flatMap((p) => p.track.statuses))
  const inherited = baseApp
    ? {
        appName: baseApp.name,
        appHref: `/apps/${baseApp.id}`,
        statuses,
        tracks: baseTracks.map((t) => ({ ...t, statuses: t.statuses.split(","), check_domain: t.check_domain === 1 })),
        files: baseFiles.map((f) => (f.track_id ? { ...f, statuses: f.statuses.split(",").filter((s) => !covered.has(s)).join(",") } : f)),
      }
    : null
  const usage = custom ? await statusCounts(env, { app: app.id }) : {}
  return { app, inherited, projects, licenses, files, statuses, custom, usage, versions, traffic: traffic.series, filesConfigured: storageConfigured(env), tracks, githubApp: githubApp !== null }
}

export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return onlyTabChanged(args) ? false : args.defaultShouldRevalidate
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const app = await getApp(env, params.appId)
  if (!app) throw new Response("App not found", { status: 404 })
  const form = await request.formData()
  const intent = String(form.get("intent"))

  if (intent.endsWith("-status") || intent.endsWith("-statuses")) return applyStatusForm(env, { app: app.id }, form)
  const fileResult = await applyFileForm(env, { app }, form)
  if (fileResult) return fileResult
  const trackResult = await applyTrackForm(env, { app }, form)
  if (trackResult) return trackResult
  const sourceResult = await applySourceForm(env, context.cloudflare.ctx, { app }, form)
  if (sourceResult) return sourceResult
  if (intent === "delete") {
    const result = await deleteApp(env, app)
    if ("error" in result) return { error: result.error }
    return redirect("/apps")
  }
  return { ok: true as const }
}

const TABS = ["licences", "releases", "statuses"]

export default function AppPage({ loaderData, actionData }: Route.ComponentProps) {
  const actionError = actionData && "error" in actionData ? actionData.error : null
  const { app, inherited, projects, licenses, files, statuses, custom, usage, versions, traffic, filesConfigured, tracks, githubApp } = loaderData
  const checks = traffic.reduce((n, d) => n + d.valid + d.invalid, 0)
  const [tab, setTab] = useRouteTab(TABS)
  const [deleting, setDeleting] = useState(false)
  const defaults = [
    `start as ${statusLabel(statuses, app.default_status)}`,
    app.default_duration_days ? `valid ${app.default_duration_days} days` : "no expiry",
    app.default_max_sites ? `${app.default_max_sites} site${app.default_max_sites === 1 ? "" : "s"} each` : "unlimited sites",
  ].join(", ")

  return (
    <>
      <PageHeader crumbs={[{ label: "Apps", to: "/apps" }, { label: app.name }]} />
      <div className="space-y-6 p-4 pt-0 lg:px-6">
        {actionError && (
          <Alert variant="destructive">
            <AlertTitle>The app was not deleted</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}

        <PageTitle
          title={app.name}
          description={
            <>
              <span className="font-mono text-xs">{app.slug}</span>
              {app.description ? <span>, {app.description}</span> : null}
            </>
          }
          actions={
            <>
              <Button asChild>
                <Link to={`/licenses/new?app=${app.id}`}>
                  <Plus /> Issue licence
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={`/apps/${app.id}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem asChild>
                    <a href={`/licenses/export.csv?app=${app.id}`}>
                      <ArrowDownToLine /> Export licences as CSV
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={`/analytics?app=${app.id}`}>
                      <ChartColumn /> Traffic analytics
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <Trash2 /> Delete app
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        <FactStrip>
          <Fact label="Licences" value={app.licenses} detail={`${app.valid} valid`} help="Valid licences are those for which a check currently returns valid: true." />
          <Fact label="Sites" value={app.sites} detail="Registered across all licences" help="Each site registers on its first check with a domain." />
          <Fact
            label="Latest release"
            value={app.latest_version ? <span className="font-mono">{app.latest_version}</span> : "None"}
            detail={app.latest_version ? "Highest stable version" : "Upload a build with a version"}
            help="The highest stable version among the app's current releases. Withdrawn and beta releases are not counted."
          />
          <Fact
            label="Outdated sites"
            value={versions.outdated}
            detail={versions.sites > 0 ? `of ${versions.sites} sites` : "No site yet"}
            tone={versions.outdated > 0 ? "warning" : "default"}
            help="Sites on a version older than the latest release their own licence is offered, on the channel they check. Sites that never report a version, and sites whose status receives no release, are not counted."
          />
        </FactStrip>

        <section className="rounded-lg border bg-card p-4">
          <ColumnChart
            title="Licence checks, last 30 days"
            description={`Checks from customer sites across all ${app.name} licences.`}
            data={traffic}
            series={[
              { key: "valid", label: "Valid", color: "var(--chart-1)" },
              { key: "invalid", label: "Invalid", color: "var(--chart-2)" },
            ]}
            height={140}
            summary={<span className="tabular-nums">{checks.toLocaleString("en-GB")} checks</span>}
            viewAll={`/analytics?app=${app.id}`}
          />
        </section>

        <p className="text-sm text-muted-foreground">
          New licences {defaults}
          {app.default_message ? ", with a public message" : ""}.{" "}
          {app.grace_days ? `Licences stay valid ${app.grace_days} days after their expiry date (grace period). ` : ""}
          <Link className="text-foreground underline-offset-2 hover:underline" to={`/apps/${app.id}/edit`}>
            Change defaults
          </Link>
        </p>

        {inherited && (
          <p className="max-w-prose text-sm text-muted-foreground">
            Created when upgrading to 0.5.0 for a licence that had its own releases, statuses or repository. It inherits the releases of{" "}
            <Link to={inherited.appHref} className="text-foreground underline underline-offset-2">
              {inherited.appName}
            </Link>{" "}
            for the statuses its own tracks do not serve. Its statuses are managed here. Rename it from Edit.
          </p>
        )}
        {projects.length > 0 && (
          <p className="max-w-prose text-sm text-muted-foreground">
            {projects.length === 1 ? "One licence" : `${projects.length} licences`} of this app had their own releases, statuses or repository before 0.5.0 and now use a project app that inherits this app&apos;s releases:{" "}
            {projects.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                <Link to={`/apps/${p.id}`} className="text-foreground underline underline-offset-2">
                  {p.name}
                </Link>
              </span>
            ))}
            .
          </p>
        )}
        <div className="space-y-5">
          <RouteTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "licences", label: "Licences", count: app.licenses },
              { id: "releases", label: "Releases", count: files.length },
              { id: "statuses", label: "Statuses", count: statuses.length },
            ]}
          />

          {tab === "licences" && <LicensesTable licenses={licenses} showApp={false} empty="No licence has been issued under this app yet." />}

          {tab === "releases" && (
            <div className="space-y-8">
              {versions.sites > 0 && <VersionAdoption versions={versions} />}
              <FilesSection
                shared={inherited}
                ownerLabel="app"
                description="Releases and files shared by every licence of this app. Releases are grouped in tracks: each track serves a set of licence statuses, and a licence is offered the latest release of its status's track."
                uploadPath={`/apps/${app.id}/files`}
                files={files}
                statuses={statuses}
                configured={filesConfigured}
                tracks={tracks}
                githubApp={githubApp}
              />
            </div>
          )}

          {tab === "statuses" && <StatusSection owner="app" statuses={statuses} fallback={DEFAULT_STATUSES} custom={custom} usage={usage} actionPath={`/apps/${app.id}`} inheritedFrom="the default statuses" />}
        </div>

        <ConfirmAction
          intent="delete"
          open={deleting}
          onOpenChange={setDeleting}
          title="Delete this app?"
          description={
            app.licenses > 0
              ? `This app still has ${app.licenses} licence${app.licenses === 1 ? "" : "s"}. Delete them or move them to another app first; the app cannot be deleted until then.`
              : "The app and its files are deleted. This cannot be undone."
          }
          confirm="Delete app"
        />
      </div>
    </>
  )
}
