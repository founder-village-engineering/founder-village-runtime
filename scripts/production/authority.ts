import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { accountPin, apexZones, cloudApi } from "./discovery.ts";
import {
  BootstrapError,
  exists,
  json,
  privateDirectory,
  publish,
  run,
} from "./workstation.ts";

const cfId = z.string().regex(/^[a-f0-9]{32}$/);
const planSchema = z.object({
  resource_changes: z
    .array(z.object({ change: z.object({ actions: z.array(z.string()) }) }))
    .optional(),
});
export function checkGrantPlan(input: unknown) {
  const plan = planSchema.parse(input);
  if (
    plan.resource_changes?.some((r) =>
      r.change.actions.some(
        (a) => !["read", "create", "update", "no-op"].includes(a),
      ),
    )
  )
    throw new BootstrapError(
      "Credential issuance would remove or replace a provider resource.",
    );
}

// A delegated Founder Village account identity issues only Cloudflare credentials.
export async function issueGrants(
  root: string,
  home: string,
  work: string,
  apply: boolean,
  cloudIssuer: string,
) {
  const cf = cloudApi(cloudIssuer),
    expected = await accountPin(root);
  const zones = await Promise.all(
    apexZones.map(async (name) => {
      const [zone] = z
        .tuple([
          z.object({
            name: z.literal(name),
            id: cfId,
            account: z.object({ id: cfId }),
            status: z.literal("active"),
          }),
        ])
        .parse(await cf("zones?name=" + name + "&status=active&per_page=2"));
      return zone;
    }),
  );
  const account = zones[0]!.account.id;
  if (
    (expected && expected !== account) ||
    zones.some((z) => z.account.id !== account)
  )
    throw new BootstrapError(
      "Both production zones must belong to the authorized account before issuing grants.",
    );
  const permissions = z
    .array(
      z.object({
        id: cfId,
        name: z.string(),
        scopes: z.array(z.string()),
        is_selectable: z.boolean().optional(),
      }),
    )
    .min(1)
    .parse(await cf("accounts/" + account + "/tokens/permission_groups"))
    .filter((group) => group.is_selectable !== false);
  const vars = {
    account_id: account,
    permission_groups: permissions,
    zone_ids: Object.fromEntries(zones.map((zone) => [zone.name, zone.id])),
  };
  const stateDir = join(home, "cloudflare-authority"),
    dir = join(work, "terraform");
  await privateDirectory(stateDir);
  await publish(
    join(stateDir, "custody.json"),
    json({ account }),
  );
  const state = join(stateDir, "production.tfstate");
  if (!apply && !(await exists(state)))
    throw new BootstrapError(
      "The provider grants have not been issued yet. The apply action creates them from the runner's delegated identities.",
    );
  await privateDirectory(dir);
  for (const file of [
    "main.tf",
    "cloudflare.tf",
    ".terraform.lock.hcl",
  ])
    await copyFile(
      join(root, "infra/production-authority", file),
      join(dir, file),
    );
  const env = {
    CLOUDFLARE_API_TOKEN: cloudIssuer,
    TF_IN_AUTOMATION: "1",
    TF_INPUT: "0",
    TF_CLI_CONFIG_FILE: "/dev/null",
    TF_DATA_DIR: join(stateDir, "providers"),
  };
  const tf = (args: string[]) =>
    run("terraform", ["-chdir=" + dir, ...args], env, undefined, 900_000);
  try {
    await tf([
      "init",
      "-input=false",
      "-lockfile=readonly",
      "-reconfigure",
      "-backend-config=path=" + state,
    ]);
    if (apply) {
      const variables = join(dir, "authority.tfvars.json"),
        plan = join(dir, "authority.plan");
      await publish(variables, json(vars));
      await tf([
        "plan",
        "-input=false",
        "-lock-timeout=30s",
        "-var-file=" + variables,
        "-out=" + plan,
      ]);
      checkGrantPlan(JSON.parse(await tf(["show", "-json", plan])));
      await tf(["apply", "-input=false", plan]);
    }
    return z
      .record(z.string(), z.string().min(1))
      .parse(JSON.parse(await tf(["output", "-json", "bindings"])));
  } finally {
    // Plans and provider credentials never join a published configuration generation.
    await rm(dir, { force: true, recursive: true });
  }
}
