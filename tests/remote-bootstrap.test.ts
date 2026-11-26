import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const entry = fileURLToPath(
  new URL("../scripts/remote-bootstrap.ts", import.meta.url),
);
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("bootstrap authenticates independent signer and console pins before sending only verified runtime artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fv-ssh-bootstrap-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const dir of ["bin", "bundle", "received", "infra/templates"])
    await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "bin/fv"), '#!/bin/sh\n[ "$3" = validate ]\n', {
    mode: 0o700,
  });
  await writeFile(
    join(root, "infra/templates/install-release.sh"),
    "fixture installer\n",
  );
  // This stub records transfers locally. No network connection is possible.
  await writeFile(
    join(root, "bin/ssh"),
    [
      "#!/bin/sh",
      "set -eu",
      "for arg do command=$arg; done",
      'printf "%s\\n" "$*" >> "$SYNTHETIC_ROOT/calls"',
      'case "$command" in',
      "*mktemp*) echo /opt/.fv-bootstrap.ABCDEFGHIJ;;",
      "*'cat > /opt/.fv-bootstrap.'*) name=$(printf '%s' \"$command\" | sed -E 's@.*ABCDEFGHIJ/([A-Za-z0-9.-]+).*@\\1@'); cat > \"$SYNTHETIC_ROOT/received/$name\";;",
      "*) cat >/dev/null;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const key = join(root, "operator"),
    signers = join(root, "signers"),
    kh = join(root, "known_hosts");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = (await readFile(key + ".pub", "utf8"))
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const host = "192.0.2.9";
  await writeFile(
    signers,
    'founder-village-release namespaces="fv-release-v3" ' + publicKey + "\n",
    { mode: 0o600 },
  );
  await writeFile(kh, host + " " + publicKey + "\n", { mode: 0o600 });
  const project = join(root, "project.json");
  await writeFile(
    project,
    JSON.stringify({
      project: "fv-fixture",
      environment: "staging",
      cloudflare: { ssh_domain: "ssh.example.test" },
      provider: {
        architecture: "amd64",
        image: "ubuntu-24.04",
        existing_server: { ipv4: host },
      },
    }),
    { mode: 0o600 },
  );
  const bundle = join(root, "bundle"),
    manifest = join(bundle, "source-manifest.json");
  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(62, 18);
  const artifacts: Record<string, Buffer> = {
    fv: elf,
    "source.tar": Buffer.from("source"),
    "runtime.tar": Buffer.from("runtime"),
    "image.tar": Buffer.from("images"),
    "sbom.cdx.json": Buffer.from("sbom"),
  };
  for (const [name, data] of Object.entries(artifacts))
    await writeFile(join(bundle, name), data);
  await writeFile(join(bundle, "build-source.tar"), "workstation-only");
  const release = {
    version: 3,
    distribution: "workstation",
    architecture: "amd64",
    revision: "a".repeat(40),
    sourceSha256: hash(artifacts["source.tar"]!),
    binarySha256: hash(elf),
    imageArchiveSha256: hash(artifacts["image.tar"]!),
    runtimeArchiveSha256: hash(artifacts["runtime.tar"]!),
    sbomSha256: hash(artifacts["sbom.cdx.json"]!),
  };
  await writeFile(manifest, JSON.stringify(release));
  await run("ssh-keygen", [
    "-Y",
    "sign",
    "-f",
    key,
    "-n",
    "fv-release-v3",
    manifest,
  ]);
  const options = {
    host,
    knownHosts: kh,
    config: project,
    allowedSigners: signers,
    releaseDirectory: bundle,
  };
  const config = join(root, "bootstrap.json");
  async function invoke(overrides: Partial<typeof options> = {}) {
    await writeFile(config, JSON.stringify({ ...options, ...overrides }), {
      mode: 0o600,
    });
    return run(process.execPath, [entry, config], {
      cwd: root,
      env: {
        PATH: join(root, "bin") + ":" + process.env.PATH,
        SYNTHETIC_ROOT: root,
      },
    });
  }
  await invoke();
  for (const [name, data] of Object.entries(artifacts))
    assert.deepEqual(await readFile(join(root, "received", name)), data);
  await assert.rejects(readFile(join(root, "received", "build-source.tar")));
  const success = await readFile(join(root, "calls"), "utf8");
  for (const guard of [
    "StrictHostKeyChecking=yes",
    "HostKeyAlgorithms=ssh-ed25519",
    "BatchMode=yes",
    "sha256sum --check --status",
    "/etc/fv/release.allowed_signers",
    "release stage",
    "host apply",
  ])
    assert.ok(success.includes(guard), guard);
  async function refused(f: () => Promise<unknown>) {
    await assert.rejects(f);
    assert.equal(
      await readFile(join(root, "calls"), "utf8"),
      success,
      "no SSH permitted before the failed trust check",
    );
  }
  await refused(() => invoke({ host: "192.0.2.10" }));
  await writeFile(kh, "* " + publicKey + "\n");
  await refused(() => invoke());
  await writeFile(kh, host + " " + publicKey + "\n");
  const embedded = join(bundle, "signers");
  await writeFile(embedded, await readFile(signers), { mode: 0o600 });
  await refused(() => invoke({ allowedSigners: embedded }));
  await chmod(signers, 0o666);
  await refused(() => invoke());
  await chmod(signers, 0o600);
  await writeFile(join(bundle, "image.tar"), "incorrect");
  await refused(() => invoke());
  await writeFile(join(bundle, "image.tar"), artifacts["image.tar"]!);
  await writeFile(
    manifest,
    JSON.stringify({ ...release, architecture: "arm64" }),
  );
  await refused(() => invoke());
});
