import { type RouteConfig, index, layout, route } from "@react-router/dev/routes"

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  // Raw file upload from the dashboard (a resource route: no page).
  route("licenses/:licenseId/files", "routes/licenses.$licenseId.files.tsx"),
  route("apps/:appId/files", "routes/apps.$appId.files.tsx"),
  // Resource routes of the dashboard (JSON and CSV).
  route("search", "routes/search.tsx"),
  route("licenses/export.csv", "routes/licenses.export.tsx"),
  route("integrations/github/:step", "routes/integrations.github.tsx"),
  layout("routes/app.tsx", [
    route("overview", "routes/overview.tsx"),
    route("licenses", "routes/licenses.tsx"),
    route("license-templates", "routes/license-templates.tsx"),
    route("licenses/new", "routes/licenses.new.tsx"),
    route("licenses/:licenseId", "routes/licenses.$licenseId.tsx"),
    route("licenses/:licenseId/edit", "routes/licenses.$licenseId.edit.tsx"),
    route("analytics", "routes/analytics.tsx"),
    route("apps", "routes/apps.tsx"),
    route("apps/new", "routes/apps.new.tsx"),
    route("apps/:appId", "routes/apps.$appId.tsx"),
    route("apps/:appId/edit", "routes/apps.$appId.edit.tsx"),
    route("protection", "routes/protection.tsx"),
    route("integrations", "routes/integrations.tsx"),
    route("api-keys", "routes/api-keys.tsx"),
  ]),
] satisfies RouteConfig
