import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

type Ruleset = {
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string }[];
};

const policy = JSON.parse(
  readFileSync(
    new URL("../policies/github-release.json", import.meta.url),
    "utf8",
  ),
) as { repository: string; rulesets: Ruleset[] };

function github(args: string[], body?: Ruleset): unknown {
  const result = spawnSync("gh", ["api", "--hostname", "github.com", ...args], {
    input: body && JSON.stringify(body),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0)
    throw new Error("GitHub release rules request failed");
  return JSON.parse(result.stdout);
}

function matches(current: Ruleset, expected: Ruleset): boolean {
  return (
    current.name === expected.name &&
    current.target === expected.target &&
    current.enforcement === expected.enforcement &&
    isDeepStrictEqual(current.bypass_actors, expected.bypass_actors) &&
    isDeepStrictEqual(current.conditions, expected.conditions) &&
    isDeepStrictEqual(
      current.rules.map((rule) => rule.type).sort(),
      expected.rules.map((rule) => rule.type).sort(),
    )
  );
}

function reconcile(apply: boolean) {
  const endpoint = `repos/${policy.repository}/rulesets`;
  const list = github([
    `${endpoint}?includes_parents=false&per_page=100`,
    "--paginate",
    "--slurp",
  ]) as { id: number; name: string }[][];
  const rulesets = list.flat();
  const missing = policy.rulesets.filter((expected) => {
    const existing = rulesets.filter(({ name }) => name === expected.name);
    if (!existing.length) return true;
    if (
      existing.length !== 1 ||
      !matches(github([`${endpoint}/${existing[0]!.id}`]) as Ruleset, expected)
    )
      throw new Error(
        `release ruleset drift requires review: ${expected.name}`,
      );
    return false;
  });
  if (missing.length && !apply)
    throw new Error(
      `missing release rules: ${missing.map((rule) => rule.name).join(", ")}`,
    );
  for (const rule of missing) {
    github(["--method", "POST", endpoint, "--input", "-"], rule);
  }
  if (missing.length) reconcile(false);
}

try {
  const action = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !["plan", "verify", "apply"].includes(action ?? "")
  )
    throw new Error("usage: release:rules -- plan | verify | apply");
  if (action === "plan") {
    console.log(JSON.stringify(policy, null, 2));
  } else {
    reconcile(action === "apply");
    console.log("Verified GitHub release branch and tag protections.");
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "release rules failed",
  );
  process.exitCode = 1;
}
