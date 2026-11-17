import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const commands: [string, string[]][] = [
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
  ["npm", ["run", "check"]],
  ["npm", ["run", "security:scan"]],
  ["npm", ["audit", "--omit=dev", "--audit-level=high"]],
  ["npm", ["run", "test:integration"]],
  ["npm", ["run", "test:browser"]],
  ["bin/fv", ["backup", "capture"]],
  ["bin/fv", ["backup", "restore-drill"]],
];
const evidence = [];
for (const [command, args] of commands) {
  const start = Date.now();
  const result = spawnSync(command, args, {
    stdio: "inherit",
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
