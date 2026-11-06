/**
 * Applies pending D1 migrations from inside the Worker.
 *
 * Installs made through the Cloudflare dashboard (Deploy button, "connect repository") build the app
 * but never run `wrangler d1 migrations apply`, so a new version could start against an old database.
 * Migrations are bundled into the Worker and applied on the first request instead, using the same
 * `d1_migrations` bookkeeping table as wrangler so both ways of migrating stay compatible.
 */
export type Migration = { name: string; sql: string }

/** Splits a migration file into single statements, dropping `--` comments. */
export function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

const ALREADY_APPLIED = /already exists|duplicate column name/i

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const res = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()
  return new Set(res.results.map((r) => r.name))
}

async function apply(db: D1Database, migration: Migration): Promise<void> {
  const statements = splitStatements(migration.sql)
  try {
    // One transaction: all statements and the bookkeeping row, or nothing.
    await db.batch([
      ...statements.map((s) => db.prepare(s)),
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name),
    ])
    return
  } catch (error) {
    // Another request may have applied it a moment ago.
    if ((await appliedNames(db)).has(migration.name)) return
    if (!ALREADY_APPLIED.test(String(error instanceof Error ? error.message : error))) throw error
  }

  // The database already contains part of this migration (for example it was applied by hand
  // without being recorded). Run the statements one by one, skipping what already exists.
  for (const statement of statements) {
    try {
      await db.prepare(statement).run()
    } catch (error) {
      if (!ALREADY_APPLIED.test(String(error instanceof Error ? error.message : error))) throw error
    }
  }
  await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(migration.name).run()
}

let migrated = false

/**
 * Cheap once an isolate has finished. Safe to call on every request.
 *
 * Only this boolean is shared, never a promise: the Workers runtime cancels a request when its client disconnects, and
 * I/O started by a cancelled request never settles, which would leave every later request in the isolate waiting.
 * Requests that arrive together each run the check instead; `apply` already handles that race.
 */
export async function ensureMigrated(db: D1Database, migrations: Migration[]): Promise<void> {
  if (migrated) return
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
    )
    .run()
  const done = await appliedNames(db)
  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!done.has(migration.name)) await apply(db, migration)
  }
  migrated = true
}

/** Response shown when the database cannot be brought up to date. */
export function migrationFailureResponse(request: Request, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  console.error("Database migration failed:", error)
  const isApi = new URL(request.url).pathname.startsWith("/api/") || request.method === "POST"
  if (isApi) {
    return new Response(JSON.stringify({ ok: false, error: "The database is being upgraded and is not ready. Try again shortly." }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "10" },
    })
  }
  const escaped = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Database upgrade failed</title>
<body style="font-family:system-ui;max-width:560px;margin:15vh auto;padding:0 20px;line-height:1.5">
<h1>Database upgrade failed</h1>
<p>Warden could not update its database automatically. As a fallback, run this once from the project folder (use your Worker's name):</p>
<pre style="background:#eee;padding:12px;border-radius:8px">npx wrangler d1 migrations apply &lt;worker-name&gt;-db --remote</pre>
<p>Details: <code>${escaped}</code></p></body>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  )
}
