import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [action = "prepare", ...extra] = process.argv.slice(2);
if (extra.length || !["preflight", "init", "prepare", "apply"].includes(action)) {
  console.error(
    "Usage: npm run production:bootstrap -- preflight|init|prepare|apply",
  );
  process.exit(2);
}
const tools = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
};
function execute(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (
  !existsSync(root + "node_modules/tsx/package.json") ||
  !existsSync(root + "node_modules/cf/bin/cf")
)
  execute("npm", ["ci", "--no-audit", "--no-fund"], tools);
execute(
  process.execPath,
  ["--import", "tsx", "scripts/production-bootstrap.ts", action],
  process.env,
);
