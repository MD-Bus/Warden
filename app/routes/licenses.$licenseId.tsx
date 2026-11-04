import { useState } from "react"
import { Form, Link, redirect, useFetcher, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router"
import { ArrowDownToLine, CalendarPlus, Check, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react"
import type { Route } from "./+types/licenses.$licenseId"
import { CodeBlock, CopyField } from "#/components/code-block"
import { ColumnChart } from "#/components/column-chart"
import { ConfirmAction } from "#/components/confirm-action"
import { Fact, FactStrip } from "#/components/fact-strip"
import { FieldLabel, HelpTip } from "#/components/help-tip"
import { IpAddress } from "#/components/ip-address"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { onlyTabChanged, RouteTabs, useRouteTab } from "#/components/route-tabs"
import { StatusBadge } from "#/components/status-badge"
import { Ago, When } from "#/components/time"
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu"
import { NativeSelect } from "#/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table"
import { buildCheckResponse } from "#/lib/license"
import { latestRelease, siteUpdateState } from "#/lib/releases"
import { DEFAULT_COLOR, DEFAULT_STATUSES, effectiveStatusKey, findStatus, graceDays, graceEndsAt, grantsAccess, statusLabel, type StatusSet } from "#/lib/statuses"
import { cn } from "#/lib/utils"
import { daysUntil, describeExpiry, EXPIRING_WINDOW_DAYS } from "#/lib/views"
import { dailyTraffic } from "~/server/analytics.server"
import { requireAuth } from "~/server/auth.server"
import { visibleFiles } from "~/server/download.server"
import { attachmentContext, listAttachments, listAttachmentVersions, renewBundle, saveBundle } from "~/server/entitlements.server"
import { blockedAmong } from "~/server/ip-blocks.server"
import { deleteLicense, getLicense, listActivations, recentActivity, regenerateKey, releaseActivation } from "~/server/licenses.server"
import { getSigningKey } from "~/server/signing.server"
import { getStatusSetForApp } from "~/server/statuses.server"

export const meta: Route.MetaFunction = ({ data }) => [{ title: `${data?.license.name ?? "Licence"} | Warden` }]

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const license = await getLicense(env, params.licenseId)
  if (!license) throw new Response("Licence not found", { status: 404 })
  const origin = new URL(request.url).origin
  const now = Date.now()
  const [attachments, versions, sites, activity, signing, traffic] = await Promise.all([
    listAttachments(env, license.id),
    listAttachmentVersions(env, license.id),
    listActivations(env, license.id),
    recentActivity(env, license.id, 100),
    getSigningKey(env),
    dailyTraffic(env, { license: license.id }, 30, now, "checks"),
  ])
  const domains = sites.map((s) => s.domain)
  const apps = await Promise.all(
    attachments.map(async (e) => {
      const c = attachmentContext(license, e)
      const statuses = await getStatusSetForApp(env, e.app_id)
      const status = effectiveStatusKey(c, statuses, now)
      const check = buildCheckResponse(c, null, now, domains, statuses)
      // Availability here means "offered in this status": the domain and site rules depend on the site asking, and a
      // registered site has passed them. Evaluated with no domain, they would hide every release from limited licences.
      const files = (await visibleFiles(env, c, null, check, now, statuses, origin)).map((f) => ({ ...f, available: f.statuses.includes(status) }))
      const offered = files.filter((f) => f.available)
      const latest = { stable: latestRelease(offered, "stable")?.version ?? null, beta: latestRelease(offered, "beta")?.version ?? null }
      return {
        id: e.id,
        tag: e.tag,
        app_id: e.app_id,
        app_name: e.app_name,
        status,
        stored_status: e.status,
        valid: grantsAccess(statuses, status),
        on_expiry: Boolean(findStatus(statuses, e.status)?.on_expiry),
        expires_at: c.expires_at,
        grace_days: graceDays(c),
        grace_end: graceEndsAt(c, statuses, now),
        message: e.message,
        last_check_at: e.last_check_at,
        check_count: e.check_count,
        statuses,
        latest_version: latest.stable,
        // The dashboard shows the key-based address (the owner sees the key anyway); sites receive signed links.
        files: files.map(({ link: _link, ...f }) => ({ ...f, download_url: `${origin}/download/${license.license_key}/${f.id}?tag=${encodeURIComponent(e.tag)}` })),
        versions: versions.filter((v) => v.attachment_id === e.id).map((v) => ({ ...v, state: siteUpdateState(v.version, latest[v.channel]) })),
        check_url: `${origin}/check/${license.license_key}?tag=${encodeURIComponent(e.tag)}`,
      }
    }),
  )
  const blockedIps = await blockedAmong(env, [...activity.map((a) => a.ip), ...sites.map((s) => s.last_ip)])
  return {
    license,
    apps,
    sites,
    activity,
    blockedIps,
    traffic: traffic.series,
    origin,
    signingKey: { publicKey: signing.publicKey, keyId: signing.keyId },
  }
}

export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return onlyTabChanged(args) ? false : args.defaultShouldRevalidate
}

async function errorMessage(response: Response): Promise<{ error: string }> {
  const value = (await response.json()) as { error: { message: string } }
  return { error: value.error.message }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const license = await getLicense(env, params.licenseId)
  if (!license) throw new Response("Licence not found", { status: 404 })
  const form = await request.formData()
  const intent = String(form.get("intent"))

  if (intent === "delete") {
    await deleteLicense(env, license.id)
    return redirect("/licenses")
  }
  if (intent === "regenerate") {
    await regenerateKey(env, license)
  } else if (intent === "release-site") {
    await releaseActivation(env, license, String(form.get("domain") ?? ""))
  } else if (intent === "renew") {
    const tag = form.get("tag")
    const result = await renewBundle(env, license, { days: Number(form.get("days")), ...(typeof tag === "string" && tag ? { tag } : {}) })
    if (result) return errorMessage(result)
  } else if (intent === "status") {
    const attachments = await listAttachments(env, license.id)
    const tag = String(form.get("tag"))
    if (!attachments.some((e) => e.tag === tag)) return { error: "This tag no longer exists on the licence." }
    // Saving the whole set keeps validation, events and the activity record in one place (saveBundle).
    const apps = attachments.map((e) => ({ tag: e.tag, app: e.app_id, status: e.tag === tag ? String(form.get("status")) : e.status }))
    const result = await saveBundle(env, { apps }, license)
    if ("response" in result) return errorMessage(result.response)
  } else {
    return { error: "Unknown action." }
  }
  return { ok: true as const }
}

type LoaderData = Route.ComponentProps["loaderData"]
type AppEntry = LoaderData["apps"][number]

const TABS = ["apps", "integration", "sites", "activity"] as const
const DAY = 86_400_000

export default function LicensePage({ loaderData, actionData }: Route.ComponentProps) {
  const { license, apps, sites, activity, blockedIps, traffic, origin, signingKey } = loaderData
  const [params] = useSearchParams()
  const [tab, setTab] = useRouteTab([...TABS])
  const [confirm, setConfirm] = useState<"regenerate" | "delete" | null>(null)

  const validCount = apps.filter((e) => e.valid).length
  const separate = license.expiry_mode === "separate"
  const dates = apps.map((e) => e.expires_at).filter((d): d is number => d !== null)
  const nextExpiry = separate ? (dates.length ? Math.min(...dates) : null) : license.expires_at
  const graceEnd = apps.map((e) => e.grace_end).find((d) => d !== null) ?? null
  const expiryTone = nextExpiry === null ? "default" : daysUntil(nextExpiry) < 0 ? "danger" : daysUntil(nextExpiry) <= EXPIRING_WINDOW_DAYS ? "warning" : "default"
  const silent = license.last_check_at === null || Date.now() - license.last_check_at > 3 * DAY
  const sitesUsed = license.sites_used ?? sites.length
  const outdated = apps.reduce((n, e) => n + e.versions.filter((v) => v.state === "behind").length, 0)

  return (
    <>
      <PageHeader crumbs={[{ label: "Licences", to: "/licenses" }, { label: license.name }]} />
      <div className="space-y-6 p-4 pt-0 lg:px-6">
        {params.get("created") && (
          <Alert>
            <Check />
            <AlertTitle>Licence created</AlertTitle>
            <AlertDescription>Put the licence key or the check URL into the customer&apos;s site. Add ?tag= to check one app.</AlertDescription>
          </Alert>
        )}
        {actionData && "error" in actionData && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {actionData.error}
          </p>
        )}

        <PageTitle
          title={license.name}
          description={
            <>
              {[license.customer_name, license.customer_email].filter(Boolean).join(", ") || "No customer recorded"}
              {", "}
              {apps.length === 1 ? (
                <Link className="text-foreground underline-offset-2 hover:underline" to={`/apps/${apps[0].app_id}`}>
                  {apps[0].app_name}
                </Link>
              ) : (
                `${apps.length} apps`
              )}
            </>
          }
          actions={
            <>
              {/* Shared renewal is offered only when the licence expires: renewing a licence without a date would give it one. */}
              {!separate && license.expires_at !== null && <RenewMenu expiresAt={license.expires_at} label="Renew" />}
              <Button asChild variant="outline">
                <Link to={`/licenses/${license.id}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => setConfirm("regenerate")}>
                    <RefreshCw /> Regenerate key
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a href={`/licenses/export.csv?q=${encodeURIComponent(license.license_key)}`}>
                      <ArrowDownToLine /> Export as CSV
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirm("delete")}>
                    <Trash2 /> Delete licence
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        <FactStrip>
          <Fact
            label="Check result"
            help="Each attached app has its own check result. A check with ?tag= returns the result of that app only."
            value={apps.length === 1 ? <StatusBadge status={findStatus(apps[0].statuses, apps[0].status) ?? { label: apps[0].status, color: DEFAULT_COLOR }} /> : `${validCount} of ${apps.length} valid`}
            detail={apps.length === 1 ? (apps[0].valid ? "valid: true" : "valid: false") : validCount === apps.length ? "Every app is valid" : `${apps.length - validCount} invalid`}
            tone={validCount === apps.length ? "success" : validCount === 0 ? "danger" : "warning"}
          />
          <Fact
            label={separate ? "Next expiry" : "Expires"}
            help={separate ? "Each app has its own expiry date. This is the earliest one." : "One date for every attached app."}
            value={nextExpiry ? new Date(nextExpiry).toISOString().slice(0, 10) : "Never"}
            detail={graceEnd ? `Grace period until ${new Date(graceEnd).toISOString().slice(0, 10)}` : nextExpiry ? `${describeExpiry(nextExpiry)}, end of day UTC` : "No expiry date"}
            tone={graceEnd ? "warning" : expiryTone}
          />
          <Fact
            label="Sites"
            help="Sites register automatically on their first valid check with a domain. A domain uses one slot for every attached app. Once the site limit is reached, checks from additional sites return site_limit_reached."
            value={license.max_sites === null ? `${sitesUsed}` : `${sitesUsed} of ${license.max_sites}`}
            detail={license.max_sites === null ? "No site limit" : sitesUsed >= license.max_sites ? "Limit reached" : `${license.max_sites - sitesUsed} free`}
            tone={license.max_sites !== null && sitesUsed >= license.max_sites ? "warning" : "default"}
          />
          <Fact
            label="Last check"
            help="Time of the most recent check and the domain it reported."
            value={<Ago ts={license.last_check_at} empty="Never" />}
            detail={license.last_check_domain ? `From ${license.last_check_domain}, ${license.check_count} in total` : `${license.check_count} checks in total`}
            tone={validCount > 0 && silent ? "warning" : "default"}
          />
        </FactStrip>

        <div className="space-y-5">
          <RouteTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "apps", label: "Apps", count: apps.length },
              { id: "integration", label: "Integration" },
              { id: "sites", label: "Sites", count: sites.length },
              { id: "activity", label: "Activity" },
            ]}
          />
          {tab === "apps" && (
            <div className="grid gap-4 xl:grid-cols-2">
              {apps.map((entry) => (
                <AppCard key={entry.id} entry={entry} separate={separate} />
              ))}
            </div>
          )}
          {tab === "integration" && <IntegrationTab license={license} apps={apps} origin={origin} signingKey={signingKey} />}
          {tab === "sites" && <SitesTab license={license} apps={apps} sites={sites} blockedIps={blockedIps} outdated={outdated} />}
          {tab === "activity" && <ActivityTab licenseId={license.id} apps={apps} activity={activity} blockedIps={blockedIps} traffic={traffic} />}
        </div>

        <ConfirmAction
          intent="regenerate"
          open={confirm === "regenerate"}
          onOpenChange={(open) => setConfirm(open ? "regenerate" : null)}
          title="Regenerate the key?"
          description="The current key, check URLs and download links stop working immediately for every attached app. The site will need the new key."
          confirm="Regenerate key"
        />
        <ConfirmAction
          intent="delete"
          open={confirm === "delete"}
          onOpenChange={(open) => setConfirm(open ? "delete" : null)}
          title="Delete this licence?"
          description="Its history is deleted too, and the check URL returns 'unknown' from now on, which a site treats as invalid. The attached apps and their releases remain. To switch a site off but keep the record, change the status instead."
          confirm="Delete licence"
        />
      </div>
    </>
  )
}

function RenewMenu({ expiresAt, tag, label }: { expiresAt: number; tag?: string; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={tag ? "sm" : "default"}>
          <CalendarPlus /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">From {daysUntil(expiresAt) < 0 ? "today" : "the current expiry date"}</DropdownMenuLabel>
        {[30, 90, 365].map((days) => (
          <Form method="post" key={days}>
            <input type="hidden" name="intent" value="renew" />
            <input type="hidden" name="days" value={days} />
            {tag && <input type="hidden" name="tag" value={tag} />}
            <DropdownMenuItem asChild>
              <button type="submit" className="w-full">
                {days === 365 ? "1 year" : `${days} days`}
              </button>
            </DropdownMenuItem>
          </Form>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AppCard({ entry, separate }: { entry: AppEntry; separate: boolean }) {
  const fetcher = useFetcher<{ ok?: true; error?: string }>()
  const status = findStatus(entry.statuses, entry.status)
  return (
    <section className="min-w-0 space-y-4 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/apps/${entry.app_id}`} className="font-semibold hover:underline">
            {entry.app_name}
          </Link>
          <p className="mt-1 font-mono text-xs text-muted-foreground">tag: {entry.tag}</p>
        </div>
        <StatusBadge status={status ?? { label: entry.status, color: DEFAULT_COLOR }} />
      </div>

      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Check result</dt>
        <dd>{entry.valid ? "valid: true" : "valid: false"}</dd>
        <dt className="text-muted-foreground">Expires</dt>
        <dd>
          {entry.expires_at === null ? "Never" : <When ts={entry.expires_at} />}
          {entry.expires_at !== null && !entry.on_expiry && <span className="text-muted-foreground">, ignored by this status</span>}
        </dd>
        <dt className="text-muted-foreground">Grace period</dt>
        <dd>
          {entry.grace_end ? (
            <>
              Until <When ts={entry.grace_end} />
            </>
          ) : entry.grace_days ? (
            `${entry.grace_days} days`
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Last check</dt>
        <dd>
          <Ago ts={entry.last_check_at} empty="Never" />, {entry.check_count} in total
        </dd>
        {entry.latest_version && (
          <>
            <dt className="text-muted-foreground">Latest release</dt>
            <dd className="font-mono text-xs leading-5">{entry.latest_version}</dd>
          </>
        )}
      </dl>

      <fetcher.Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="status" />
        <input type="hidden" name="tag" value={entry.tag} />
        <div className="min-w-40 flex-1 space-y-2">
          <FieldLabel htmlFor={`status-${entry.id}`} help="Statuses are defined on the app. This changes only this licence's access to this app.">
            Status
          </FieldLabel>
          <NativeSelect id={`status-${entry.id}`} name="status" key={entry.stored_status} defaultValue={entry.stored_status}>
            {entry.statuses.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline" disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Change status"}
        </Button>
        {separate && entry.expires_at !== null && <RenewMenu expiresAt={entry.expires_at} tag={entry.tag} label="Renew" />}
      </fetcher.Form>
      {fetcher.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {fetcher.data.error}
        </p>
      )}

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Check URL</p>
        <CopyField value={entry.check_url} />
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Releases offered</p>
          <Link to={`/apps/${entry.app_id}?tab=releases`} className="text-xs text-muted-foreground underline underline-offset-4">
            Manage app releases
          </Link>
        </div>
        {entry.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No release or file for this app.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {entry.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-baseline gap-2">
                <a href={f.download_url} className={cn("underline underline-offset-4", !f.available && "text-muted-foreground")}>
                  {f.name}
                </a>
                {f.version && <span className="font-mono text-xs text-muted-foreground">{f.version}</span>}
                {!f.available && <Badge variant="outline">Not available in this status</Badge>}
              </li>
            ))}
          </ul>
        )}
        {entry.files.some((f) => f.check_domain) && <p className="text-xs text-muted-foreground">Domain-checked files need &amp;domain= appended to the download link.</p>}
      </div>
    </section>
  )
}

function IntegrationTab({ license, apps, origin, signingKey }: { license: LoaderData["license"]; apps: AppEntry[]; origin: string; signingKey: { publicKey: string; keyId: string } }) {
  const checkUrl = `${origin}/check/${license.license_key}`
  const domain = license.last_check_domain ?? license.domains.split(",")[0]?.trim() ?? "example.com"
  const example = `curl "${checkUrl}?tag=${apps[0]?.tag ?? "default"}&domain=${domain || "example.com"}&version=1.0.0"`
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className="space-y-4">
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Licence key <HelpTip>Identifies and authenticates this licence for every attached app. Anyone holding it can check the licence and download the files it allows. Treat it as a secret.</HelpTip>
          </p>
          <CopyField value={license.license_key} />
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Check URL{" "}
            <HelpTip>
              The site calls it (GET) about every 12 hours with ?tag= to select its app, its domain, and its version to be told about updates. Without a tag, a licence with several apps returns an apps array with one result per tag. The
              JSON response is signed with this installation's signing key (X-Warden-Signature-Ed25519 header).
            </HelpTip>
          </p>
          <CopyField value={checkUrl} />
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Download list <HelpTip>Lists the files the selected app offers this licence, with their availability and the latest release. Add ?tag= to select the app.</HelpTip>
          </p>
          <CopyField value={`${origin}/download/${license.license_key}`} />
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Public signing key{" "}
            <HelpTip>
              Ed25519 public key of this installation, the same for every licence. Put it in the site's code: the site verifies the X-Warden-Signature-Ed25519 header of each check with it, and the signature of each release before
              installing it. It is public: it can verify signatures but not create them. Also available from GET /api/v1/signing-key.
            </HelpTip>
          </p>
          <CopyField value={signingKey.publicKey} />
          <p className="text-xs text-muted-foreground">Key ID {signingKey.keyId}</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Example request</p>
          <CodeBlock code={example} language="bash" />
          <p className="text-xs text-muted-foreground">Verify the signature, then the licence key, tag, app, domain and nonce in the response. Site code and an updater: see docs/checking.md and docs/releases.md in the repository.</p>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Details</h2>
        <dl className="divide-y rounded-lg border bg-card text-sm">
          <Detail label="Expiry mode" help="Shared: one date for every attached app. Separate: each app has its own date and renewal.">
            {license.expiry_mode === "separate" ? "Separate for each app" : "Shared"}
          </Detail>
          <Detail label="Allowed domains" help="Sites must send one of these as ?domain=. Subdomains match. Applies to every attached app.">
            {license.domains || <span className="text-muted-foreground">Any domain</span>}
          </Detail>
          <Detail label="Site limit">{license.max_sites ?? <span className="text-muted-foreground">Unlimited</span>}</Detail>
          <Detail label="Grace override" help="Days every app stays valid after its expiry date. Without an override, each app uses its attachment's setting, then the app's setting.">
            {license.grace_days === null ? <span className="text-muted-foreground">None, each app's setting</span> : license.grace_days === 0 ? "No grace period" : `${license.grace_days} days`}
          </Detail>
          <Detail label="Public message" help="Overrides the message returned to sites for every app. Without it, each app's message or status message is returned.">
            {license.message || <span className="text-muted-foreground">None</span>}
          </Detail>
          {license.external_ref && <Detail label="External reference">{license.external_ref}</Detail>}
          <Detail label="Created">
            <When ts={license.created_at} />
          </Detail>
          {license.notes && (
            <Detail label="Internal notes">
              <span className="whitespace-pre-line">{license.notes}</span>
            </Detail>
          )}
        </dl>
      </section>
    </div>
  )
}

function Detail({ label, help, children }: { label: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 px-4 py-2.5">
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        {label}
        {help && <HelpTip>{help}</HelpTip>}
      </dt>
      <dd className="break-words">{children}</dd>
    </div>
  )
}

function SitesTab({ license, apps, sites, blockedIps, outdated }: { license: LoaderData["license"]; apps: AppEntry[]; sites: LoaderData["sites"]; blockedIps: string[]; outdated: number }) {
  if (sites.length === 0) return <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No site has checked this licence with a domain yet.</p>
  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm text-muted-foreground">
        {license.max_sites === null ? `${sites.length} site${sites.length === 1 ? "" : "s"}, no limit.` : `${sites.length} of ${license.max_sites} sites in use.`} A domain uses one slot for every attached app. Versions are reported per app.
        {outdated > 0 && ` ${outdated} installation${outdated === 1 ? " is" : "s are"} behind the latest release.`}
      </p>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site</TableHead>
              <TableHead>Versions</TableHead>
              <TableHead className="hidden lg:table-cell">Address</TableHead>
              <TableHead className="hidden md:table-cell">First seen</TableHead>
              <TableHead>Last check</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Checks</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.map((site) => {
              const reported = apps.flatMap((e) => e.versions.filter((v) => v.domain === site.domain).map((v) => ({ tag: e.tag, version: v.version, state: v.state })))
              return (
                <TableRow key={site.domain}>
                  <TableCell className="font-medium">{site.domain}</TableCell>
                  <TableCell>
                    {reported.some((r) => r.version) ? (
                      <ul className="space-y-1">
                        {reported
                          .filter((r) => r.version)
                          .map((r) => (
                            <li key={r.tag} className="flex flex-wrap items-center gap-2">
                              {apps.length > 1 && <span className="text-xs text-muted-foreground">{r.tag}</span>}
                              <span className="font-mono text-xs">{r.version}</span>
                              {r.state === "behind" && <Badge variant="warning">Update available</Badge>}
                              {r.state === "up_to_date" && <Badge variant="success">Up to date</Badge>}
                              {r.state === "no_release" && <Badge variant="outline">No release for this status</Badge>}
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not reported</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <IpAddress ip={site.last_ip} blocked={site.last_ip ? blockedIps.includes(site.last_ip) : false} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    <Ago ts={site.first_seen_at} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <Ago ts={site.last_seen_at} />
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">{site.check_count}</TableCell>
                  <TableCell className="text-right">
                    <SiteRelease domain={site.domain} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function SiteRelease({ domain }: { domain: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Release
      </Button>
      <ConfirmAction
        intent="release-site"
        fields={{ domain }}
        open={open}
        onOpenChange={setOpen}
        title="Release this site?"
        description="This frees the domain's slot for every attached app. The site registers again on its next valid check."
        confirm="Release site"
      />
    </>
  )
}

const EVENT_FILTERS = [
  { id: "all", label: "All" },
  { id: "change", label: "Changes" },
  { id: "check", label: "Checks" },
  { id: "download", label: "Downloads" },
] as const

function ActivityTab({ licenseId, apps, activity, blockedIps, traffic }: { licenseId: string; apps: AppEntry[]; activity: LoaderData["activity"]; blockedIps: string[]; traffic: LoaderData["traffic"] }) {
  const [filter, setFilter] = useState<(typeof EVENT_FILTERS)[number]["id"]>("all")
  const shown = filter === "all" ? activity : activity.filter((a) => a.event === filter)
  const checks = traffic.reduce((n, d) => n + d.valid + d.invalid, 0)
  // Status keys belong to the app of each event's tag.
  const statusesFor = (tag: string | null | undefined): StatusSet => apps.find((e) => e.tag === tag)?.statuses ?? apps[0]?.statuses ?? DEFAULT_STATUSES
  return (
    <div className="space-y-3">
      <section className="mb-6 rounded-lg border bg-card p-4">
        <ColumnChart
          title="App checks, last 30 days"
          description="One result per checked app. A check without a tag on a licence with several apps records one result per app."
          data={traffic}
          series={[
            { key: "valid", label: "Valid", color: "var(--chart-1)" },
            { key: "invalid", label: "Invalid", color: "var(--chart-2)" },
          ]}
          height={140}
          summary={<span className="tabular-nums">{checks.toLocaleString("en-GB")} checks</span>}
          viewAll={`/analytics?license=${licenseId}`}
        />
      </section>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
        {EVENT_FILTERS.map((f) => {
          const count = f.id === "all" ? activity.length : activity.filter((a) => a.event === f.id).length
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn("rounded-full border px-3 py-1 text-xs transition-colors", filter === f.id ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
            >
              {f.label} <span className="tabular-nums opacity-70">{count}</span>
            </button>
          )
        })}
        <span className="ml-auto text-xs text-muted-foreground">Latest {activity.length} events. Checks older than 90 days are removed.</span>
      </div>
      <div className="rounded-lg border bg-card">
        {shown.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y">
            {shown.map((a) => {
              const statuses = statusesFor(a.tag)
              return (
                <li key={a.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2 text-sm">
                  <span className="text-xs text-muted-foreground">{a.event === "check" ? "Check" : a.event === "download" ? "Download" : "Change"}</span>
                  <span className="min-w-0 break-words">
                    {a.tag && apps.length > 1 && <span className="mr-2 font-mono text-xs text-muted-foreground">{a.tag}</span>}
                    {a.event === "check" ? (
                      <>
                        {a.domain ?? "No domain"}: <span className={cn(findStatus(statuses, a.status ?? "")?.grants_access ? "" : "text-red-700 dark:text-red-400")}>{statusLabel(statuses, a.status)}</span>
                        {a.detail && <span className="text-muted-foreground">, {a.detail.replace(/^Version /, "version ")}</span>}
                      </>
                    ) : a.event === "download" ? (
                      <>
                        {a.detail}
                        {a.domain && <span className="text-muted-foreground"> from {a.domain}</span>}
                      </>
                    ) : (
                      a.detail
                    )}
                  </span>
                  <span className="flex flex-col items-end gap-0.5 text-xs whitespace-nowrap text-muted-foreground">
                    <Ago ts={a.at} />
                    {a.event !== "change" && a.ip && <IpAddress ip={a.ip} blocked={blockedIps.includes(a.ip)} />}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
