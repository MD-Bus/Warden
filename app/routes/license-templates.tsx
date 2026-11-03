import { useState } from "react"
import { Form, Link, redirect, useNavigation } from "react-router"
import { Plus, Trash2 } from "lucide-react"
import type { Route } from "./+types/license-templates"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { ConfirmAction } from "#/components/confirm-action"
import { FieldLabel } from "#/components/help-tip"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Textarea } from "#/components/ui/textarea"
import { NativeSelect } from "#/components/ui/native-select"
import type { ExpiryMode, TemplateSlot } from "#/lib/entitlements"
import { requireAuth } from "~/server/auth.server"
import { listApps } from "~/server/apps.server"
import { getTemplate, listTemplates, saveTemplate } from "~/server/entitlements.server"
export const meta: Route.MetaFunction = () => [{ title: "Licence templates | Warden" }]
export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const [templates, apps] = await Promise.all([listTemplates(env), listApps(env)])
  const id = new URL(request.url).searchParams.get("edit")
  return { templates, apps, editing: templates.find((t) => t.id === id) ?? null }
}
export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const form = await request.formData(),
    id = String(form.get("id") ?? ""),
    before = id ? await getTemplate(env, id) : null
  if (id && !before) return { error: "This template no longer exists." }
  if (form.get("intent") === "delete") {
    if (before) await env.DB.prepare("DELETE FROM license_templates WHERE id=?").bind(before.id).run()
    return redirect("/license-templates")
  }
  let slots: unknown
  try {
    slots = JSON.parse(String(form.get("slots") ?? "[]"))
  } catch {
    return { error: "The template slots could not be read." }
  }
  const result = await saveTemplate(env, { ...Object.fromEntries(form), slots }, before)
  if ("response" in result) {
    const value = (await result.response.json()) as { error: { message: string } }
    return { error: value.error.message }
  }
  return redirect("/license-templates")
}
export default function Templates({ loaderData, actionData }: Route.ComponentProps) {
  const [deleting, setDeleting] = useState<string | null>(null)
  return (
    <>
      <PageHeader crumbs={[{ label: "Licence templates" }]} />
      <div className="space-y-6 p-4 pt-0 lg:px-6">
        <PageTitle title="Licence templates" description="Prepare app tags once, then choose the apps when issuing a licence." />
        <div className="grid gap-4 xl:grid-cols-2">
          {loaderData.templates.map((t) => (
            <section key={t.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div>
                <h2 className="font-semibold">{t.name}</h2>
                <p className="text-sm text-muted-foreground">{t.description}</p>
              </div>
              <p className="text-sm">{t.expiry_mode === "shared" ? "Shared expiry" : "Separate expiries"}</p>
              <div className="flex flex-wrap gap-2">
                {t.slots.map((s) => (
                  <span key={s.tag} className="rounded border px-2 py-1 text-xs font-mono">
                    {s.tag}
                    {s.required ? "" : " (optional)"}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <Link to={`/licenses/new?template=${t.id}`}>Use template</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link to={`?edit=${t.id}`}>Edit</Link>
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDeleting(t.id)}>
                  Delete
                </Button>
              </div>
            </section>
          ))}
        </div>
        <TemplateEditor key={loaderData.editing?.id ?? "new"} {...loaderData} error={actionData?.error} />
        <ConfirmAction
          intent="delete"
          fields={{ id: deleting ?? "" }}
          open={Boolean(deleting)}
          onOpenChange={(v) => {
            if (!v) setDeleting(null)
          }}
          title="Delete this template?"
          description="Existing licences keep their tags and apps."
          confirm="Delete template"
        />
      </div>
    </>
  )
}
function TemplateEditor({ editing, apps, error }: { editing: Route.ComponentProps["loaderData"]["editing"]; apps: Route.ComponentProps["loaderData"]["apps"]; error?: string }) {
  const [slots, setSlots] = useState<TemplateSlot[]>(
    editing?.slots ?? [
      { tag: "parent-theme", app: null, required: true },
      { tag: "child-theme", app: null, required: true },
    ],
  )
  const [mode, setMode] = useState<ExpiryMode>(editing?.expiry_mode ?? "shared"),
    busy = useNavigation().state !== "idle"
  const change = (index: number, patch: Partial<TemplateSlot>) => setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  return (
    <Form method="post" className="max-w-4xl space-y-4 rounded-lg border bg-card p-5">
      <h2 className="text-lg font-semibold">{editing ? `Edit ${editing.name}` : "New template"}</h2>
      <input type="hidden" name="id" value={editing?.id ?? ""} />
      <input type="hidden" name="slots" value={JSON.stringify(slots)} />
      <div className="space-y-2">
        <FieldLabel htmlFor="template-name">Name</FieldLabel>
        <Input id="template-name" name="name" defaultValue={editing?.name ?? ""} required maxLength={80} placeholder="WordPress website" />
      </div>
      <div className="space-y-2">
        <FieldLabel htmlFor="template-description">Description</FieldLabel>
        <Textarea id="template-description" name="description" defaultValue={editing?.description ?? ""} maxLength={500} />
      </div>
      <div className="space-y-2">
        <FieldLabel htmlFor="template-expiry">Default expiry mode</FieldLabel>
        <NativeSelect id="template-expiry" name="expiry_mode" value={mode} onChange={(e) => setMode(e.target.value as ExpiryMode)}>
          <option value="shared">Shared expiry for all apps</option>
          <option value="separate">Separate expiry for each app</option>
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">
        Declare the tags the site expects. App selection is optional here; required slots must have an app when a licence is created. Status choices come from the selected app.
      </p>
      {slots.map((s, i) => (
        <div key={i} className="grid items-end gap-3 rounded border p-3 sm:grid-cols-[1fr_1fr_auto_auto]">
          <div className="space-y-2">
            <FieldLabel htmlFor={`slot-tag-${i}`}>Tag</FieldLabel>
            <Input id={`slot-tag-${i}`} required pattern="[a-z][a-z0-9_-]{0,47}" maxLength={48} value={s.tag} onChange={(e) => change(i, { tag: e.target.value })} />
          </div>
          <div className="space-y-2">
            <FieldLabel htmlFor={`slot-app-${i}`}>Default app</FieldLabel>
            <NativeSelect id={`slot-app-${i}`} value={s.app ?? ""} onChange={(e) => change(i, { app: e.target.value || null })}>
              <option value="">Choose when issuing</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <label className="flex items-center gap-2 text-sm py-2">
            <input type="checkbox" checked={s.required} onChange={(e) => change(i, { required: e.target.checked })} /> Required
          </label>
          <Button type="button" size="icon" variant="ghost" aria-label={`Remove slot ${i + 1}`} onClick={() => setSlots((prev) => prev.filter((_, n) => n !== i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" disabled={slots.length >= 50} onClick={() => setSlots((prev) => [...prev, { tag: "", app: null, required: true }])}>
        <Plus /> Add tag
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">Saving changes the template for future licences. Existing licences keep their current settings.</p>
      <div className="flex gap-2">
        <Button disabled={busy}>{editing ? "Save template" : "Create template"}</Button>
        {editing && (
          <Button asChild variant="outline">
            <Link to="/license-templates">Cancel</Link>
          </Button>
        )}
      </div>
    </Form>
  )
}
