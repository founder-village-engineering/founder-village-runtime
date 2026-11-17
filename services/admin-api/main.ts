import { admin } from "./app.ts";
import { local } from "../../packages/auth/index.ts";
import { pool, secret } from "../../packages/database/index.ts";
import { fatal, shutdown } from "../../packages/observability/index.ts";
try {
  if (!local()) {
    secret("ACCESS_AUD");
    secret("ACCESS_TEAM");
    secret("OIDC_JWKS_URL");
  }
  const db = pool("CONTROL_DATABASE_URL");
  const app = await admin(db);
  await app.listen({
    host: process.env.BIND_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 43802),
  });
  await shutdown(async () => {
    await app.close();
    await db.end();
  });
} catch {
  fatal();
}
