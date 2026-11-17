import { pool } from "../packages/database/index.ts";
import { archiveAudit } from "../packages/operations/audit.ts";
const db = pool("RUNNER_DATABASE_URL");
try {
  const result = await archiveAudit(db);
  console.log(
    JSON.stringify({
      event: "audit.archived",
      count: result.count,
      signature: result.signature,
    }),
  );
} finally {
  await db.end();
}
