import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { openProductionVault } from "./vaultwarden.ts";
import {
  BootstrapError,
  exists,
  privateText,
  projectedCredential,
  publish,
  run,
  runQuiet,
  stage,
} from "./workstation.ts";

const tokenName = "FV_HCLOUD_TOKEN";
const candidateName = "FV_HETZNER_CANDIDATE";
const root = fileURLToPath(new URL("../../", import.meta.url));

async function auditCandidate(candidate: string, token: string) {
  await runQuiet(
    "cargo",
    ["build", "--release", "--locked", "--quiet", "-p", "fv-cli"],
    {},
    7200_000,
  );
  const work = await mkdtemp(join(tmpdir(), "fv-hetzner-enrollment-"));
  try {
    const file = join(work, "candidate.private.json");
    await publish(file, candidate);
    const result = await run(
      join(root, "target/release/fv"),
      ["--config", file, "candidate-audit"],
      {
        [tokenName]: token,
      },
    );
    z.object({
      project_isolated: z.literal(true),
      binding: z.literal("server-id-and-address"),
    }).parse(JSON.parse(result));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

type Vault = NonNullable<Awaited<ReturnType<typeof openProductionVault>>>;

export async function enrollHetzner(
  token: string,
  vault: Pick<Vault, "read" | "merge">,
  candidateFile = join(root, "config/candidate.private.json"),
  audit = auditCandidate,
) {
  const { values } = await vault.read();
  for (const existing of [
    values.get(tokenName),
    await projectedCredential(tokenName),
  ]) {
    if (existing !== undefined && existing !== token)
      throw new BootstrapError(
        "The supplied token conflicts with an enrolled Hetzner credential.",
      );
  }
  const pins = [
    values.get(candidateName),
    await projectedCredential(candidateName),
    (await exists(candidateFile))
      ? await privateText(candidateFile)
      : undefined,
  ].filter((value) => value !== undefined);
  if (!pins.length)
    throw new BootstrapError(
      "A pinned production Hetzner candidate is required.",
    );
  const [pin, ...others] = pins.map((value) => JSON.parse(value));
  if (
    pin?.environment !== "production" ||
    others.some((other) => !isDeepStrictEqual(pin, other))
  )
    throw new BootstrapError(
      "The production Hetzner candidate pins are invalid or disagree.",
    );
  await stage(
    "The Hetzner project token did not pass the pinned candidate audit.",
    () => audit(JSON.stringify(pin), token),
  );
  await vault.merge(new Map([[tokenName, token]]));
}

async function main() {
  if (process.argv.length !== 2 || process.stdin.isTTY)
    throw new BootstrapError("Supply the Hetzner token on private stdin.");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
    if (input.length > 2050)
      throw new BootstrapError("Invalid Hetzner token input.");
  }
  const token = input.replace(/\r?\n$/, "");
  if (!/^[!-~]{1,2048}$/.test(token))
    throw new BootstrapError(
      "Supply exactly one Hetzner token on private stdin.",
    );
  process.chdir(root);
  const vault = (await openProductionVault(true))!;
  await enrollHetzner(token, vault);
  console.log(
    "Verified the pinned Hetzner project and enrolled FV_HCLOUD_TOKEN in Vaultwarden.",
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main().catch((error) => {
    console.error(
      error instanceof BootstrapError
        ? error.message
        : "Hetzner enrollment failed a private input check.",
    );
    process.exitCode = 1;
  });
