import { redirect } from "react-router"
import type { Route } from "./+types/licenses.new"
import { PageHeader } from "#/components/page-header"
import { EMPTY_FORM, LicenseForm, dateValue, type FormValues } from "#/components/license-form"
import { requireAuth } from "~/server/auth.server"
import { listApps } from "~/server/apps.server"
import { listTemplates } from "~/server/entitlements.server"
import { saveLicenseForm } from "~/server/license-dashboard.server"
export const meta:Route.MetaFunction=() => [{title:"New licence | Warden"}]
export async function loader({request,context}:Route.LoaderArgs) {
  const env=context.cloudflare.env
  await requireAuth(request,env)
  const [apps,templates]=await Promise.all([listApps(env),listTemplates(env)])
  const q=new URL(request.url).searchParams, template=templates.find((t) => t.id === q.get("template")), app=apps.find((a) => a.id === q.get("app"))
  const values:FormValues={...EMPTY_FORM,expiry_mode:template?.expiry_mode ?? "shared",apps:template ? template.slots.map((s) => {const a=apps.find((a) => a.id === s.app);return {tag:s.tag,app:s.app ?? "",required:s.required,status:a?.default_status ?? "",expires_at:a?.default_duration_days ? dateValue(Date.now()+a.default_duration_days*86400000) : "",grace_days:"",message:a?.default_message ?? ""}}) : app ? [{tag:app.slug,app:app.id,status:app.default_status,expires_at:"",grace_days:"",message:app.default_message}] : []}
  if(app) {values.max_sites=app.default_max_sites?.toString() ?? "";values.expires=app.default_duration_days ? dateValue(Date.now()+app.default_duration_days*86400000) : ""}
  return {apps,templates,values,templateId:template?.id ?? ""}
}
export async function action({request,context}:Route.ActionArgs) {
  const env=context.cloudflare.env; await requireAuth(request,env)
  const saved=await saveLicenseForm(env,await request.formData(),null)
  return "error" in saved ? saved : redirect(`/licenses/${saved.license.id}?created=1`)
}
export default function NewLicense({loaderData,actionData}:Route.ComponentProps) {return <><PageHeader crumbs={[{label:"Licences",to:"/licenses"},{label:"New licence"}]}/><div className="max-w-6xl p-4 pt-0 lg:px-6"><h1 className="mb-1 text-2xl font-semibold tracking-tight">New licence</h1><p className="mb-6 text-sm text-muted-foreground">Attach the apps this customer can access. They share one licence key.</p><LicenseForm key={loaderData.templateId} {...loaderData} error={actionData?.error} submitLabel="Create licence" cancelTo="/licenses"/></div></>}
