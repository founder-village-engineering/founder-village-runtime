import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  applicationSchema,
  applications,
} from "../packages/database/applications.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const id = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .parse(process.argv[2]),
  owner = z.string().min(1).max(100).parse(process.argv[3]);
if (
  ["postgres", "template0", "template1"].includes(id) ||
  applications.some(
    (a) => a.id === id || a.database === id || a.hasuraSource === id,
  )
)
  throw new Error("namespace reserved or exists");
const entry = applicationSchema.parse({
  id,
  database: id,
  hasuraSource: id,
  owner,
});
await writeFile(
  "config/applications.json",
  JSON.stringify([...applications, entry], null, 2) + "\n",
);
await mkdir(`database/applications/${id}`, { recursive: true });
await mkdir(`hasura/applications/${id}`, { recursive: true });
await readFile("hasura/metadata/table.template.json");
await promisify(execFile)(
  process.execPath,
  ["--import", "tsx", "scripts/generate-hasura.ts"],
  { timeout: 30000 },
);
console.log(
  "Namespace registered. Review the diff, then render/up to provision roles, database, migrations, and source. Add explicit administrator and tenant grants.",
);
