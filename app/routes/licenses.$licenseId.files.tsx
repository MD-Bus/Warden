import type { Route } from "./+types/licenses.$licenseId.files"
import { requireAuth } from "~/server/auth.server"
import { storeFile } from "~/server/files.server"
import { getLicense } from "~/server/licenses.server"

/** Receives the dashboard upload: PUT with the raw file as the body and the options in the query string. */
export async function action({ request, context, params }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  if (request.method !== "PUT") return Response.json({ error: "Use PUT" }, { status: 405 })
  const license = await getLicense(env, params.licenseId)
  if (!license) return Response.json({ error: "Licence not found" }, { status: 404 })
  if (license.expiry_mode && license.expiry_mode !== "legacy") return Response.json({ error: "Manage files on the attached app." }, { status: 409 })
  const q = new URL(request.url).searchParams
  const stored = await storeFile(env, { license }, {
    name: q.get("name") ?? "",
    statuses: q.get("statuses") ?? undefined,
    track: q.get("track"),
    checkDomain: q.get("check_domain") !== "false",
    version: q.get("version") ?? "",
    channel: q.get("channel") ?? undefined,
    contentType: request.headers.get("content-type"),
    size: Number(request.headers.get("content-length")),
    body: request.body,
  })
  return "error" in stored ? Response.json({ error: stored.error }, { status: stored.status }) : Response.json({ file: { id: stored.file.id } }, { status: 201 })
}
