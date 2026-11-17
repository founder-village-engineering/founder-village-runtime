import { applications } from "../packages/database/applications.ts";
import { z } from "zod";
import { adminActions } from "../packages/contracts/index.ts";
import { pool, audit, transaction } from "../packages/database/index.ts";
const actor = z.string().min(3).max(512).parse(process.argv[2]),
  actions = z
    .array(z.enum(adminActions))
    .min(1)
    .parse(process.argv[3]?.split(","));
const scopes = z
  .array(z.string().refine((id) => applications.some((a) => a.id === id)))
  .min(1)
  .parse(process.argv[4]?.split(","));
const db = pool("CONTROL_MIGRATION_DATABASE_URL");
try {
  await transaction(db, async (c) => {
    await c.query(
      "INSERT INTO control.administrators(actor,actions,applications) VALUES($1,$2,$3) ON CONFLICT(actor) DO UPDATE SET actions=$2,applications=$3,enabled=true",
      [actor, actions, scopes],
    );
    await audit(c, "operator-cli", "admins.bootstrap", actor, "succeeded");
  });
  console.log("administrator grant recorded");
} finally {
  await db.end();
}
