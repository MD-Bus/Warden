import type { Route } from "./+types/apps.$appId.files"
import { requireAuth } from "~/server/auth.server"
import { getApp } from "~/server/apps.server"
import { storeFile } from "~/server/files.server"

/** Receives the dashboard upload of an app release: PUT with the raw file as the body and the options in the query string. */
export async function action({ request, context, params }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  if (request.method !== "PUT") return Response.json({ error: "Use PUT" }, { status: 405 })
  const app = await getApp(env, params.appId)
  if (!app) return Response.json({ error: "App not found" }, { status: 404 })
  const q = new URL(request.url).searchParams
  const stored = await storeFile(env, { app }, {
    name: q.get("name") ?? "",
    statuses: q.get("statuses") ?? undefined,
    track: q.get("track"),
    checkDomain: q.get("check_domain") !== "false",
    version: q.get("version") ?? "",
    channel: q.get("channel") ?? undefined,
    labels: q.get("labels") ?? undefined,
    contentType: request.headers.get("content-type"),
    size: Number(request.headers.get("content-length")),
    body: request.body,
  })
  return "error" in stored ? Response.json({ error: stored.error }, { status: stored.status }) : Response.json({ file: { id: stored.file.id } }, { status: 201 })
}
