import { execFile } from "node:child_process";
import { get } from "node:http";
import { promisify } from "node:util";

const exec = promisify(execFile);
await exec(
  "docker",
  [
    "compose",
    "--project-directory",
    ".",
    "--env-file",
    ".state/local.env",
    "-p",
    "fv-local",
    "-f",
    "infra/compose/compose.yml",
    "-f",
    ".state/local/applications.compose.json",
    "--profile",
    "applications",
    "up",
    "-d",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "90",
    "api-blue",
    "api-green",
    "admin",
    "workers",
    "caddy",
  ],
  { timeout: 120_000 },
);
for (const host of ["api.fv", "admin.fv"]) {
  // Fetch derives Host from the URL. Send Caddy's virtual host over loopback.
  const status = await new Promise<number | undefined>((accept, reject) => {
    get(
      {
        hostname: "127.0.0.1",
        port: 43880,
        path: "/health/ready",
        headers: { host },
        signal: AbortSignal.timeout(5000),
      },
      (response) => {
        response.resume();
        accept(response.statusCode);
      },
    ).once("error", reject);
  });
  if (status !== 200)
    throw new Error(`container readiness failed for ${host} (HTTP ${status})`);
}
console.log("native API colors, admin, workers and proxy are ready");
