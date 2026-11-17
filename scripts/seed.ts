import {
  applicationPools,
  applications,
} from "../packages/database/applications.ts";
import { pool } from "../packages/database/index.ts";
import { adminActions } from "../packages/contracts/index.ts";
import { local } from "../packages/auth/index.ts";
if (!local()) throw new Error("synthetic seeding is local-only");
const apps = applicationPools("migration"),
  control = pool("CONTROL_MIGRATION_DATABASE_URL");
try {
  for (const [name, app] of Object.entries(apps)) {
    await app.query(
      "INSERT INTO app.tenants(id,name) VALUES ('11111111-1111-4111-8111-111111111111','Demo Village'),('22222222-2222-4222-8222-222222222222','Other Village') ON CONFLICT DO NOTHING",
    );
    for (const [id, user] of [
      [
        "11111111-1111-4111-8111-111111111111",
        name === "founder-village" ? "alice" : name,
      ],
      [
        "22222222-2222-4222-8222-222222222222",
        name === "founder-village" ? "bob" : name + "-other",
      ],
    ])
      await app.query(
        "INSERT INTO app.memberships(tenant_id,actor) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, `${process.env.OIDC_ISSUER}|${user}`],
      );
  }
  await control.query(
    "INSERT INTO control.administrators(actor,actions,applications) VALUES($1,$2,$3) ON CONFLICT(actor) DO UPDATE SET applications=$3",
    [
      `${process.env.OIDC_ISSUER}|owner`,
      adminActions,
      applications.map((a) => a.id),
    ],
  );
  console.log("synthetic identities seeded");
} finally {
  await Promise.all([
    ...Object.values(apps).map((p) => p.end()),
    control.end(),
  ]);
}
