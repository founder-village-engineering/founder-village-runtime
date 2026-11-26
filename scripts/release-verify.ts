import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { localDockerContext } from "./local-release.ts";

const context = localDockerContext();
// Compose uses the selected context's local driver with empty Buildx settings.
// Inheriting a workstation's separately selected builder could dispatch a remote build.
const buildxConfig = await mkdtemp(join(tmpdir(), "fv-local-buildx-"));
process.once("exit", () =>
  rmSync(buildxConfig, { recursive: true, force: true }),
);
// Provider credentials and database URL overrides must never reach local fixtures.
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  DOCKER_CONTEXT: context,
  BUILDX_CONFIG: buildxConfig,
};
const local = ["--config", "config/local.json"];
const manifest = JSON.parse(await readFile(local[1]!, "utf8")) as {
  environment: string;
  project: string;
};
if (manifest.environment !== "local" || manifest.project !== "fv-local")
  throw new Error(
    "The expanded local suite requires the fv-local configuration.",
  );
const commands: [string, string[]][] = [
  ["npm", ["run", "security:scan"]],
  ["npm", ["run", "security:scan", "--", "--history"]],
  ["npm", ["run", "format:check"]],
  ["cargo", ["fmt", "--all", "--", "--check"]],
  [
    "cargo",
    [
      "clippy",
      "--locked",
      "--workspace",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  ],
  ["cargo", ["test", "--locked", "--workspace"]],
  ["cargo", ["audit"]],
  ["npm", ["run", "check"]],
  ["npm", ["run", "frontend-contracts:check"]],
  ["npm", ["audit", "--omit=dev", "--audit-level=high"]],
  ["node", ["scripts/check-image-platforms.ts"]],
  ["cargo", ["build", "--locked", "-p", "fv-cli"]],
  ["./target/debug/fv", [...local, "init"]],
  ["./target/debug/fv", [...local, "up"]],
  ["npm", ["run", "test:integration"]],
  ["npm", ["run", "test:browser"]],
  [
    "docker",
    [
      "--context",
      context,
      "buildx",
      "build",
      "--builder",
      context,
      "--load",
      "--file",
      "infra/images/app.Dockerfile",
      "--tag",
      "fv-runtime:local",
      ".",
    ],
  ],
  ["node", ["scripts/smoke-containers.ts"]],
  ["./target/debug/fv", [...local, "backup", "capture"]],
  ["./target/debug/fv", [...local, "backup", "restore-drill"]],
];
const evidence = [];
for (const [command, args] of commands) {
  const start = Date.now();
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: environment,
    timeout: 1800000,
  });
  evidence.push({
    command,
    args,
    status: result.status === 0 ? "passed" : "failed",
    milliseconds: Date.now() - start,
  });
  if (result.status !== 0) break;
}
const hash = createHash("sha256");
async function walk(dir: string): Promise<void> {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (
      [
        ".git",
        "node_modules",
        ".state",
        "target",
        "dist",
        "secrets",
        "test-results",
        "playwright-report",
      ].includes(entry.name)
    )
      continue;
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(p);
    else if (entry.isFile()) hash.update(p).update(await readFile(p));
  }
}
await walk(".");
await mkdir(".state/evidence", { recursive: true });
await writeFile(
  ".state/evidence/full-release.json",
  JSON.stringify(
    {
      sourceHash: hash.digest("hex"),
      recordedAt: new Date().toISOString(),
      checks: evidence,
      liveProviders: false,
    },
    null,
    2,
  ),
);
if (
  evidence.length !== commands.length ||
  evidence.some((r) => r.status !== "passed")
)
  process.exit(1);
