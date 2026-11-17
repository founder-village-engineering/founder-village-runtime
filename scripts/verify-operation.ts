import { readFile } from "node:fs/promises";
import { pool } from "../packages/database/index.ts";
import {
  assertion,
  authorizeOperation,
} from "../packages/operations/authorize.ts";
const expected = assertion.parse(
  JSON.parse(await readFile(process.argv[2] ?? "", "utf8")),
);
const db = pool("RUNNER_DATABASE_URL");
try {
  await authorizeOperation(db, expected);
  console.log("operation identity and request binding verified");
} finally {
  await db.end();
}
