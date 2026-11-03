import { saveBundle } from "./entitlements.server"
import type { License } from "./licenses.server"
export async function saveLicenseForm(env: Env, form: FormData, before: License | null) {
  let apps: unknown
  try {
    apps = JSON.parse(String(form.get("apps_json") ?? "[]"))
  } catch {
    return { error: "The app selection could not be read. Reload the page and try again." }
  }
  const body: Record<string, unknown> = {
    ...Object.fromEntries(form),
    apps,
    max_sites: form.get("max_sites") || null,
    grace_days: form.get("grace_days") === "" ? null : Number(form.get("grace_days")),
    expires_at: form.get("expires_at") || null,
  }
  if (!body.template) delete body.template
  const result = await saveBundle(env, body, before)
  if ("response" in result) {
    const value = (await result.response.json()) as { error: { message: string } }
    return { error: value.error.message }
  }
  return { license: result.license }
}
