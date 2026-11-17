import { applicationPools } from "../../packages/database/applications.ts";
import { secret } from "../../packages/database/index.ts";
import { worker } from "../../packages/queue/index.ts";
import { fatal, shutdown, server } from "../../packages/observability/index.ts";
const db = applicationPools("worker"),
  abort = new AbortController();
let connected = 0;
let work: Promise<void> | undefined;
const health = await server("workers");
health.get("/health/ready", async () => {
  if (connected !== Object.keys(db).length)
    throw Object.assign(new Error("broker not ready"), { statusCode: 503 });
  await Promise.all(Object.values(db).map((p) => p.query("SELECT 1")));
  return { status: "ready" };
});
if (process.env.BIND_HOST)
  await health.listen({
    host: process.env.BIND_HOST,
    port: Number(process.env.PORT ?? 8080),
  });
await shutdown(async () => {
  connected = 0;
  abort.abort();
  await work?.catch(() => {});
  await health.close();
  await Promise.all(Object.values(db).map((p) => p.end()));
});
try {
  work = Promise.all(
    Object.entries(db).map(([name, p]) =>
      worker(p, secret("AMQP_URL"), abort.signal, name, () => {
        connected++;
      }),
    ),
  ).then(() => {});
  await work;
} catch {
  if (!abort.signal.aborted) fatal();
}
