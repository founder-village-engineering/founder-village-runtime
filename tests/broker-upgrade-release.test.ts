import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
const exec = promisify(execFile);
test("a hosted 4.1 broker advances one pinned minor at a time without a server build", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fv-broker-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["bin", "config", ".state/staging"])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "version"), "4.1.2\n");
  await writeFile(join(root, ".state/staging.env"), "FV_ENV=staging\n");
  const middle = "rabbitmq:4.2.9-management@sha256:" + "a".repeat(64),
    final = "rabbitmq:4.3-management@sha256:" + "b".repeat(64);
  await writeFile(
    join(root, "config/images.lock.json"),
    JSON.stringify({ rabbitmq: final }),
  );
  await writeFile(
    join(root, "config/upgrades.json"),
    JSON.stringify({ rabbitmq: { "4.2": middle } }),
  );
  await writeFile(
    join(root, "bin/docker"),
    [
      "#!/bin/sh",
      "set -eu",
      'printf "%s\\n" "$*" >> calls',
      'case "$*" in',
      "*'rabbitmqctl version') cat version;;",
      "*'enable_feature_flag all') :;;",
      '*\'--no-build --pull missing --wait rabbitmq\') echo 4.2.9 > version; for arg do case "$arg" in */broker.json) cat "$arg" > bridge-used.json;; esac; done;;',
      '*\'--no-build --pull never --wait rabbitmq\') echo 4.3.0 > version; for arg do case "$arg" in */broker.json) cat "$arg" > final-used.json;; esac; done;;',
      "*) exit 1;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const target = "fv-rabbitmq:local-" + "c".repeat(40);
  await exec(
    process.execPath,
    [fileURLToPath(new URL("../scripts/broker-upgrade.ts", import.meta.url))],
    {
      cwd: root,
      env: {
        FV_ENV: "staging",
        COMPOSE_PROJECT_NAME: "fixture",
        FV_RABBITMQ_IMAGE: target,
        PATH: join(root, "bin") + ":" + process.env.PATH,
      },
    },
  );
  const bridge = JSON.parse(
    await readFile(join(root, "bridge-used.json"), "utf8"),
  ).services.rabbitmq;
  assert.equal(bridge.image, middle);
  assert.equal(bridge.volumes[0].read_only, true);
  assert.ok(
    bridge.volumes[0].source.endsWith("/infra/images/rabbitmq-entrypoint.sh"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "final-used.json"), "utf8")).services
      .rabbitmq,
    { image: target },
  );
  assert.equal(
    JSON.parse(
      await readFile(join(root, ".state/staging/broker-upgrade.json"), "utf8"),
    ).version,
    "4.3.0",
  );
});
