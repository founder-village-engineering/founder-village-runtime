import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { pathToFileURL } from "node:url";
import { applicationPools } from "./applications.ts";
import { pool, transaction } from "./index.ts";
export async function migrate(
  db: pg.Pool,
  kind: "app" | "control",
  application = "founder-village",
): Promise<void> {
  const files = (await readdir("database/migrations"))
    .filter((f) => f.endsWith(`_${kind}.sql`))
    .sort()
    .map((f) => ({ name: f, file: `database/migrations/${f}` }));
  if (kind === "app") {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(application))
      throw new Error("invalid application");
    try {
      for (const f of (await readdir(`database/applications/${application}`))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        files.push({
          name: `${application}/${f}`,
          file: `database/applications/${application}/${f}`,
        });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  await transaction(db, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(51827002)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS public.fv_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const history = await c.query<{ name: string; checksum: string }>(
      "SELECT name,checksum FROM public.fv_migrations",
    );
    const sources = new Set(files.map((entry) => entry.name));
    if (history.rows.some((entry) => !sources.has(entry.name)))
      throw new Error("applied migration missing from source inventory");
    const applied = new Map(
      history.rows.map((entry) => [entry.name, entry.checksum]),
    );
    for (const entry of files) {
      const file = entry.name;
      const sql = await readFile(entry.file, "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      if (applied.has(file)) {
        if (applied.get(file) !== hash)
          throw new Error("applied migration checksum mismatch");
        continue;
      }
      await c.query(sql);
      await c.query(
        "INSERT INTO public.fv_migrations(name,checksum) VALUES($1,$2)",
        [file, hash],
      );
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const apps = applicationPools("migration"),
    control = pool("CONTROL_MIGRATION_DATABASE_URL");
  try {
    for (const [name, db] of Object.entries(apps)) {
      await migrate(db, "app", name);
      console.log(`migrated ${name}`);
    }
    await migrate(control, "control");
    console.log("control migrations applied");
  } finally {
    await Promise.all([
      ...Object.values(apps).map((db) => db.end()),
      control.end(),
    ]);
  }
}
