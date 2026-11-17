import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { z } from "zod";
import path from "node:path";
const exec = promisify(execFile),
  args = z
    .object({
      host: z.string().refine((s) => isIP(s) !== 0),
      knownHosts: z.string(),
      source: z.string(),
      sourceBundle: z.string(),
      binary: z.string(),
      binaryBundle: z.string(),
      config: z.string(),
      manifest: z.string(),
      manifestBundle: z.string(),
    })
    .parse(JSON.parse(await readFile(process.argv[2] ?? "", "utf8")));
const policy = z
  .object({ issuer: z.string(), identityPattern: z.string() })
  .parse(JSON.parse(await readFile("policies/release.json", "utf8")));
for (const [file, bundle] of [
  [args.source, args.sourceBundle],
  [args.binary, args.binaryBundle],
  [args.manifest, args.manifestBundle],
] as const)
  await exec(
    "cosign",
    [
      "verify-blob",
      "--bundle",
      bundle,
      "--certificate-identity-regexp",
      policy.identityPattern,
      "--certificate-oidc-issuer",
      policy.issuer,
      file,
    ],
    { timeout: 120000 },
  );
const metadata = z
  .object({
    version: z.literal(1),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    sourceSha256: z.string().length(64),
    binarySha256: z.string().length(64),
    files: z.array(
      z.object({ path: z.string(), sha256: z.string().length(64) }),
    ),
  })
  .parse(JSON.parse(await readFile(args.manifest, "utf8")));
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
if (
  digest(await readFile(args.source)) !== metadata.sourceSha256 ||
  digest(await readFile(args.binary)) !== metadata.binarySha256
)
  throw new Error("release artifact binding mismatch");
const targetEnvironment = z
  .object({ environment: z.enum(["staging", "production"]) })
  .parse(JSON.parse(await readFile(args.config, "utf8"))).environment;
const options = [
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  `UserKnownHostsFile=${path.resolve(args.knownHosts)}`,
  "-o",
  "BatchMode=yes",
];
const destination = `fv@${isIP(args.host) === 6 ? `[${args.host}]` : args.host}`;
await exec(
  "ssh",
  [
    ...options,
    destination,
    "sudo install -d -o fv -g fv -m 0755 /opt/founder-village; install -d -m 0700 /tmp/fv-bootstrap",
  ],
  { timeout: 30000 },
);
for (const [source, name] of [
  [args.source, "source.tar"],
  [args.binary, "fv"],
  [args.config, "runtime.json"],
  [args.manifest, "source-manifest.json"],
] as const)
  await exec(
    "scp",
    [...options, source, `${destination}:/tmp/fv-bootstrap/${name}`],
    { timeout: 120000 },
  );
// Extract only the already signature-verified source archive. No secret catalog is copied.
await exec(
  "ssh",
  [
    ...options,
    destination,
    `tar -xf /tmp/fv-bootstrap/source.tar -C /opt/founder-village; cd /opt/founder-village; install -d target/release; install -d -m 0700 .state; install -m 0600 /tmp/fv-bootstrap/source-manifest.json .state/source-manifest.json; install -m 0755 /tmp/fv-bootstrap/fv target/release/fv; install -m 0600 /tmp/fv-bootstrap/runtime.json config/${targetEnvironment}.private.json; sudo target/release/fv --config config/${targetEnvironment}.private.json host apply`,
  ],
  { timeout: 1200000, maxBuffer: 1024 * 1024 },
);
console.log(
  "Verified host code installed. Materialize this environment’s secrets before starting the runtime.",
);
