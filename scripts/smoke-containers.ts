import { execFile } from "node:child_process";
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
  const response = await fetch("http://127.0.0.1:43880/health/ready", {
    headers: { Host: host },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`container readiness failed for ${host}`);
}
console.log("native API colors, admin, workers and proxy are ready");
