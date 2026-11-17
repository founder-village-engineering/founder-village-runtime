import { readFile, writeFile } from "node:fs/promises";
import { applications, appKey } from "../packages/database/applications.ts";
const template = await readFile("hasura/metadata/table.template.json", "utf8");
const sources = [];
for (const a of applications) {
  const key = appKey(a.id);
  let tables: unknown;
  try {
    tables = JSON.parse(
      await readFile(`hasura/applications/${a.id}/tables.json`, "utf8"),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    tables = [
      JSON.parse(template.replaceAll("__ROLE__", `user_${key.toLowerCase()}`)),
    ];
  }
  sources.push({
    name: a.hasuraSource,
    kind: "postgres",
    customization: {
      root_fields: { namespace: key.toLowerCase() },
      type_names: { prefix: `${key.toLowerCase()}_` },
    },
    tables,
    configuration: {
      connection_info: {
        database_url: { from_env: `HASURA_${key}_DATABASE_URL` },
        pool_settings: { max_connections: 5, idle_timeout: 60 },
        isolation_level: "read-committed",
        use_prepared_statements: true,
      },
    },
  });
}
await writeFile(
  "hasura/metadata/metadata.json",
  JSON.stringify({ version: 3, sources }, null, 2) + "\n",
);
console.log("Hasura source metadata generated from registry");
