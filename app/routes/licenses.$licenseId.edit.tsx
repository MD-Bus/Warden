import { redirect } from "react-router"
import type { Route } from "./+types/licenses.$licenseId.edit"
import { PageHeader } from "#/components/page-header"
import { dateValue, LicenseForm, type FormValues } from "#/components/license-form"
import { requireAuth } from "~/server/auth.server"
import { listApps } from "~/server/apps.server"
import { listAttachments } from "~/server/entitlements.server"
import { getLicense } from "~/server/licenses.server"
import { saveLicenseForm } from "~/server/license-dashboard.server"

export const meta: Route.MetaFunction = () => [{ title: "Edit licence | Warden" }]

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const license = await getLicense(env, params.licenseId)
  if (!license) throw new Response("Licence not found", { status: 404 })
  const [apps, attachments] = await Promise.all([listApps(env), listAttachments(env, license.id)])
  const shared = license.expiry_mode !== "separate"

  const values: FormValues = {
    name: license.name,
    customer_name: license.customer_name,
    customer_email: license.customer_email,
    max_sites: license.max_sites?.toString() ?? "",
    domains: license.domains,
    message: license.message,
    notes: license.notes,
    grace_days: license.grace_days?.toString() ?? "",
    expires: dateValue(license.expires_at),
    expiry_mode: shared ? "shared" : "separate",
    apps: attachments.map((e) => ({
      tag: e.tag,
      app: e.app_id,
      status: e.status,
      expires_at: dateValue(shared ? license.expires_at : e.expires_at),
      grace_days: e.grace_days?.toString() ?? "",
      message: e.message,
    })),
  }
  // A legacy licence (created through the deprecated singular API) has no attachment yet: saving gives it one.
  if (!values.apps.length && license.app_id) {
    values.apps = [{ tag: "default", app: license.app_id, status: license.status, expires_at: dateValue(license.expires_at), grace_days: "", message: "" }]
  }
  return { license, apps, values }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const license = await getLicense(env, params.licenseId)
  if (!license) throw new Response("Licence not found", { status: 404 })
  const saved = await saveLicenseForm(env, await request.formData(), license)
  return "error" in saved ? saved : redirect(`/licenses/${license.id}`)
}

export default function EditLicense({ loaderData, actionData }: Route.ComponentProps) {
  const { license, apps, values } = loaderData
  return (
    <>
      <PageHeader crumbs={[{ label: "Licences", to: "/licenses" }, { label: license.name, to: `/licenses/${license.id}` }, { label: "Edit" }]} />
      <div className="max-w-6xl p-4 pt-0 lg:px-6">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Edit licence</h1>
        <LicenseForm apps={apps} values={values} error={actionData?.error} submitLabel="Save changes" cancelTo={`/licenses/${license.id}`} />
      </div>
    </>
  )
}
