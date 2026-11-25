import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { z } from "zod";
import path from "node:path";

const exec = promisify(execFile);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const options = z
  .object({
    host: z.string().min(1),
    knownHosts: z.string(),
    identityFile: z.string().optional(),
    initialRootPublicKey: z.string().optional(),
    source: z.string(),
    sourceBundle: z.string(),
    binary: z.string(),
    binaryBundle: z.string(),
    config: z.string(),
    manifest: z.string(),
    manifestBundle: z.string(),
  })
  .strict();
const release = z
  .object({
    version: z.literal(2),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    image: z.string(),
    sourceSha256: sha256,
    binaries: z.object({ amd64: sha256, arm64: sha256 }),
    files: z.array(z.object({ path: z.string(), sha256 })).min(1),
  })
  .strict();
const target = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  environment: z.enum(["staging", "production"]),
  cloudflare: z.object({ ssh_domain: z.string().nullish() }),
  provider: z.object({
    architecture: z.enum(["amd64", "arm64"]).default("amd64"),
    image: z.string(),
    existing_server: z.object({ ipv4: z.ipv4() }).optional(),
  }),
});

function digest(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sh(arg: string) {
  return "'" + arg.replaceAll("'", "'\\''") + "'";
}

async function privateFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error(
      "private bootstrap inputs require a mode-0600 regular file",
    );
  return readFile(file);
}

let step = "read private bootstrap configuration";
try {
  const args = options.parse(
    JSON.parse((await privateFile(process.argv[2] ?? "")).toString()),
  );
  const configFile = path.resolve(args.config);
  const config = await privateFile(configFile);
  const { environment, project, provider, cloudflare } = target.parse(
    JSON.parse(config.toString()),
  );
  const arch = provider.architecture;
  step = "validate the runtime manifest and SSH target";
  await exec("bin/fv", ["--config", configFile, "validate"], {
    timeout: 120_000,
  });
  const viaTunnel = isIP(args.host) === 0;
  if (viaTunnel && args.host !== cloudflare.ssh_domain)
    throw new Error("SSH hostname must match the configured tunnel");
  if (args.initialRootPublicKey && provider.existing_server?.ipv4 !== args.host)
    throw new Error(
      "initial root enrollment requires the bound existing server IPv4",
    );
  const knownHosts = path.resolve(args.knownHosts);
  if (/[\r\n\0%]/.test(knownHosts) || !(await lstat(knownHosts)).isFile())
    throw new Error("a dedicated known_hosts file is required");
  const sshOptions = [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile="${knownHosts.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    "-o",
    "GlobalKnownHostsFile=none",
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(viaTunnel
      ? ["-o", "ProxyCommand=cloudflared access ssh --hostname %h"]
      : []),
    ...(args.identityFile ? ["-i", path.resolve(args.identityFile)] : []),
  ];
  async function ssh(
    user: "fv" | "root",
    command: string,
    timeout: number,
    input?: Buffer,
  ) {
    const running = exec(
      "ssh",
      [...sshOptions, "-l", user, args.host, command],
      {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (input) {
      running.child.stdin?.on("error", () => {});
      running.child.stdin?.end(input);
    } else {
      running.child.stdin?.end();
    }
    return (await running).stdout.trim();
  }

  step = "verify the release workflow signatures and artifact bindings";
  const policy = z
    .object({
      issuer: z.string(),
      identityPattern: z.string(),
      registryPrefix: z.string(),
    })
    .parse(JSON.parse(await readFile("policies/release.json", "utf8")));
  const [source, binary, manifest] = await Promise.all([
    readFile(args.source),
    readFile(args.binary),
    readFile(args.manifest),
  ]);
  const metadata = release.parse(JSON.parse(manifest.toString()));
  if (
    !metadata.image.startsWith(policy.registryPrefix) ||
    !sha256.safeParse(metadata.image.slice(policy.registryPrefix.length))
      .success ||
    digest(source) !== metadata.sourceSha256 ||
    digest(binary) !== metadata.binaries[arch] ||
    binary.length < 64 ||
    binary.readUInt32BE(0) !== 0x7f454c46 ||
    binary[4] !== 2 ||
    binary[5] !== 1 ||
    binary.readUInt16LE(18) !== (arch === "arm64" ? 183 : 62)
  )
    throw new Error("release artifact or architecture mismatch");
  // Verify the same bytes that will be uploaded, even if the input files change.
  const verified = await mkdtemp(path.join(tmpdir(), "fv-release-verify-"));
  try {
    for (const [bytes, bundle] of [
      [manifest, args.manifestBundle],
      [source, args.sourceBundle],
      [binary, args.binaryBundle],
    ] as const) {
      const snapshot = path.join(verified, "artifact");
      await writeFile(snapshot, bytes, { mode: 0o600 });
      await exec(
        "cosign",
        [
          "verify-blob",
          "--bundle",
          path.resolve(bundle),
          "--certificate-identity-regexp",
          policy.identityPattern,
          "--certificate-oidc-issuer",
          policy.issuer,
          snapshot,
        ],
        { timeout: 120_000 },
      );
    }
  } finally {
    await rm(verified, { recursive: true, force: true });
  }

  const preflight = [
    "set -eu",
    ". /etc/os-release",
    `test "$ID" = ubuntu && test "ubuntu-$VERSION_ID" = ${sh(provider.image)}`,
    `test "$(dpkg --print-architecture)" = ${sh(arch)}`,
    `test "$(hostname -s)" = ${sh(project)}`,
    `if test -f /etc/fv-runtime-owner; then test "$(cat /etc/fv-runtime-owner)" = ${sh(project)}; fi`,
  ].join("\n");
  const elevated = (script: string) => `sudo -n /bin/bash -c ${sh(script)}`;
  step =
    "verify host identity, Ubuntu release, sudo access and native platform";
  try {
    await ssh("fv", elevated(preflight), 30_000);
  } catch (error) {
    if (!args.initialRootPublicKey) throw error;
    step = "enroll an Ed25519 operator on the existing VM";
    const keyFile = path.resolve(args.initialRootPublicKey);
    await exec("ssh-keygen", ["-lf", keyFile], { timeout: 5_000 });
    const key = (await readFile(keyFile, "utf8"))
      .trim()
      .match(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/)?.[0]
      .split(" ")
      .slice(0, 2)
      .join(" ");
    if (!key) throw new Error("Ed25519 public key required");
    const enroll = await readFile("infra/templates/enroll-operator.sh", "utf8");
    await ssh(
      "root",
      `/bin/bash -c ${sh(preflight + "\n" + enroll)} fv-enroll ${sh(key)}`,
      90_000,
    );
    step = "confirm a new operator SSH session before disabling root SSH";
    await ssh("fv", elevated(preflight), 30_000);
  }

  const inputs = {
    "source.tar": source,
    fv: binary,
    "runtime.json": config,
    "source-manifest.json": manifest,
  };
  step = "create protected temporary upload storage";
  const temporary = await ssh(
    "fv",
    elevated("umask 077; mktemp -d /opt/.fv-bootstrap.XXXXXXXXXX"),
    30_000,
  );
  if (!/^\/opt\/\.fv-bootstrap\.[a-zA-Z0-9]{10}$/.test(temporary))
    throw new Error("unexpected temporary path");
  try {
    for (const [name, content] of Object.entries(inputs)) {
      step = `upload verified ${name}`;
      await ssh(
        "fv",
        elevated(`umask 077; cat > ${temporary}/${name}`),
        120_000,
        content,
      );
    }
    step = "verify uploaded bytes and install the signed runtime";
    const checks = Object.entries(inputs)
      .map(([name, bytes]) => `${digest(bytes)}  ${name}`)
      .join("\n");
    const install = await readFile("infra/templates/install-release.sh");
    await ssh(
      "fv",
      elevated(
        `set -eu; cd ${temporary}; printf '%s\\n' ${sh(checks)} | sha256sum --check --status; exec /bin/bash -s -- ${environment} ${sh(project)}`,
      ),
      180_000,
      install,
    );
    step = "converge the owned host";
    await ssh(
      "fv",
      "sudo -n /opt/founder-village/bin/fv --config config/" +
        environment +
        ".private.json host apply",
      1_200_000,
    );
  } finally {
    await ssh("fv", elevated(`rm -rf -- ${temporary}`), 30_000).catch(() => {
      console.error(
        "Host cleanup failed. Remove the protected bootstrap staging directory through the operator session.",
      );
    });
  }
  console.log(
    `Installed verified Linux ${arch} runtime ${metadata.revision}. Install the private secret catalog before starting services.`,
  );
} catch {
  console.error(`Remote bootstrap failed while attempting to ${step}.`);
  process.exitCode = 1;
}
