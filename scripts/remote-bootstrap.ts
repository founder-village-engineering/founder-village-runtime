import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pinnedSshOptions } from "./production/ssh.ts";
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
    initialRootIdentityFile: z.string().optional(),
    allowedSigners: z.string(),
    releaseDirectory: z.string(),
    config: z.string(),
  })
  .strict();
const release = z.object({
  version: z.literal(3),
  distribution: z.literal("workstation"),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  architecture: z.enum(["amd64", "arm64"]),
  sourceSha256: sha256,
  binarySha256: sha256,
  imageArchiveSha256: sha256,
  sbomSha256: sha256,
  runtimeArchiveSha256: sha256,
});
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
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
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
  const sshOptions = await pinnedSshOptions(
    args,
    provider.existing_server?.ipv4,
    cloudflare.ssh_domain,
  );
  async function ssh(
    user: "fv" | "root",
    command: string,
    timeout: number,
    input?: Buffer | Readable,
  ) {
    const identity =
      user === "root"
        ? (args.initialRootIdentityFile ?? args.identityFile)
        : args.identityFile;
    const running = exec(
      "ssh",
      [
        ...sshOptions,
        ...(identity ? ["-i", path.resolve(identity)] : []),
        "-l",
        user,
        args.host,
        command,
      ],
      {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    if (input instanceof Readable && running.child.stdin) {
      const result = await Promise.all([
        running,
        pipeline(input, running.child.stdin),
      ]);
      return result[0].stdout.trim();
    } else if (input instanceof Buffer) {
      running.child.stdin?.on("error", () => {});
      running.child.stdin?.end(input);
    } else {
      running.child.stdin?.end();
    }
    return (await running).stdout.trim();
  }

  step = "verify the independently pinned workstation signature and platform";
  const directory = await realpath(args.releaseDirectory);
  const signersPath = await realpath(args.allowedSigners);
  if (signersPath.startsWith(directory + path.sep) || signersPath === directory)
    throw new Error(
      "release trust must be provisioned outside the artifact directory",
    );
  const signerStat = await lstat(args.allowedSigners);
  if (
    !signerStat.isFile() ||
    signerStat.uid !== process.getuid?.() ||
    (signerStat.mode & 0o022) !== 0
  )
    throw new Error("the release trust file must be owner controlled");
  const signers = await readFile(signersPath);
  if (
    !/^founder-village-release namespaces="fv-release-v3" ssh-ed25519 [A-Za-z0-9+/]+={0,2}\n?$/.test(
      signers.toString("utf8"),
    )
  )
    throw new Error("pin exactly one Founder release Ed25519 signer");
  async function artifact(name: string, limit?: number) {
    const file = path.join(directory, name);
    const st = await lstat(file);
    if (!st.isFile() || (limit !== undefined && st.size > limit))
      throw new Error("invalid release artifact");
    return { file, size: st.size };
  }
  const manifest = await readFile(
    (await artifact("source-manifest.json", 32 * 1024 * 1024)).file,
  );
  const signature = await readFile(
    (await artifact("source-manifest.json.sig", 16 * 1024)).file,
  );
  const proof = await mkdtemp(path.join(tmpdir(), "fv-release-verify-"));
  try {
    await writeFile(path.join(proof, "signers"), signers, { mode: 0o600 });
    await writeFile(path.join(proof, "signature"), signature, { mode: 0o600 });
    const verification = exec(
      "ssh-keygen",
      [
        "-Y",
        "verify",
        "-f",
        path.join(proof, "signers"),
        "-I",
        "founder-village-release",
        "-n",
        "fv-release-v3",
        "-s",
        path.join(proof, "signature"),
      ],
      { timeout: 10_000 },
    );
    verification.child.stdin?.on("error", () => {});
    verification.child.stdin?.end(manifest);
    await verification;
  } finally {
    await rm(proof, { force: true, recursive: true });
  }
  const metadata = release.parse(JSON.parse(manifest.toString()));
  if (metadata.architecture !== arch) throw new Error("wrong release platform");
  const bytes = new Map<string, Buffer>([
    ["runtime.json", config],
    ["source-manifest.json", manifest],
    ["source-manifest.json.sig", signature],
    ["signers", signers],
  ]);
  const paths = new Map<string, string>();
  const hashes = new Map<string, string>(
    Array.from(bytes, ([k, v]) => [k, digest(v)]),
  );
  let upload = 0;
  let unpacked = 0;
  for (const [name, want] of [
    ["source.tar", metadata.sourceSha256],
    ["fv", metadata.binarySha256],
    ["runtime.tar", metadata.runtimeArchiveSha256],
    ["sbom.cdx.json", metadata.sbomSha256],
    ["image.tar", metadata.imageArchiveSha256],
  ] as const) {
    const { file, size } = await artifact(name);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== want)
      throw new Error("artifact checksum mismatch");
    if (name === "fv") {
      const header = (await readFile(file)).subarray(0, 64);
      if (
        header.length < 64 ||
        header.readUInt32BE(0) !== 0x7f454c46 ||
        header[4] !== 2 ||
        header[5] !== 1 ||
        header.readUInt16LE(18) !== (arch === "arm64" ? 183 : 62)
      )
        throw new Error("wrong native binary platform");
    }
    hashes.set(name, want);
    paths.set(name, file);
    upload += size;
    // Source and runtime expand once locally; image storage may grow by the
    // uncompressed archive size when Docker loads the protected candidate.
    unpacked += size;
  }
  const requiredKiB = Math.ceil((upload + unpacked) / 1024) + 2 * 1024 * 1024;
  const preflight = [
    "set -eu",
    ". /etc/os-release",
    "command -v ssh-keygen >/dev/null",
    `test "$(df -Pk /opt | awk 'NR==2{print $4}')" -ge ${requiredKiB}`,
    `if test -e /etc/fv/release.allowed_signers || test -L /etc/fv/release.allowed_signers; then test ! -L /etc/fv/release.allowed_signers; test "$(stat -c %u /etc/fv/release.allowed_signers)" = 0; echo "${digest(signers)}  /etc/fv/release.allowed_signers" | sha256sum --check --status; fi`,
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

  step = "create protected temporary upload storage";
  const temporary = await ssh(
    "fv",
    elevated("umask 077; mktemp -d /opt/.fv-bootstrap.XXXXXXXXXX"),
    30_000,
  );
  if (!/^\/opt\/\.fv-bootstrap\.[a-zA-Z0-9]{10}$/.test(temporary))
    throw new Error("unexpected temporary path");
  try {
    for (const name of hashes.keys()) {
      step = `upload verified ${name}`;
      await ssh(
        "fv",
        elevated(`umask 077; cat > ${temporary}/${name}`),
        1_800_000,
        bytes.get(name) ?? createReadStream(paths.get(name)!),
      );
    }
    step = "verify the transfer and install the signed runtime";
    const checks = Array.from(
      hashes,
      ([name, hash]) => `${hash}  ${name}`,
    ).join("\n");
    const install = await readFile("infra/templates/install-release.sh");
    await ssh(
      "fv",
      elevated(
        `set -eu; cd ${temporary}; printf '%s\\n' ${sh(checks)} | sha256sum --check --status; exec /bin/bash -s -- ${environment} ${sh(project)} ${arch} ${metadata.revision}`,
      ),
      1_800_000,
      install,
    );
    step = "prepare offline images or converge a fresh owned host";
    const root = "/opt/founder-village",
      targetConfig = `config/${environment}.private.json`;
    await ssh(
      "fv",
      elevated(
        `set -eu; cd ${root}; if test -f .state/${environment}/current-release; then .fv-releases/${metadata.revision}/target/release/fv --config ${targetConfig} release stage --revision ${metadata.revision}; else bin/fv --config ${targetConfig} host apply; fi`,
      ),
      1_800_000,
    );
  } finally {
    await ssh("fv", elevated(`rm -rf -- ${temporary}`), 30_000).catch(() => {
      console.error(
        "Host cleanup failed. Remove the protected bootstrap staging directory through the operator session.",
      );
    });
  }
  console.log(
    `Verified Linux ${arch} runtime ${metadata.revision} available for protected promotion.`,
  );
} catch {
  console.error(`Remote bootstrap failed while attempting to ${step}.`);
  process.exitCode = 1;
}
