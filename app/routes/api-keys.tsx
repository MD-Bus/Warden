import { useEffect, useState } from "react"
import { data, useFetcher } from "react-router"
import { KeyRound, Plus, Trash2 } from "lucide-react"
import type { Route } from "./+types/api-keys"
import { PageHeader } from "#/components/page-header"
import { Ago } from "#/components/time"
import { CodeBlock, CopyField, InlineCode } from "#/components/code-block"
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog"
import { Input } from "#/components/ui/input"
import { FieldLabel } from "#/components/help-tip"
import { NativeSelect } from "#/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table"
import { requireAuth } from "~/server/auth.server"
import { SCOPES, type Scope } from "#/lib/license"
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyRow } from "~/server/api-keys.server"

export const meta: Route.MetaFunction = () => [{ title: "API keys | Warden" }]

const SCOPE_TEXT: Record<Scope, string> = {
  read: "Read only: list and view licences",
  manage: "Manage: also create, edit, change status, renew, manage files",
  full: "Full access: also delete licences and regenerate keys",
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  return { keys: await listApiKeys(env), origin: new URL(request.url).origin }
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const form = await request.formData()
  const intent = String(form.get("intent"))
  if (intent === "create") {
    const name = String(form.get("name") ?? "").trim().slice(0, 60)
    if (!name) return data({ error: "Give the key a name." }, { status: 400 })
    const scope = String(form.get("scope"))
    if (!(SCOPES as readonly string[]).includes(scope)) return data({ error: "Unknown access level." }, { status: 400 })
    const created = await createApiKey(env, name, scope as Scope)
    return data({ created: created.secret, id: created.id })
  }
  if (intent === "revoke") {
    await revokeApiKey(env, String(form.get("id")))
    return data({ revoked: true })
  }
  return data({ error: "Unknown action." }, { status: 400 })
}

export default function ApiKeys({ loaderData }: Route.ComponentProps) {
  const { keys, origin } = loaderData
  const create = useFetcher<{ created?: string; error?: string }>()
  const revoke = useFetcher()
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null)
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  useEffect(() => {
    if (revoke.state === "idle" && revoke.data) setRevoking(null)
  }, [revoke.state, revoke.data])
  useEffect(() => {
    if (create.state === "idle" && create.data?.created) {
      setSecret(create.data.created)
      setOpen(false)
    }
  }, [create.state, create.data])

  const example = `# issue a licence under an app (the app's defaults apply; safe to retry: the same external_ref returns the first one)
curl -X POST ${origin}/api/v1/licenses \\
  -H "Authorization: Bearer $WARDEN_KEY" -H "Content-Type: application/json" \\
  -d '{"name": "Harbor Studio website", "expiry_mode": "shared", "apps": [{"tag":"parent-theme","app":"harbor-theme"}], "customer_name": "Harbor Studio", "customer_email": "billing@harborstudio.com", "external_ref": "order-1042"}'

# renew it by 30 days, then suspend it
curl -X POST ${origin}/api/v1/licenses/<id>/renew  -H "Authorization: Bearer $WARDEN_KEY" -d '{"days": 30}'
curl -X POST ${origin}/api/v1/licenses/<id>/status -H "Authorization: Bearer $WARDEN_KEY" -d '{"tag":"parent-theme","status":"suspended"}'`

  return (
    <>
      <PageHeader crumbs={[{ label: "API keys" }]} />
      <div className="space-y-6 p-4 pt-0 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
            <p className="text-sm text-muted-foreground">
              API keys authenticate as your account. Send <InlineCode>Authorization: Bearer wk_...</InlineCode>. Reference: <a className="underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>.
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus /> New key
          </Button>
        </div>

        {secret && (
          <Alert>
            <KeyRound />
            <AlertTitle>Copy your new key now</AlertTitle>
            <AlertDescription className="w-full space-y-2">
              <p>This is the only time it is shown. Store it in your app&apos;s secrets.</p>
              <CopyField value={secret} />
              <Button size="sm" variant="outline" onClick={() => setSecret(null)}>
                Done
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="rounded-lg border">
          {keys.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No API keys yet. Create one to manage licences programmatically.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead className="hidden sm:table-cell">Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="font-mono text-xs">{k.prefix}...</TableCell>
                    <TableCell>
                      <Badge variant={k.scope === "read" ? "secondary" : "outline"}>{k.scope}</Badge>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                      <Ago ts={k.last_used_at} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <section className="space-y-2">
          <h2 className="font-semibold">Examples</h2>
          <CodeBlock code={example} language="bash" />
        </section>
      </div>

      <Dialog open={revoking !== null} onOpenChange={(next) => revoke.state === "idle" && !next && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke &ldquo;{revoking?.name}&rdquo;?</DialogTitle>
            <DialogDescription>Anything using this key stops working immediately. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={revoke.state !== "idle"}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={revoke.state !== "idle"} onClick={() => revoking && revoke.submit({ intent: "revoke", id: revoking.id }, { method: "post" })}>
              {revoke.state !== "idle" ? "Revoking..." : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>Create a separate key for each integration, with the lowest permission it needs.</DialogDescription>
          </DialogHeader>
          <create.Form method="post">
            <input type="hidden" name="intent" value="create" />
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <FieldLabel htmlFor="key-name" help="A label to recognise where the key is used, for example the integration or service.">Name</FieldLabel>
                <Input id="key-name" name="name" placeholder="Checkout webhook" required autoFocus />
              </div>
              <div className="grid gap-2">
                <FieldLabel htmlFor="key-scope" help="What the key may do. Give each integration the lowest level it needs.">Permissions</FieldLabel>
                <NativeSelect id="key-scope" name="scope" defaultValue="manage">
                  {SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_TEXT[s]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {create.data?.error && <p className="text-sm text-destructive">{create.data.error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.state !== "idle"}>
                {create.state !== "idle" ? "Creating..." : "Create key"}
              </Button>
            </DialogFooter>
          </create.Form>
        </DialogContent>
      </Dialog>
    </>
  )
}
