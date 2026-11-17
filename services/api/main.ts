import { api } from "./app.ts";
import { applicationPools } from "../../packages/database/applications.ts";
import { fatal, shutdown } from "../../packages/observability/index.ts";
try {
  const db = applicationPools();
  const app = await api(db);
  await app.listen({
    host: process.env.BIND_HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 43801),
  });
  await shutdown(async () => {
    await app.close();
    await Promise.all(Object.values(db).map((p) => p.end()));
  });
} catch {
  fatal();
}
