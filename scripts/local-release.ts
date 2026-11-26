import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type Architecture = "amd64" | "arm64";
type FileDigest = { path: string; sha256: string };
type Image = { tag: string; id: string; manifestId: string };
const imageNames = {
  app: "fv-runtime",
  postgres: "fv-postgres",
  rabbitmq: "fv-rabbitmq",
  hasura: "fv-hasura",
  caddy: "fv-caddy",
  cloudflared: "fv-cloudflared",
  vaultwarden: "fv-vaultwarden",
} as const;
type ImageRole = keyof typeof imageNames;
const roles = Object.keys(imageNames) as ImageRole[];
const sha256Pattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const principal = "founder-village-release";
const namespace = "fv-release-v3";
const scannerImage =
  "aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb";
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};

class ReleaseError extends Error {}

function command(
  program: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string | Buffer;
    extraEnv?: NodeJS.ProcessEnv;
  } = {},
): Buffer {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    input: options.input,
    stdio: [options.input === undefined ? "inherit" : "pipe", "pipe", "ignore"],
    env: { ...environment, ...options.extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new ReleaseError(
      program + " could not complete the local release step.",
    );
  return result.stdout;
}

async function dockerBuild(
  context: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolveBuild, reject) => {
    const build = spawn("docker", ["--context", context, ...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "inherit", "inherit"],
    });
    build.once("error", () =>
      reject(new ReleaseError("Docker could not start.")),
    );
    build.once("close", (status) => {
      if (status === 0) resolveBuild();
      else reject(new ReleaseError("A local Docker release step failed."));
    });
  });
}

function git(root: string, ...args: string[]): Buffer {
  return command("git", ["-C", root, ...args]);
}

function nullRecords(bytes: Buffer): string[] {
  const records = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (records && !records.endsWith("\0")) {
    throw new ReleaseError("An artifact inventory is incomplete.");
  }
  return records ? records.slice(0, -1).split("\0") : [];
}

export function permittedSourcePath(path: string): boolean {
  const parts = path.split("/");
  return (
    /^[A-Za-z0-9_./-]+$/.test(path) &&
    parts[0]?.toLowerCase() !== "backups" &&
    parts.every(
      (part) =>
        part &&
        part !== "." &&
        part !== ".." &&
        !/^(?:\.git|\.state|secrets|node_modules|target|dist|\.cache)$/i.test(
          part,
        ),
    ) &&
    !/(?:^|\/)(?:\.git-credentials|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|\.gitleaksignore)$/i.test(
      path,
    ) &&
    !/(?:\.private\.json|\.tfstate[^/]*|\.(?:key|p8|p12|pfx|jks|kdbx))$/i.test(
      path,
    ) &&
    !parts.some(
      (part) =>
        /^\.(?:env|dev\.vars)(?:\.|$)/i.test(part) &&
        part !== ".env.example" &&
        part !== ".dev.vars.example",
    )
  );
}

function runtimeSourcePath(path: string): boolean {
  return (
    path === "infra/images/rabbitmq-entrypoint.sh" ||
    /^(?:package(?:-lock)?\.json$|(?:bin|config|database|hasura|policies)\/|infra\/(?:compose|systemd|templates)\/)/.test(
      path,
    )
  );
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function snapshot(root: string, staged: string, allowDirty: boolean) {
  const checkoutRevision = git(root, "rev-parse", "--verify", "HEAD^{commit}")
    .toString()
    .trim();
  if (!revisionPattern.test(checkoutRevision))
    throw new ReleaseError("The checkout must have a SHA-1 Git commit.");
  const committed = new Map<string, string>();
  for (const entry of nullRecords(
    git(root, "ls-tree", "-r", "-z", checkoutRevision),
  )) {
    const separator = entry.indexOf("\t");
    const metadata = entry.slice(0, separator);
    if (!/^100(?:644|755) blob [a-f0-9]{40}$/.test(metadata))
      throw new ReleaseError(
        "Git links and special source files are unsupported.",
      );
    committed.set(entry.slice(separator + 1), metadata);
  }
  const names = new Set(
    nullRecords(
      git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"),
    ),
  );
  let dirty = false;
  const files: FileDigest[] = [];
  for (const name of [...names].sort()) {
    if (!permittedSourcePath(name))
      throw new ReleaseError(
        "A Git-visible file has an unsafe or private path.",
      );
    const origin = join(root, name);
    const stat = lstatSync(origin, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || realpathSync(dirname(origin)) !== dirname(origin))
      throw new ReleaseError(
        "The checkout contains a source link or special file.",
      );
    const fd = openSync(
      origin,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let contents: Buffer;
    let mode: number;
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        throw new ReleaseError("A source file changed type during capture.");
      contents = readFileSync(fd);
      mode = opened.mode & 0o100 ? 0o755 : 0o644;
    } finally {
      closeSync(fd);
    }
    const blob = createHash("sha1")
      .update("blob " + contents.length + "\0")
      .update(contents)
      .digest("hex");
    if (
      committed.get(name) !==
      (mode === 0o755 ? "100755" : "100644") + " blob " + blob
    )
      dirty = true;
    committed.delete(name);
    const target = join(staged, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, { mode, flag: "wx" });
    chmodSync(target, mode);
    utimesSync(target, 0, 0);
    files.push({ path: name, sha256: hash(contents) });
  }
  dirty ||= committed.size !== 0;
  if (!files.length || (dirty && !allowDirty))
    throw new ReleaseError(
      "The release has uncommitted source changes. Review them and pass --allow-dirty.",
    );
  return {
    checkoutRevision,
    sourceKind: dirty ? "worktree" : "git-commit",
    files,
  } as const;
}

function sourceArchive(staged: string, output: string, files: FileDigest[]) {
  const bsd = command("tar", ["--version"]).toString().startsWith("bsdtar ");
  const owner = bsd
    ? ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
    : ["--owner=root:0", "--group=root:0"];
  command(
    "tar",
    ["--format", "ustar", ...owner, "-b", "1", "-cf", output, "-T", "-"],
    { cwd: staged, input: files.map(({ path }) => path + "\n").join("") },
  );
}

function scanSnapshot(staged: string) {
  try {
    command(
      "gitleaks",
      [
        "dir",
        ".",
        "--config",
        ".gitleaks.toml",
        "--redact=100",
        "--ignore-gitleaks-allow",
        "--max-archive-depth=2",
        "--no-banner",
      ],
      { cwd: staged },
    );
  } catch {
    throw new ReleaseError(
      "The captured checkout failed its Gitleaks gate. Run npm run security:scan for redacted diagnostics.",
    );
  }
}

export function assertNativeElf(header: Buffer, architecture: Architecture) {
  const machine = architecture === "amd64" ? 62 : 183;
  if (
    header.length < 64 ||
    header.readUInt32BE() !== 0x7f454c46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[6] !== 1 ||
    ![2, 3].includes(header.readUInt16LE(16)) ||
    header.readUInt16LE(18) !== machine
  ) {
    throw new ReleaseError(
      "A binary is not a native Linux ELF for the selected architecture.",
    );
  }
}

function readPrefix(path: string, bytes: number, offset = 0): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const size = readSync(fd, buffer, 0, bytes, offset);
    return buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

export function parseRuntimeFiles(inventory: Buffer): FileDigest[] {
  const names = new Set<string>();
  const files: FileDigest[] = [];
  for (const entry of nullRecords(inventory)) {
    const name = entry.slice(66);
    if (
      !sha256Pattern.test(entry.slice(0, 64)) ||
      entry.slice(64, 66) !== "  " ||
      !/^(?:node$|(?:dist|node_modules)\/)/.test(name) ||
      /[\\\x00-\x1f\x7f]/.test(name) ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      names.has(name)
    ) {
      throw new ReleaseError(
        "The host tool inventory contains an unsafe entry.",
      );
    }
    names.add(name);
    files.push({ path: name, sha256: entry.slice(0, 64) });
  }
  for (const path of [
    "node",
    "dist/packages/database/migrate.js",
    "dist/scripts/materialize-service-env.js",
    "dist/services/domain-worker/main.js",
    "dist/services/monitor/main.js",
    "node_modules/cf/bin/cf",
  ]) {
    if (!names.has(path))
      throw new ReleaseError("A required host runtime file is missing.");
  }
  return files;
}

export function verifyWorkstationSignature(
  manifest: string,
  allowedSigners: string,
) {
  command(
    "ssh-keygen",
    [
      "-Y",
      "verify",
      "-f",
      allowedSigners,
      "-I",
      principal,
      "-n",
      namespace,
      "-s",
      manifest + ".sig",
    ],
    { input: readFileSync(manifest) },
  );
}

export function localDockerContext(): string {
  const context = command("docker", ["context", "show"]).toString().trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context))
    throw new ReleaseError("Select a local Docker context.");
  const endpoint = command("docker", [
    "context",
    "inspect",
    context,
    "--format",
    '{{(index .Endpoints "docker").Host}}',
  ])
    .toString()
    .trim();
  const builder = command("docker", [
    "--context",
    context,
    "buildx",
    "inspect",
    context,
  ]).toString();
  if (
    !endpoint.startsWith("unix:///") ||
    !/^Driver:\s+docker\s*$/m.test(builder)
  )
    throw new ReleaseError(
      "The Docker builder must use the workstation's local Docker engine.",
    );
  return context;
}

function lockedImages(
  staged: string,
): Record<Exclude<ImageRole, "app">, string> {
  const path = join(staged, "config/images.lock.json");
  const pins = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  for (const kind of roles.filter((role) => role !== "app")) {
    if (
      !/^[a-z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(pins[kind] ?? "")
    )
      throw new ReleaseError(
        "All runtime images require a pinned repository digest.",
      );
  }
  return pins as Record<Exclude<ImageRole, "app">, string>;
}

type ObservedImage = { tag: string; engineId: string };
type OciDescriptor = {
  digest: string;
  mediaType: string;
  annotations?: Record<string, string>;
};
type OciManifest = { config: OciDescriptor; layers: OciDescriptor[] };
const ociManifestType = "application/vnd.oci.image.manifest.v1+json";
const ociBlob = (id: string) => "blobs/sha256/" + id.slice(7);

export function verifySavedImages(
  archive: string,
  expected: Partial<Record<ImageRole, ObservedImage>>,
  architecture: Architecture,
  revision: string,
): Record<ImageRole, Image> {
  const extract = (path: string) => command("tar", ["-xOf", archive, path]);
  const archived = new Set(
    command("tar", ["-tf", archive]).toString().trimEnd().split("\n"),
  );
  const entries = JSON.parse(extract("manifest.json").toString()) as {
    Config: string;
    RepoTags: string[];
    Layers: string[];
  }[];
  if (!archived.has("index.json"))
    throw new ReleaseError(
      "Use Docker's containerd image store to export the release.",
    );
  const index = JSON.parse(extract("index.json").toString()) as {
    manifests: OciDescriptor[];
  };
  const requested = Object.entries(expected) as [ImageRole, ObservedImage][];
  if (
    !Array.isArray(entries) ||
    entries.length !== requested.length ||
    !Array.isArray(index.manifests)
  )
    throw new ReleaseError(
      "The Docker archive must contain the exact runtime service image set.",
    );
  const named = index.manifests.filter(
    ({ annotations }) => annotations?.["io.containerd.image.name"],
  );
  if (named.length !== requested.length)
    throw new ReleaseError(
      "The OCI index must contain the exact runtime service tags.",
    );
  const images: Partial<Record<ImageRole, Image>> = {};
  for (const [role, image] of requested) {
    const entry = entries.find(
      ({ RepoTags }) => RepoTags?.length === 1 && RepoTags[0] === image.tag,
    );
    const descriptor = named.find(
      ({ annotations }) =>
        annotations?.["io.containerd.image.name"] ===
        "docker.io/library/" + image.tag,
    );
    if (
      !entry ||
      !/^blobs\/sha256\/[a-f0-9]{64}$/.test(entry.Config) ||
      !descriptor ||
      !imageIdPattern.test(descriptor.digest) ||
      ![
        ociManifestType,
        "application/vnd.docker.distribution.manifest.v2+json",
      ].includes(descriptor.mediaType)
    )
      throw new ReleaseError(
        "A required image tag is missing from the Docker archive.",
      );
    const manifestId = descriptor.digest;
    const manifestBytes = extract(ociBlob(manifestId));
    const manifest = JSON.parse(manifestBytes.toString()) as OciManifest;
    const bytes = extract(entry.Config);
    const config = JSON.parse(bytes.toString());
    const id = "sha256:" + hash(bytes);
    if (
      "sha256:" + hash(manifestBytes) !== manifestId ||
      manifest.config?.digest !== id ||
      entry.Config !== ociBlob(id) ||
      ![id, manifestId].includes(image.engineId) ||
      config.os !== "linux" ||
      config.architecture !== architecture ||
      (role === "app" &&
        config.config?.Labels?.["org.opencontainers.image.revision"] !==
          revision)
    ) {
      throw new ReleaseError(
        "A saved image ID, architecture or app revision did not match.",
      );
    }
    if (
      !manifest.layers?.length ||
      !Array.isArray(entry.Layers) ||
      entry.Layers.length !== manifest.layers.length ||
      !manifest.layers.every(({ digest }, index) => {
        const layer = ociBlob(digest);
        return (
          imageIdPattern.test(digest) &&
          entry.Layers[index] === layer &&
          archived.has(layer)
        );
      })
    )
      throw new ReleaseError(
        "A saved image archive is missing an expected runtime layer.",
      );
    images[role] = { tag: image.tag, id, manifestId };
  }
  // Docker can retain a published in-toto attestation alongside its subject.
  // Only detached metadata for one of the checked platform images is valid.
  for (const attachment of index.manifests.filter(
    (entry) => !named.includes(entry),
  )) {
    const subject = attachment.annotations?.["io.containerd.manifest.subject"];
    if (
      !Object.values(images).some((image) => image.manifestId === subject) ||
      attachment.mediaType !== ociManifestType ||
      !imageIdPattern.test(attachment.digest)
    )
      throw new ReleaseError(
        "Unexpected image content in the OCI archive index.",
      );
    const bytes = extract(ociBlob(attachment.digest));
    const metadata = JSON.parse(bytes.toString()) as OciManifest;
    if (
      "sha256:" + hash(bytes) !== attachment.digest ||
      !imageIdPattern.test(metadata.config?.digest ?? "") ||
      !archived.has(ociBlob(metadata.config.digest)) ||
      !metadata.layers?.length ||
      !metadata.layers.every(
        ({ digest, mediaType }) =>
          mediaType === "application/vnd.in-toto+json" &&
          imageIdPattern.test(digest) &&
          archived.has(ociBlob(digest)),
      )
    )
      throw new ReleaseError(
        "The OCI archive contains invalid attached metadata.",
      );
  }
  return images as Record<ImageRole, Image>;
}

async function scanAppImage(
  context: string,
  staged: string,
  temporary: string,
  sbom: string,
  images: Record<ImageRole, Image>,
  architecture: Architecture,
  revision: string,
) {
  const input = join(temporary, "scan-input");
  const report = join(temporary, "scan-report");
  const cache = join(temporary, "scan-cache");
  mkdirSync(input);
  mkdirSync(report);
  mkdirSync(cache);
  const archive = join(input, "app.tar");
  await dockerBuild(
    context,
    [
      "image",
      "save",
      "--platform",
      "linux/" + architecture,
      "--output",
      archive,
      images.app.tag,
    ],
    staged,
  );
  verifySavedImages(
    archive,
    { app: { tag: images.app.tag, engineId: images.app.manifestId } },
    architecture,
    revision,
  );
  console.log(
    "Scanning the exact application image for high and critical vulnerabilities.",
  );
  await dockerBuild(
    context,
    [
      "run",
      "--rm",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:size=2g,nosuid,nodev",
      "--mount",
      "type=bind,source=" + cache + ",target=/cache",
      "--mount",
      "type=bind,source=" + input + ",target=/input,readonly",
      "--mount",
      "type=bind,source=" + report + ",target=/report",
      scannerImage,
      "image",
      "--cache-dir",
      "/cache",
      "--no-progress",
      "--input",
      "/input/app.tar",
      "--scanners",
      "vuln",
      "--severity",
      "HIGH,CRITICAL",
      "--exit-code",
      "1",
      "--format",
      "cyclonedx",
      "--output",
      "/report/sbom.cdx.json",
      "--db-repository",
      "mirror.gcr.io/aquasec/trivy-db:2",
      "--db-repository",
      "public.ecr.aws/aquasecurity/trivy-db:2",
    ],
    staged,
  );
  const result = join(report, "sbom.cdx.json");
  const parsed = JSON.parse(readFileSync(result, "utf8"));
  if (
    parsed.bomFormat !== "CycloneDX" ||
    !Array.isArray(parsed.components) ||
    !parsed.components.length
  )
    throw new ReleaseError(
      "The scanner did not produce a usable CycloneDX SBOM.",
    );
  copyFileSync(result, sbom, constants.COPYFILE_EXCL);
}

function checkTrustPath(
  path: string,
  root: string,
  privateFile: boolean,
): string {
  const name = resolve(path);
  const stat = lstatSync(name);
  const outside = relative(root, name);
  if (
    !(outside === ".." || outside.startsWith("../") || isAbsolute(outside)) ||
    realpathSync(name) !== name ||
    !stat.isFile() ||
    (stat.uid !== process.getuid?.() && stat.uid !== 0) ||
    stat.mode & (privateFile ? 0o077 : 0o022)
  ) {
    throw new ReleaseError(
      "Use owned, protected signing and trust files outside the checkout.",
    );
  }
  return name;
}

const usage = [
  "npm run release:local -- --arch amd64|arm64 --out NEW_DIRECTORY",
  "  --signing-key ED25519_KEY --allowed-signers TRUST_FILE [--allow-dirty]",
].join("\n");

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      arch: { type: "string" },
      out: { type: "string" },
      "signing-key": { type: "string" },
      "allowed-signers": { type: "string" },
      "allow-dirty": { type: "boolean" },
      help: { type: "boolean" },
    },
  }) as { values: Record<string, string | boolean | undefined> };
  if (values.help) {
    console.log(usage);
    return;
  }
  const architecture = values.arch;
  const { out, "signing-key": key, "allowed-signers": pin } = values;
  if (
    (architecture !== "amd64" && architecture !== "arm64") ||
    typeof out !== "string" ||
    !out ||
    typeof key !== "string" ||
    !key ||
    typeof pin !== "string" ||
    !pin
  ) {
    throw new ReleaseError(usage);
  }
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  if (git(root, "rev-parse", "--show-toplevel").toString().trim() !== root)
    throw new ReleaseError(
      "Run this command from the Founder Village runtime checkout.",
    );
  const signingKey = checkTrustPath(key, root, !key.endsWith(".pub"));
  const allowedSigners = checkTrustPath(pin, root, false);
  const pinned =
    /^founder-village-release namespaces="fv-release-v3" ssh-ed25519 ([A-Za-z0-9+/]+={0,2})\n?$/.exec(
      readFileSync(allowedSigners, "utf8"),
    );
  const pinnedPublicKey = pinned?.[1];
  if (!pinnedPublicKey)
    throw new ReleaseError(
      "Pin exactly one namespaced Founder release Ed25519 public key without a comment.",
    );
  const pinnedFingerprint = createHash("sha256")
    .update(Buffer.from(pinnedPublicKey, "base64"))
    .digest("base64")
    .replace(/=+$/, "");
  const keyInfo = command("ssh-keygen", [
    "-l",
    "-E",
    "sha256",
    "-f",
    signingKey,
  ])
    .toString()
    .trim();
  if (
    signingKey === allowedSigners ||
    !keyInfo.endsWith(" (ED25519)") ||
    keyInfo.split(" ")[1] !== "SHA256:" + pinnedFingerprint
  )
    throw new ReleaseError(
      "Use a dedicated Ed25519 signing key and an independent trust pin.",
    );
  const destination = resolve(out);
  const parent = dirname(destination);
  const outputParent = lstatSync(parent);
  if (
    !outputParent.isDirectory() ||
    outputParent.uid !== process.getuid?.() ||
    outputParent.mode & 0o022 ||
    realpathSync(parent) !== parent ||
    existsSync(destination)
  ) {
    throw new ReleaseError(
      "Choose a new output directory under a protected, owned directory.",
    );
  }
  const relativeParent = relative(root, parent);
  if (
    !relativeParent ||
    (relativeParent !== ".." &&
      !relativeParent.startsWith("../") &&
      !isAbsolute(relativeParent))
  )
    git(
      root,
      "check-ignore",
      "--quiet",
      "--no-index",
      "--",
      relativeParent + "/",
    );
  const context = localDockerContext();
  const temporary = mkdtempSync(join(parent, ".fv-release-"));
  const staged = join(temporary, "source");
  const bundle = join(temporary, "bundle");
  mkdirSync(staged);
  mkdirSync(bundle);
  try {
    const {
      checkoutRevision,
      sourceKind,
      files: allFiles,
    } = snapshot(root, staged, values["allow-dirty"] === true);
    console.log("Scanning the exact captured checkout.");
    scanSnapshot(staged);
    // Keep the full checked build input for local review. Remote bootstrap
    // transfers a fixed list of runtime artifacts and omits this archive.
    const buildSource = join(bundle, "build-source.tar");
    sourceArchive(staged, buildSource, allFiles);
    const buildSourceSha256 = await hashFile(buildSource);
    const revision =
      sourceKind === "git-commit"
        ? checkoutRevision
        : buildSourceSha256.slice(0, 40);
    const files = allFiles.filter(({ path }) => runtimeSourcePath(path));
    const source = join(bundle, "source.tar");
    sourceArchive(staged, source, files);
    const platform = "linux/" + architecture;
    const pins = lockedImages(staged);
    const tags = Object.fromEntries(
      roles.map((role) => [role, imageNames[role] + ":local-" + revision]),
    ) as Record<ImageRole, string>;
    const docker = (args: string[]) => dockerBuild(context, args, staged);
    const build = (recipe: string, ...args: string[]) =>
      docker([
        "buildx",
        "build",
        "--builder",
        context,
        "--platform",
        platform,
        "--provenance=false",
        "-f",
        "infra/images/" + recipe + ".Dockerfile",
        ...args,
        ".",
      ]);
    const imageCommand = (...args: string[]) =>
      command("docker", ["--context", context, ...args], { cwd: staged })
        .toString()
        .trim();
    const native = join(temporary, "native");
    const tools = join(temporary, "tools");
    console.log(
      "Building Linux " +
        architecture +
        " release " +
        revision +
        " from " +
        sourceKind +
        " source.",
    );
    const runtimeImages = async () => {
      for (const role of ["postgres", "rabbitmq"] as const) {
        await build(
          role,
          "--load",
          "-t",
          tags[role],
          "--build-arg",
          role.toUpperCase() + "_IMAGE=" + pins[role],
        );
      }
      for (const role of [
        "hasura",
        "caddy",
        "cloudflared",
        "vaultwarden",
      ] as const) {
        await docker(["pull", "--platform", platform, pins[role]]);
        imageCommand("image", "tag", pins[role], tags[role]);
      }
    };
    const builds = await Promise.allSettled([
      build("release-cli", "--output", "type=local,dest=" + native),
      build(
        "app",
        "--load",
        "--build-arg",
        "FV_REVISION=" + revision,
        "-t",
        tags.app,
      ).then(() =>
        build(
          "app",
          "--target",
          "host-tools-export",
          "--output",
          "type=local,dest=" + tools,
        ),
      ),
      runtimeImages(),
    ]);
    for (const result of builds)
      if (result.status === "rejected") throw result.reason;
    const binary = join(bundle, "fv");
    copyFileSync(join(native, "fv"), binary);
    chmodSync(binary, 0o755);
    assertNativeElf(readPrefix(binary, 64), architecture);
    const runtime = join(bundle, "runtime.tar");
    renameSync(join(tools, "runtime.tar"), runtime);
    if (!readPrefix(runtime, 5).equals(Buffer.from("node\0")))
      throw new ReleaseError(
        "The runtime archive must start with the native Node binary.",
      );
    assertNativeElf(readPrefix(runtime, 64, 512), architecture);
    const runtimeFiles = parseRuntimeFiles(
      readFileSync(join(tools, "runtime.sha256")),
    );
    const expected = Object.fromEntries(
      roles.map((role) => {
        const tag = tags[role];
        const engineId = imageCommand(
          "image",
          "inspect",
          "--platform",
          platform,
          "--format",
          "{{.Id}}",
          tag,
        );
        if (!imageIdPattern.test(engineId))
          throw new ReleaseError("A runtime image ID could not be verified.");
        return [role, { tag, engineId }];
      }),
    ) as Record<ImageRole, ObservedImage>;
    const imageArchive = join(bundle, "image.tar");
    await docker([
      "image",
      "save",
      "--platform",
      platform,
      "--output",
      imageArchive,
      ...Object.values(tags),
    ]);
    const images = verifySavedImages(
      imageArchive,
      expected,
      architecture,
      revision,
    );
    const sbom = join(bundle, "sbom.cdx.json");
    await scanAppImage(
      context,
      staged,
      temporary,
      sbom,
      images,
      architecture,
      revision,
    );
    const [
      sourceSha256,
      binarySha256,
      imageArchiveSha256,
      runtimeArchiveSha256,
      sbomSha256,
    ] = await Promise.all(
      [source, binary, imageArchive, runtime, sbom].map(hashFile),
    );
    const manifest = join(bundle, "source-manifest.json");
    const document = Buffer.from(
      JSON.stringify(
        {
          version: 3,
          distribution: "workstation",
          revision,
          checkoutRevision,
          sourceKind,
          buildSourceSha256,
          architecture,
          image: images.app.tag,
          imageId: images.app.id,
          images,
          sourceSha256,
          binarySha256,
          imageArchiveSha256,
          runtimeArchiveSha256,
          sbomSha256,
          files,
          runtimeFiles,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(manifest, document, { mode: 0o600, flag: "wx" });
    command(
      "ssh-keygen",
      ["-Y", "sign", "-f", signingKey, "-n", namespace, manifest],
      { extraEnv: { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } },
    );
    verifyWorkstationSignature(manifest, allowedSigners);
    for (const artifact of [
      source,
      buildSource,
      runtime,
      imageArchive,
      sbom,
      manifest,
      manifest + ".sig",
    ])
      chmodSync(artifact, 0o600);
    if (lstatSync(destination, { throwIfNoEntry: false }))
      throw new ReleaseError(
        "The output path appeared while the release was building.",
      );
    renameSync(bundle, destination);
    console.log(
      "Verified and signed the workstation release in " +
        basename(destination) +
        ".",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    console.error(
      error instanceof ReleaseError
        ? error.message
        : "Local release could not complete safely.",
    );
    process.exitCode = 1;
  });
}
