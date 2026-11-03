import { ColumnChart } from "#/components/column-chart"
import { dailyTraffic } from "~/server/analytics.server"
import { useState } from "react"
import { Form, Link, redirect } from "react-router"
import { Pencil, RefreshCw, Trash2 } from "lucide-react"
import type { Route } from "./+types/licenses.$licenseId"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { CopyField } from "#/components/code-block"
import { ConfirmAction } from "#/components/confirm-action"
import { StatusBadge } from "#/components/status-badge"
import { FieldLabel } from "#/components/help-tip"
import { Ago, When } from "#/components/time"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { NativeSelect } from "#/components/ui/native-select"
import { Table,TableHeader,TableHead,TableRow,TableBody,TableCell } from "#/components/ui/table"
import { effectiveStatusKey, findStatus, graceEndsAt, grantsAccess } from "#/lib/statuses"
import { requireAuth } from "~/server/auth.server"
import { getLicense, listActivations, recentActivity, deleteLicense, regenerateKey, releaseActivation } from "~/server/licenses.server"
import { attachmentContext, listAttachments, saveBundle, renewBundle } from "~/server/entitlements.server"
import { getStatusSetForApp } from "~/server/statuses.server"
import { getSigningKey } from "~/server/signing.server"
import { buildCheckResponse } from "#/lib/license"
import { visibleFiles } from "~/server/download.server"
export const meta:Route.MetaFunction=({data}) => [{title:`${data?.license.name ?? "Licence"} | Warden`}]
export async function loader({request,context,params}:Route.LoaderArgs) {
  const env=context.cloudflare.env;await requireAuth(request,env)
  const license=await getLicense(env,params.licenseId)
  if(!license) throw new Response("Licence not found",{status:404})
  const [attachments,sites,activity,signing,traffic]=await Promise.all([listAttachments(env,license.id),listActivations(env,license.id),recentActivity(env,license.id,100),getSigningKey(env),dailyTraffic(env,{license:license.id},30,Date.now(),"checks")])
  const origin=new URL(request.url).origin, now=Date.now()
  const apps=await Promise.all(attachments.map(async (e) => {
    const c=attachmentContext(license,e),set=await getStatusSetForApp(env,e.app_id),status=effectiveStatusKey(c,set,now)
    const versions=(await env.DB.prepare("SELECT domain,version,last_seen_at FROM activation_versions WHERE attachment_id=? ORDER BY domain").bind(e.id).all<{domain:string;version:string|null;last_seen_at:number}>()).results
    const check=buildCheckResponse(c,null,now,sites.map((s) => s.domain),set)
    const files=await visibleFiles(env,c,null,check,now,set,origin)
    return {...e,status,stored_status:e.status,valid:grantsAccess(set,status),expires_at:c.expires_at,grace_end:graceEndsAt(c,set,now),statuses:set,versions,files,check_url:`${origin}/check/${license.license_key}?tag=${encodeURIComponent(e.tag)}`}
  }))
  return {license,apps,sites,activity,traffic:traffic.series,origin,signing:{publicKey:signing.publicKey,keyId:signing.keyId}}
}
export async function action({request,context,params}:Route.ActionArgs) {
  const env=context.cloudflare.env;await requireAuth(request,env)
  const license=await getLicense(env,params.licenseId)
  if(!license) throw new Response("Not found",{status:404})
  const form=await request.formData(),intent=form.get("intent")
  if(intent === "delete") {await deleteLicense(env,license.id);return redirect("/licenses")}
  if(intent === "regenerate") {await regenerateKey(env,license);return {ok:true}}
  if(intent === "release-site") {await releaseActivation(env,license,String(form.get("domain")));return {ok:true}}
  if(intent === "renew") {
    const result=await renewBundle(env,license,{days:Number(form.get("days")),...(license.expiry_mode === "separate" ? {tag:String(form.get("tag"))} : {})})
    if(result) {const value=await result.json() as {error:{message:string}};return {error:value.error.message}}
    return {ok:true}
  }
  if(intent === "status") {
    const attachments=await listAttachments(env,license.id),tag=String(form.get("tag"))
    if(!attachments.some((e) => e.tag === tag)) return {error:"This tag no longer exists."}
    const apps=attachments.map((e) => ({tag:e.tag,app:e.app_id,status:e.tag === tag ? String(form.get("status")) : e.status,expires_at:e.expires_at === null ? null : new Date(e.expires_at).toISOString(),grace_days:e.grace_days,message:e.message}))
    const result=await saveBundle(env,{apps},license)
    if("response" in result) {const value=await result.response.json() as {error:{message:string}};return {error:value.error.message}}
    return {ok:true}
  }
  return {error:"Unknown action."}
}
function Renewal({tag}:{tag?:string}) {return <Form method="post" className="flex flex-wrap items-center gap-2"><input type="hidden" name="intent" value="renew"/>{tag && <input type="hidden" name="tag" value={tag}/>}<Input aria-label={tag ? `Renewal days for ${tag}` : "Shared renewal days"} name="days" type="number" defaultValue={365} min={1} max={3650} required className="w-24"/><span className="text-sm text-muted-foreground">days</span><Button variant="outline" size="sm">{tag ? "Renew this app" : "Renew all apps"}</Button></Form>}
export default function LicensePage({loaderData,actionData}:Route.ComponentProps) {
  const {license,apps,sites,activity,origin,signing}=loaderData
  const [confirm,setConfirm]=useState<"delete"|"regenerate"|null>(null)
  const [release,setRelease]=useState<string|null>(null)
  return <><PageHeader crumbs={[{label:"Licences",to:"/licenses"},{label:license.name}]}/><div className="space-y-6 p-4 pt-0 lg:px-6">
    <PageTitle title={license.name} description={[license.customer_name,license.customer_email].filter(Boolean).join(" · ")} actions={<><Button asChild variant="outline"><Link to={`/licenses/${license.id}/edit`}><Pencil/> Edit licence</Link></Button><Button type="button" variant="outline" onClick={() => setConfirm("regenerate")}><RefreshCw/> Regenerate key</Button><Button type="button" variant="ghost" onClick={() => setConfirm("delete")}><Trash2/> Delete</Button></>}/>
    {actionData && "error" in actionData && <p role="alert" className="rounded border border-destructive p-3 text-destructive">{actionData.error}</p>}
    <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-lg border bg-card p-5 space-y-3"><h2 className="font-semibold">Licence key</h2><CopyField value={license.license_key}/><p className="text-sm text-muted-foreground">One key covers {apps.length} attached app{apps.length === 1 ? "" : "s"}. Each tag has its own check result.</p><p className="text-sm">Allowed domains: {license.domains || "Any domain"}</p><p className="text-sm">Sites: {sites.length}{license.max_sites !== null ? ` / ${license.max_sites}` : " · Unlimited"}</p><p className="text-xs text-muted-foreground">A domain uses one slot across all apps.</p></section>
    <section className="rounded-lg border bg-card p-5 space-y-3"><h2 className="font-semibold">{license.expiry_mode === "separate" ? "Separate expiries" : "Shared expiry"}</h2>{license.expiry_mode === "shared" ? <><p className="text-sm">{license.expires_at === null ? "No expiry" : <When ts={license.expires_at}/>}</p><Renewal/></> : <p className="text-sm text-muted-foreground">Each app has its own expiry date and renewal. Edit the licence to switch to a shared date.</p>}<p className="text-xs text-muted-foreground">Each app's status decides whether expiry applies. Grace periods use the licence override, then the attachment setting, then the app's setting.</p></section></div>
    <section className="rounded-lg border bg-card p-4"><ColumnChart title="App checks, last 30 days" description="One result per checked app. A batch request can record several results." data={loaderData.traffic} series={[{key:"valid",label:"Valid",color:"var(--chart-1)"},{key:"invalid",label:"Invalid",color:"var(--chart-2)"}]} height={140} viewAll={`/analytics?license=${license.id}`}/></section>
    <section className="space-y-4"><h2 className="text-lg font-semibold">Attached apps</h2><div className="grid gap-4 xl:grid-cols-2">{apps.map((e) => <section key={e.id} className="rounded-lg border bg-card p-5 space-y-4 min-w-0"><div className="flex flex-wrap items-start justify-between gap-3"><div><Link to={`/apps/${e.app_id}`} className="font-semibold hover:underline">{e.app_name}</Link><p className="font-mono text-xs text-muted-foreground mt-1">{e.tag}</p></div><StatusBadge status={findStatus(e.statuses,e.status) ?? {label:e.status,color:"#6b7280"}}/></div><p className="text-sm">{e.valid ? "Valid" : "Invalid"} · {e.expires_at === null ? "No expiry" : <>Expires <When ts={e.expires_at}/></>}{e.grace_end && <> · In grace until <When ts={e.grace_end}/></>}</p>
    <Form method="post" className="flex flex-wrap items-end gap-2"><input type="hidden" name="intent" value="status"/><input type="hidden" name="tag" value={e.tag}/><div className="space-y-2 flex-1 min-w-40"><FieldLabel htmlFor={`status-${e.id}`} help="Defined on the app. This selection changes only this licence's access to this app.">Status</FieldLabel><NativeSelect id={`status-${e.id}`} name="status" key={e.stored_status} defaultValue={e.stored_status}>{e.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</NativeSelect></div><Button variant="outline">Update status</Button></Form>
    {license.expiry_mode === "separate" && <Renewal tag={e.tag}/>}<div className="space-y-2"><p className="text-xs font-medium">Check URL</p><CopyField value={e.check_url}/></div><p className="text-xs text-muted-foreground">Last check: <Ago ts={e.last_check_at}/> · {e.check_count} checks</p>
    {e.versions.length>0 && <div className="text-sm space-y-1">{e.versions.map((v) => <p key={v.domain}><span className="text-muted-foreground">{v.domain}</span> · {v.version ?? "No version reported"}</p>)}</div>}
    <div className="border-t pt-3 space-y-2"><Link to={`/apps/${e.app_id}?tab=releases`} className="text-sm underline underline-offset-4">Manage app releases</Link>{e.files.map((f) => <p key={f.id} className="text-sm"><a href={f.download_url} className="underline underline-offset-4">{f.name}</a>{f.version && <span className="ml-2 font-mono text-xs text-muted-foreground">{f.version}</span>}</p>)}{e.files.length>0 && <p className="text-xs text-muted-foreground">Downloads still enforce the app status and domain rules. For domain-checked files, append &amp;domain=your-domain.</p>}</div></section>)}</div></section>
    <section className="rounded-lg border bg-card p-5 space-y-3"><h2 className="font-semibold">Integration</h2><p className="text-sm text-muted-foreground">Add ?tag=parent-theme to check one app, with &amp;domain= and &amp;version=. Without a tag, a licence with several apps returns an apps array with one result per tag. Verify the response signature and its licence key, tag, app, domain and nonce.</p><CopyField value={`${origin}/check/${license.license_key}`}/><p className="text-xs font-medium">Public signing key · {signing.keyId}</p><CopyField value={signing.publicKey}/></section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Registered sites</h2><div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>Domain</TableHead><TableHead>Last seen</TableHead><TableHead/></TableRow></TableHeader><TableBody>{sites.map((s) => <TableRow key={s.domain}><TableCell>{s.domain}</TableCell><TableCell><Ago ts={s.last_seen_at}/></TableCell><TableCell><Button type="button" variant="ghost" size="sm" onClick={() => setRelease(s.domain)}>Release site</Button></TableCell></TableRow>)}{!sites.length && <TableRow><TableCell colSpan={3}>No site has checked yet.</TableCell></TableRow>}</TableBody></Table></div></section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Recent activity</h2><div className="rounded-lg border"><Table><TableHeader><TableRow><TableHead>When</TableHead><TableHead>Event</TableHead><TableHead>Status</TableHead><TableHead>Details</TableHead></TableRow></TableHeader><TableBody>{activity.map((a) => <TableRow key={a.id}><TableCell><Ago ts={a.at}/></TableCell><TableCell>{a.event}</TableCell><TableCell>{a.status ?? "—"}</TableCell><TableCell>{a.tag && <span className="mr-2 font-mono text-xs text-muted-foreground">{a.tag}</span>}{a.detail || a.domain || "—"}</TableCell></TableRow>)}</TableBody></Table></div></section>
    {license.notes && <section className="rounded-lg border bg-card p-5"><h2 className="font-semibold mb-2">Internal notes</h2><p className="whitespace-pre-wrap text-sm">{license.notes}</p></section>}
    <ConfirmAction intent={confirm ?? "delete"} open={Boolean(confirm)} onOpenChange={(v) => {if(!v)setConfirm(null)}} title={confirm === "delete" ? "Delete this licence?" : "Regenerate the licence key?"} description={confirm === "delete" ? "Access for all attached apps and this licence's activity will be deleted. The apps and their releases remain." : "The old key stops working for every attached app. Update the customer's site with the new key."} confirm={confirm === "delete" ? "Delete licence" : "Regenerate key"}/>
    <ConfirmAction intent="release-site" fields={{domain:release ?? ""}} open={Boolean(release)} onOpenChange={(v) => {if(!v)setRelease(null)}} title="Release this site?" description="This frees the domain slot for every attached app. The site can register again on its next valid check." confirm="Release site"/>
  </div></>}
