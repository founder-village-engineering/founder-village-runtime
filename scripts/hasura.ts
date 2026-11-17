import { readFile } from "node:fs/promises";
import { secret } from "../packages/database/index.ts";
export async function hasura() {
  const metadata = JSON.parse(
    await readFile("hasura/metadata/metadata.json", "utf8"),
  ) as Record<string, unknown>;
  const response = await fetch(`${secret("HASURA_URL")}/v1/metadata`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": secret("HASURA_ADMIN_SECRET"),
    },
    body: JSON.stringify({
      type: "replace_metadata",
      args: { allow_inconsistent_metadata: false, metadata },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Hasura metadata rejected");
  const check = await fetch(`${secret("HASURA_URL")}/v1/metadata`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": secret("HASURA_ADMIN_SECRET"),
    },
    body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await check.json()) as { is_consistent?: boolean };
  if (!check.ok || body.is_consistent !== true)
    throw new Error("inconsistent Hasura metadata");
  console.log("Hasura metadata consistent");
}
await hasura();
