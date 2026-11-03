import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Local preview credentials and the API key exist in memory only.
const root = fileURLToPath(new URL("../", import.meta.url))
const node22 = "/opt/homebrew/opt/node@22/bin"
const password = randomBytes(18).toString("base64url")
// REVIEW_PORT picks another port. --strictPort stops instead of moving to the next free port, which would seed
// whichever server already listens on the expected one.
const port = process.env.REVIEW_PORT || "5180"
const origin = `http://127.0.0.1:${port}`
const child = spawn("npm", ["run", "dev", "--", "--port", port, "--strictPort", "--host", "127.0.0.1"], {
  cwd: root,
  env: {
    ...process.env,
    PATH: existsSync(node22) ? `${node22}:${process.env.PATH}` : process.env.PATH,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: password,
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    CLOUDFLARE_VITE_FORCE_LOCAL: "true",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_WRITE_LOGS: "false",
  },
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
})
let exited = false
for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => process.stdout.write(String(data).replaceAll(password, "[local password]")))
child.on("exit", (code) => {
  exited = true
  process.exitCode = code ?? 1
})
function stop(signal = "SIGTERM") {
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {}
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal))
try {
  let ready = false
  for (let attempt = 0; attempt < 120 && !exited; attempt++) {
    try {
      ready = (await fetch(`${origin}/login`)).ok
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error("The local server could not start. See the error above.")
  const login = await fetch(`${origin}/login`, { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ username: "admin", password }), redirect: "manual" })
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("wd_session="))
    ?.split(";")[0]
  if (!cookie) throw new Error("Could not create the local preview session. Existing .dev.vars files can override process environment; remove or move them before running this command.")
  const keyResponse = await fetch(`${origin}/api-keys.data`, {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie },
    body: new URLSearchParams({ intent: "create", name: "Local review", scope: "full" }),
  })
  const keyText = await keyResponse.text()
  const key = keyText.match(/wk_[A-Za-z0-9]{40}/)?.[0]
  const keyId = keyText.match(/key_[a-z0-9]+/)?.[0]
  if (!key || !keyId) throw new Error("Could not create the temporary preview API key.")
  const api = async (method, path, body) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error?.message ?? `Request failed: ${response.status}`)
    return value
  }
  try {
    const existing = (await api("GET", "/apps?limit=100")).data
    const app = async (slug, name) => existing.find((a) => a.slug === slug) ?? api("POST", "/apps", { name, slug })
    const parent = await app("harbor-theme", "Harbor Theme")
    const childApp = await app("harbor-studio-child", "Harbor Studio Child")
    const booking = await app("atlas-booking", "Atlas Booking")
    for (const [product, version] of [
      [parent, "1.4.0"],
      [childApp, "1.1.0"],
      [booking, "2.1.0"],
    ]) {
      const files = (await api("GET", `/apps/${product.id}/files`)).data
      if (!files.some((f) => f.version === version)) {
        const bytes = demoZip(`${product.name} ${version}\nLocal review example. This archive contains a text file, not an installable theme or plugin.\n`)
        const response = await fetch(`${origin}/api/v1/apps/${product.id}/files?name=${product.slug}-${version}.zip&version=${version}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/zip" },
          body: bytes,
        })
        if (!response.ok) throw new Error("Could not upload a local demo release.")
      }
    }
    const templates = (await api("GET", "/license-templates?limit=100")).data
    if (!templates.some((t) => t.name === "WordPress website"))
      await api("POST", "/license-templates", {
        name: "WordPress website",
        description: "One licence key for a parent theme and a customer-specific child theme.",
        expiry_mode: "shared",
        slots: [{ tag: "parent-theme", app: parent.id }, { tag: "child-theme" }, { tag: "booking", app: booking.id, required: false }],
      })
    const date = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
    const shared = await api("POST", "/licenses", {
      name: "Harbor Studio · shared expiry",
      customer_name: "Harbor Studio",
      domains: ["harborstudio.com"],
      max_sites: 1,
      expiry_mode: "shared",
      expires_at: date(365),
      external_ref: "local-review-shared",
      apps: [
        { tag: "parent-theme", app: parent.id },
        { tag: "child-theme", app: childApp.id, status: "completed" },
      ],
    })
    const separate = await api("POST", "/licenses", {
      name: "Harbor Studio · separate expiries",
      customer_name: "Harbor Studio",
      max_sites: 1,
      expiry_mode: "separate",
      external_ref: "local-review-separate",
      apps: [
        { tag: "parent-theme", app: parent.id, expires_at: date(365) },
        { tag: "child-theme", app: childApp.id, status: "completed", expires_at: null },
        { tag: "booking", app: booking.id, expires_at: date(30) },
      ],
    })
    for (const licence of [shared, separate])
      await fetch(`${origin}/check/${licence.key}?domain=harborstudio.com`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versions: { "parent-theme": "1.3.0", "child-theme": "1.0.0", booking: "2.0.0" } }),
      })
    console.log(
      `\nLocal review is ready: ${origin}/licenses\nUsername: admin\nLocal password: ${password}\nShared expiry: ${origin}/licenses/${shared.id}\nSeparate expiries: ${origin}/licenses/${separate.id}\nTemplates: ${origin}/license-templates\n\nKeep this terminal open. Press Ctrl+C to stop. This command uses local D1 and R2 only.\n`,
    )
  } finally {
    // Revoke the seeding key immediately; the preview uses dashboard sessions afterwards.
    await fetch(`${origin}/api-keys.data`, { method: "POST", headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ intent: "revoke", id: keyId }) })
  }
} catch (error) {
  console.error(error.message)
  stop()
  process.exitCode = 1
}

function demoZip(text) {
  const name = Buffer.from("README.txt"),
    body = Buffer.from(text)
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(body.length, 22)
  local.writeUInt16LE(name.length, 26)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(name.length, 28)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + body.length, 16)
  return Buffer.concat([local, name, body, central, name, end])
}
