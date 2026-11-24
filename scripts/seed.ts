import {
  applicationPools,
  applications,
} from "../packages/database/applications.ts";
import { applicationId as primaryApplicationId } from "../packages/frontend-contracts/founder-village-app/index.ts";
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
    if (name === primaryApplicationId) {
      await app.query(
        "INSERT INTO app.memberships(tenant_id,actor) VALUES ($1,$2),($3,$4) ON CONFLICT DO NOTHING",
        [
          "11111111-1111-4111-8111-111111111111",
          `${process.env.OIDC_ISSUER}|founders`,
          "22222222-2222-4222-8222-222222222222",
          `${process.env.OIDC_ISSUER}|founders-other`,
        ],
      );
      await app.query(
        `INSERT INTO app.members(id,tenant_id,actor,full_name,email,phone,room)
         VALUES
           ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',$1,'Alex Founder','alex@founder.village','+55 11 99999-0001','Garden House 3'),
           ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222',$2,'Other Founder','other@founder.village',NULL,NULL)
         ON CONFLICT(id) DO NOTHING`,
        [
          `${process.env.OIDC_ISSUER}|founders`,
          `${process.env.OIDC_ISSUER}|founders-other`,
        ],
      );
      await app.query(
        `INSERT INTO app.companies(id,tenant_id,founder_id,name,legal_name,website)
         VALUES
           ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','Canopy Labs','Canopy Labs Tecnologia Ltda.','https://canopy.example'),
           ('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','Open Courtyard',NULL,NULL)
         ON CONFLICT(id) DO NOTHING`,
      );
    }
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
