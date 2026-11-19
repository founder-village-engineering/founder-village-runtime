import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type pg from "pg";
import { pool } from "./index.ts";
export const applicationSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    database: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    hasuraSource: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    owner: z.string().min(1).max(100),
  })
  .strict();
export const applications = z
  .array(applicationSchema)
  .min(1)
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../config/applications.json", import.meta.url),
        ),
        "utf8",
      ),
    ),
  );
if (
  new Set(applications.map((a) => a.id)).size !== applications.length ||
  new Set(applications.map((a) => a.database)).size !== applications.length ||
  new Set(applications.map((a) => a.hasuraSource)).size !== applications.length
)
  throw new Error("duplicate application namespace");
export const appKey = (name: string) => name.replaceAll("-", "_").toUpperCase();
export function applicationPools(
  kind: "api" | "worker" | "migration" | "monitor" = "api",
): Record<string, pg.Pool> {
  return Object.fromEntries(
    applications.map((a) => [
      a.id,
      pool(
        `${kind === "api" ? "" : kind.toUpperCase() + "_"}${appKey(a.id)}_DATABASE_URL`,
      ),
    ]),
  );
}
export function selectApplication(
  dbs: Record<string, pg.Pool>,
  name: unknown,
): pg.Pool {
  const id = name ?? "founder-village";
  if (typeof id !== "string" || !Object.hasOwn(dbs, id))
    throw Object.assign(new Error("unknown application"), { statusCode: 400 });
  return dbs[id]!;
}
