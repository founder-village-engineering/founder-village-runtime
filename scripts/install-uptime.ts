import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const plan = process.argv.length === 3 && process.argv[2] === "--plan";
if ((!plan && process.argv.length !== 2) || process.platform !== "darwin")
  throw new Error(
    "Use npm run uptime:install on the operator Mac, optionally with --plan.",
  );
const endpoint = process.env.PUBLIC_API_URL ?? "";
if (!URL.canParse(endpoint))
  throw new Error("Supply a public HTTPS origin in PUBLIC_API_URL.");
const url = new URL(endpoint);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.port ||
  url.href !== url.origin + "/"
)
  throw new Error("Supply a public HTTPS origin in PUBLIC_API_URL.");
const label = "org.foundervillage.runtime-uptime";
const domain = "gui/" + process.getuid!();
const probe = fileURLToPath(new URL("./probe.ts", import.meta.url));
const directory = join(homedir(), "Library", "LaunchAgents");
const target = join(directory, label + ".plist");
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const config = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(probe)}</string></array>
<key>EnvironmentVariables</key><dict><key>PUBLIC_API_URL</key><string>${xml(url.origin)}</string></dict>
<key>StartInterval</key><integer>600</integer><key>RunAtLoad</key><true/>
</dict></plist>
`;
execFileSync("/usr/bin/plutil", ["-lint", "-"], {
  input: config,
  stdio: ["pipe", "ignore", "inherit"],
});
if (plan) {
  console.log(
    "Workstation uptime probe configuration is valid. Interval 600 seconds.",
  );
} else {
  execFileSync(process.execPath, [probe], {
    env: { PUBLIC_API_URL: url.origin },
    stdio: "inherit",
    timeout: 35000,
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await readFile(target, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  const job = domain + "/" + label;
  const loaded = () =>
    spawnSync("/bin/launchctl", ["print", job], { stdio: "ignore" }).status ===
    0;
  async function replaceConfig(contents: string) {
    const temp = target + "." + randomUUID() + ".next";
    try {
      await writeFile(temp, contents, { mode: 0o600, flag: "wx" });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
  const wasLoaded = loaded();
  try {
    if (existing !== config) {
      await replaceConfig(config);
      if (wasLoaded) execFileSync("/bin/launchctl", ["bootout", job]);
    }
    if (!loaded())
      execFileSync("/bin/launchctl", ["bootstrap", domain, target]);
    if (!loaded()) throw new Error("Workstation uptime probe did not load.");
  } catch (error) {
    if (existing !== config) {
      if (existing === undefined) await rm(target, { force: true });
      else await replaceConfig(existing);
      if (wasLoaded && existing !== undefined && !loaded())
        execFileSync("/bin/launchctl", ["bootstrap", domain, target]);
    }
    throw error;
  }
  console.log(
    "Workstation uptime probe active. Inspect the last exit with launchctl print " +
      job +
      ".",
  );
}
