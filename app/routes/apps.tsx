import { Link } from "react-router"
import { Boxes, Plus } from "lucide-react"
import type { Route } from "./+types/apps"
import { PageHeader } from "#/components/page-header"
import { PageTitle } from "#/components/page-title"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table"
import { requireAuth } from "~/server/auth.server"
import { listApps, outdatedSitesByApp } from "~/server/apps.server"

export const meta: Route.MetaFunction = () => [{ title: "Apps | Warden" }]

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env
  await requireAuth(request, env)
  const apps = await listApps(env)
  return { apps, outdated: await outdatedSitesByApp(env, apps) }
}

export default function Apps({ loaderData }: Route.ComponentProps) {
  const { apps, outdated } = loaderData
  return (
    <>
      <PageHeader crumbs={[{ label: "Apps" }]} />
      <div className="space-y-5 p-4 pt-0 lg:px-6">
        <PageTitle
          title="Apps"
          description="Products you license to many customers. Each app has its own licences, defaults, statuses and releases."
          actions={
            <Button asChild>
              <Link to="/apps/new">
                <Plus /> New app
              </Link>
            </Button>
          }
        />

        {apps.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Boxes />
              </EmptyMedia>
              <EmptyTitle>No apps yet</EmptyTitle>
              <EmptyDescription>Create an app for a product or a custom project, then attach it to customer licences.</EmptyDescription>
            </EmptyHeader>
            <Button asChild>
              <Link to="/apps/new">
                <Plus /> New app
              </Link>
            </Button>
          </Empty>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Licences</TableHead>
                  <TableHead className="hidden sm:table-cell">Valid</TableHead>
                  <TableHead className="hidden md:table-cell">Sites</TableHead>
                  <TableHead className="hidden md:table-cell">Latest release</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell>
                      <Link to={`/apps/${app.id}`} prefetch="intent" className="font-medium hover:underline">
                        {app.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{app.description || app.slug}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{app.licenses}</TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">{app.valid}</TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">{app.sites}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      {app.latest_version ? (
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-xs">{app.latest_version}</span>
                          {(outdated[app.id] ?? 0) > 0 && <Badge variant="warning">{outdated[app.id]} site{outdated[app.id] === 1 ? "" : "s"} behind</Badge>}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No release</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
