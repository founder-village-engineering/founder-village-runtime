import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BootstrapError,
  exists,
  privateText,
  workstationDirectory,
} from "./production/workstation.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const label = "org.foundervillage.runtime-backup";
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
async function install() {
  const args = process.argv.slice(2);
  if (
    process.platform !== "darwin" ||
    args.length > 1 ||
    (args.length && args[0] !== "--plan")
  )
    throw new BootstrapError(
      "Use workstation-backup-install.ts [--plan] on the release Mac.",
    );
  process.umask(0o077);
  const plan = args[0] === "--plan";
  const productionHome =
    process.env.FV_PRODUCTION_HOME ??
    join(homedir(), ".local/share/founder-village/production");
  const overrides = [
    "FV_BACKUP_AGE_IDENTITY_FILE",
    "FV_VAULTWARDEN_BINDING_FILE",
    "CREDENTIALS_DIRECTORY",
  ].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]!] as const] : [],
  );

  const paths = [
    ...new Set(
      (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(isAbsolute),
    ),
  ].join(":");
  if (
    !isAbsolute(productionHome) ||
    overrides.some(([, value]) => !isAbsolute(value))
  )
    throw new BootstrapError(
      "Use absolute paths for the backup workstation and credential files.",
    );
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--import</string><string>tsx</string><string>${xml(join(repo, "scripts/workstation-backup.ts"))}</string><string>pull</string></array>
<key>WorkingDirectory</key><string>${xml(repo)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(paths)}</string><key>FV_PRODUCTION_HOME</key><string>${xml(productionHome)}</string>${overrides.map(([name, value]) => "<key>" + name + "</key><string>" + xml(value) + "</string>").join("")}</dict>
<key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
  execFileSync("/usr/bin/plutil", ["-lint", "-"], {
    input: plist,
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (plan) {
    console.log(
      "Verified hourly workstation backup LaunchAgent configuration.",
    );
    return;
  }
  const home = await workstationDirectory(repo);
  const config = JSON.parse(
    await privateText(join(home, "current", "production.private.json")),
  );
  if (
    config?.environment !== "production" ||
    config?.backup?.mode !== "workstation"
  )
    throw new BootstrapError(
      "The production generation must select workstation backups.",
    );
  const directory = join(homedir(), "Library/LaunchAgents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const permissions = await lstat(directory);
  if (
    !permissions.isDirectory() ||
    permissions.uid !== process.getuid!() ||
    permissions.mode & 0o022
  )
    throw new BootstrapError(
      "LaunchAgents must be an operator-controlled directory.",
    );
  const target = join(directory, label + ".plist");
  const existing = (await exists(target))
    ? await privateText(target)
    : undefined;
  const domain = "gui/" + process.getuid!(),
    job = domain + "/" + label;
  const launch = (...argv: string[]) =>
    execFileSync("/bin/launchctl", argv, { stdio: "ignore" });
  const loaded = () =>
    spawnSync("/bin/launchctl", ["print", job], { stdio: "ignore" }).status ===
    0;
  const replace = async (value: string) => {
    const temp = target + "." + randomUUID() + ".next";
    try {
      await writeFile(temp, value, { flag: "wx", mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  };
  const wasLoaded = loaded();
  try {
    if (existing !== plist) {
      await replace(plist);
      if (wasLoaded) launch("bootout", job);
    }
    if (!loaded()) launch("bootstrap", domain, target);
    if (!loaded()) throw new Error("unloaded");
  } catch (e) {
    if (existing !== plist) {
      if (existing === undefined) await rm(target, { force: true });
      else await replace(existing);
      if (wasLoaded && existing !== undefined && !loaded())
        launch("bootstrap", domain, target);
    }
    throw e;
  }
  console.log("Hourly Founder Village workstation backup LaunchAgent loaded.");
}
await install().catch((error) => {
  console.error(
    error instanceof BootstrapError
      ? error.message
      : "Workstation backup schedule installation failed.",
  );
  process.exitCode = 1;
});
