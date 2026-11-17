import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { pathToFileURL } from "node:url";
export function scopedServiceEnvironments(vars: Record<string, string>) {
  const shared = ["FV_ENV"];
  const domain = [
    ...shared,
    "RUNNER_DATABASE_URL",
    "ROOT_ADMIN_ACTORS",
    "OIDC_ISSUER",
    "OIDC_AUDIENCE",
    "OIDC_CLIENT_ID",
    "OIDC_JWKS_URL",
    "CF_BINARY",
    "CF_SHA256",
    "CF_ACCOUNT_ID",
    "CF_ZONE_ID",
    "CF_ZONE_NAME",
    "CF_MANAGED_NAMES",
    "CF_READ_TOKEN",
    "CF_WRITE_TOKEN",
    "AUDIT_HMAC_KEY",
    "AUDIT_REGION",
    "AUDIT_ENDPOINT",
    "AUDIT_ACCESS_KEY",
    "AUDIT_SECRET_KEY",
    "AUDIT_BUCKET",
    ...Object.keys(vars).filter((k) => /^WORKER_.+_DATABASE_URL$/.test(k)),
  ];
  const monitor = [
    ...shared,
    "MONITOR_CONTROL_DATABASE_URL",
    "MONITOR_TOKEN",
    "ALERT_WEBHOOK_URL",
    ...Object.keys(vars).filter((k) => /^MONITOR_.+_DATABASE_URL$/.test(k)),
  ];
  return Object.fromEntries(
    (
      [
        ["domain", domain],
        ["monitor", monitor],
      ] as const
    ).map(([name, keys]) => [
      name,
      keys
        .filter((k) => vars[k])
        .map((k) => `${k}=${vars[k]}\n`)
        .join("") +
        (name === "domain" ? "CF_WORK_DIR=/var/lib/fv-domain\n" : ""),
    ]),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const environment = z
    .enum(["local", "staging", "production"])
    .parse(process.argv[2]);
  const rows = (await readFile(`.state/${environment}.env`, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("=");
      if (i < 1) throw new Error("invalid environment");
      return [line.slice(0, i), line.slice(i + 1)] as const;
    });
  const vars = Object.fromEntries(rows);
  if (vars.FV_ENV !== environment)
    throw new Error("service environment mismatch");
  await mkdir("/etc/fv", { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(scopedServiceEnvironments(vars))) {
    await writeFile(`/etc/fv/${name}.env`, text, { mode: 0o600 });
  }
  console.log("scoped service environments materialized");
}
