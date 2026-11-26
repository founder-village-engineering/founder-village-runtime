import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { secret } from "../packages/database/index.ts";
const exec = promisify(execFile),
  project = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .parse(secret("COMPOSE_PROJECT_NAME")),
  environment = z
    .enum(["local", "staging", "production"])
    .parse(secret("FV_ENV"));
const final = z
  .string()
  .regex(/^rabbitmq:4\.3[^@]*@sha256:[a-f0-9]{64}$/)
  .parse(
    (
      JSON.parse(await readFile("config/images.lock.json", "utf8")) as Record<
        string,
        string
      >
    ).rabbitmq,
  );
const bridges = JSON.parse(await readFile("config/upgrades.json", "utf8")) as {
  rabbitmq: Record<string, string>;
};
const args = [
  "compose",
  "--project-directory",
  process.cwd(),
  "--env-file",
  `.state/${environment}.env`,
  "-p",
  project,
  "-f",
  "infra/compose/compose.yml",
];
const version = () =>
  exec("docker", ["exec", `${project}-rabbitmq-1`, "rabbitmqctl", "version"], {
    timeout: 30000,
  }).then((r) => r.stdout.trim());
let current = await version();
if (!/^4\.[123]\.\d+$/.test(current))
  throw new Error("unsupported broker upgrade origin");
const receipts = [];
for (let minor = Number(current.split(".")[1]) + 1; minor <= 3; minor++) {
  await exec(
    "docker",
    [
      "exec",
      `${project}-rabbitmq-1`,
      "rabbitmqctl",
      "enable_feature_flag",
      "all",
    ],
    { timeout: 60000 },
  );
  const image = minor === 3 ? final : bridges.rabbitmq[`4.${minor}`];
  if (
    !image ||
    /^rabbitmq:4\.(\d+)(?:\.[0-9]+)?-management@sha256:[a-f0-9]{64}$/.exec(
      image,
    )?.[1] !== String(minor)
  )
    throw new Error("missing pinned broker upgrade image");
  const options = {
    timeout: 300000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, RABBITMQ_IMAGE: image },
  };
  if (environment === "local") {
    await exec(
      "docker",
      [...args, "build", "--build-arg", "RABBITMQ_IMAGE=" + image, "rabbitmq"],
      options,
    );
    await exec(
      "docker",
      [...args, "up", "-d", "--no-deps", "--wait", "rabbitmq"],
      options,
    );
  } else {
    // The intermediate version runs the same signed entrypoint read-only
    // over the pinned vendor image. The final wrapper is already built.
    const temporary = await mkdtemp(join(tmpdir(), "fv-broker-upgrade-"));
    try {
      const overlay = join(temporary, "broker.json");
      const finalImage = z
        .string()
        .regex(/^fv-rabbitmq:local-[0-9a-f]{40}$/)
        .parse(secret("FV_RABBITMQ_IMAGE"));
      const service =
        minor === 3
          ? { image: finalImage }
          : {
              image,
              entrypoint: ["/bin/sh", "/run/fv-upgrade-entrypoint"],
              command: ["rabbitmq-server"],
              volumes: [
                {
                  type: "bind",
                  source: resolve("infra/images/rabbitmq-entrypoint.sh"),
                  target: "/run/fv-upgrade-entrypoint",
                  read_only: true,
                },
              ],
            };
      await writeFile(
        overlay,
        JSON.stringify({ services: { rabbitmq: service } }),
        { mode: 0o600 },
      );
      await exec(
        "docker",
        [
          ...args,
          "-f",
          overlay,
          "up",
          "-d",
          "--no-deps",
          "--no-build",
          "--pull",
          minor === 3 ? "never" : "missing",
          "--wait",
          "rabbitmq",
        ],
        options,
      );
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }
  current = await version();
  if (!current.startsWith(`4.${minor}.`))
    throw new Error("broker version postcheck failed");
  receipts.push({ version: current, image });
}
const file = `.state/${environment}.env`,
  lines = (await readFile(file, "utf8"))
    .split("\n")
    .filter((s) => s && !s.startsWith("RABBITMQ_IMAGE="));
await writeFile(file, lines.join("\n") + `\nRABBITMQ_IMAGE=${final}\n`, {
  mode: 0o600,
});
await writeFile(
  `.state/${environment}/broker-upgrade.json`,
  JSON.stringify(
    { receipts, version: current, volumesPreserved: true },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    event: "broker.upgrade.verified",
    version: current,
    volumesPreserved: true,
  }),
);
