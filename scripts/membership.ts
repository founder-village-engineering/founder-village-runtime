import { z } from "zod";
import {
  applications,
  applicationPools,
} from "../packages/database/applications.ts";
import { pool, audit } from "../packages/database/index.ts";
const application = z
    .string()
    .refine((id) => applications.some((a) => a.id === id))
    .parse(process.argv[2]),
  action = z.enum(["grant", "revoke"]).parse(process.argv[3]),
  tenant = z.string().uuid().parse(process.argv[4]),
  actor = z.string().min(3).max(512).parse(process.argv[5]);
const apps = applicationPools("migration"),
  control = pool("CONTROL_MIGRATION_DATABASE_URL");
try {
  await apps[application]!.query(
    "INSERT INTO app.memberships(tenant_id,actor,enabled) VALUES($1,$2,$3) ON CONFLICT(tenant_id,actor) DO UPDATE SET enabled=$3",
    [tenant, actor, action === "grant"],
  );
  await audit(
    control,
    "operator-cli",
    `membership.${action}`,
    `${application}/${tenant}`,
    "succeeded",
  );
  console.log("application membership updated");
} finally {
  await Promise.all([
    ...Object.values(apps).map((p) => p.end()),
    control.end(),
  ]);
}
