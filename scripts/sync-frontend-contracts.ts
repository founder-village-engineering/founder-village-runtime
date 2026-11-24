import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  featureFrontends,
  frontends,
  type FrontendApplication,
} from "../packages/frontends/index.ts";

type SourceFile = { relativePath: string; content: Buffer };
type Snapshot = {
  version: 1;
  frontend: string;
  application: string;
  source: string;
  sha256: string;
  files: string[];
};

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

export async function assertNoSymlinkPath(
  rootValue: string,
  candidateValue: string,
): Promise<void> {
  const root = resolve(rootValue);
  const candidate = resolve(candidateValue);
  if (!inside(root, candidate))
    throw new Error("path escaped its allowed root");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error(`root must be a real directory: ${root}`);
  let current = root;
  const parts = relative(root, candidate).split(sep).filter(Boolean);
  for (const part of parts) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`symlink refused: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const stat = await lstat(current);
  if (stat.isSymbolicLink()) throw new Error(`symlink refused: ${current}`);
  if (stat.isFile()) return [current];
  if (!stat.isDirectory())
    throw new Error(`unsupported contract entry: ${current}`);
  const entries = await readdir(current);
  const nested = await Promise.all(
    entries.sort().map((entry) => filesUnder(root, resolve(current, entry))),
  );
  return nested.flat();
}

async function readSource(source: string, prefix = ""): Promise<SourceFile[]> {
  const sourceRoot = resolve(runtimeRoot, source);
  await assertNoSymlinkPath(runtimeRoot, sourceRoot);
  const paths = await filesUnder(sourceRoot);
  const files: SourceFile[] = [];
  for (const path of paths) {
    if (!path.endsWith(".ts"))
      throw new Error(`contract source must contain only TypeScript: ${path}`);
    const relativePath = relative(sourceRoot, path).split(sep).join("/");
    if (!relativePath || relativePath.startsWith("../"))
      throw new Error("contract source escaped its root");
    files.push({
      relativePath: `${prefix}${relativePath}`,
      content: await readFile(path),
    });
  }
  if (files.length === 0)
    throw new Error(`empty contract source: ${sourceRoot}`);
  return files;
}

async function sourceBundle(frontend: FrontendApplication): Promise<{
  files: SourceFile[];
  snapshot: Snapshot;
}> {
  const bundles = await Promise.all([
    readSource(frontend.contractSource),
    ...featureFrontends(frontend).map((feature) =>
      readSource(feature.contractSource, `features/${feature.id}/`),
    ),
  ]);
  const ordered = new Map<string, SourceFile>();
  for (const file of bundles.flat()) {
    if (ordered.has(file.relativePath))
      throw new Error(`duplicate contract file: ${file.relativePath}`);
    ordered.set(file.relativePath, file);
  }
  const files = [...ordered.keys()].sort().map((key) => ordered.get(key)!);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(file.content);
    digest.update("\0");
  }
  const snapshot: Snapshot = {
    version: 1,
    frontend: frontend.id,
    application: frontend.application,
    source: frontend.contractSource,
    sha256: digest.digest("hex"),
    files: files.map((file) => file.relativePath),
  };
  return { files, snapshot };
}

function targetRoot(
  frontendsRoot: string,
  frontend: FrontendApplication,
): string {
  const root = resolve(frontendsRoot);
  const target = resolve(
    root,
    frontend.frontendPath,
    "src/generated/contracts",
  );
  if (!inside(root, target) || target === root)
    throw new Error("contract target escaped frontend root");
  return target;
}

function snapshotBytes(snapshot: Snapshot): Buffer {
  return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
}

async function expected(frontend: FrontendApplication) {
  const bundle = await sourceBundle(frontend);
  return new Map<string, Buffer>([
    ...bundle.files.map((file) => [file.relativePath, file.content] as const),
    ["contract-source.json", snapshotBytes(bundle.snapshot)],
  ]);
}

async function checkOne(
  frontendsRoot: string,
  frontend: FrontendApplication,
): Promise<void> {
  const target = targetRoot(frontendsRoot, frontend);
  await assertNoSymlinkPath(frontendsRoot, target);
  const wanted = await expected(frontend);
  let actualPaths: string[];
  try {
    actualPaths = await filesUnder(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`missing generated contracts for ${frontend.id}`);
    throw error;
  }
  const actual = actualPaths
    .map((path) => relative(target, path).split(sep).join("/"))
    .sort();
  const wantedPaths = [...wanted.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wantedPaths))
    throw new Error(`generated contract file list is stale for ${frontend.id}`);
  for (const [relativePath, content] of wanted) {
    const current = await readFile(resolve(target, relativePath));
    if (!current.equals(content))
      throw new Error(
        `generated contract differs: ${frontend.id}/${relativePath}`,
      );
  }
}

async function removeEmptyDirectories(
  root: string,
  current = root,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries)
    if (entry.isDirectory())
      await removeEmptyDirectories(root, resolve(current, entry.name));
  if (current !== root && (await readdir(current)).length === 0)
    await rmdir(current);
}

async function writeOne(
  frontendsRoot: string,
  frontend: FrontendApplication,
): Promise<void> {
  const target = targetRoot(frontendsRoot, frontend);
  await assertNoSymlinkPath(frontendsRoot, target);
  const wanted = await expected(frontend);
  let existing: string[] = [];
  let targetExists = false;
  try {
    existing = await filesUnder(target);
    targetExists = true;
    const marker = JSON.parse(
      await readFile(resolve(target, "contract-source.json"), "utf8"),
    ) as Partial<Snapshot>;
    if (
      marker.frontend !== frontend.id ||
      marker.source !== frontend.contractSource
    )
      throw new Error(
        `generated contract ownership mismatch for ${frontend.id}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || targetExists)
      throw error;
  }
  await mkdir(target, { recursive: true });
  for (const [relativePath, content] of wanted) {
    const output = resolve(target, relativePath);
    if (!inside(target, output))
      throw new Error("contract output escaped target");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, content);
  }
  for (const path of existing) {
    const relativePath = relative(target, path).split(sep).join("/");
    if (!wanted.has(relativePath)) await rm(path);
  }
  await removeEmptyDirectories(target);
}

export async function validateContractSources(
  selected = frontends,
): Promise<void> {
  for (const frontend of selected) await sourceBundle(frontend);
}

export async function checkContractCopies(
  frontendsRoot: string,
  selected = frontends,
): Promise<void> {
  const stat = await lstat(resolve(frontendsRoot));
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("frontend root must be a real directory");
  for (const frontend of selected) await checkOne(frontendsRoot, frontend);
}

export async function writeContractCopies(
  frontendsRoot: string,
  selected = frontends,
): Promise<void> {
  const stat = await lstat(resolve(frontendsRoot));
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("frontend root must be a real directory");
  for (const frontend of selected) await writeOne(frontendsRoot, frontend);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const modes = ["--validate", "--check", "--write", "--watch"].filter((mode) =>
    process.argv.includes(mode),
  );
  if (modes.length !== 1)
    throw new Error(
      "choose exactly one of --validate, --check, --write, or --watch",
    );
  const frontendsRoot = resolve(
    argument("--frontends-root") ?? "../founder-village-frontends",
  );
  const slug = argument("--app");
  const selected = slug
    ? frontends.filter((frontend) => frontend.id === slug)
    : frontends;
  if (!selected.length) throw new Error("unknown frontend for contract sync");
  if (modes[0] === "--validate") {
    await validateContractSources(selected);
    console.log(`validated ${selected.length} frontend contract source(s)`);
    return;
  }
  if (modes[0] === "--check") {
    await checkContractCopies(frontendsRoot, selected);
    console.log(
      `verified ${selected.length} generated frontend contract copy/copies`,
    );
    return;
  }
  await writeContractCopies(frontendsRoot, selected);
  console.log(`synchronized ${selected.length} frontend contract copy/copies`);
  if (modes[0] !== "--watch") return;
  let fingerprints = JSON.stringify(
    await Promise.all(
      selected.map(
        async (frontend) => (await sourceBundle(frontend)).snapshot.sha256,
      ),
    ),
  );
  setInterval(() => {
    void (async () => {
      const next = JSON.stringify(
        await Promise.all(
          selected.map(
            async (frontend) => (await sourceBundle(frontend)).snapshot.sha256,
          ),
        ),
      );
      if (next === fingerprints) return;
      await writeContractCopies(frontendsRoot, selected);
      fingerprints = next;
      console.log("frontend contract change synchronized");
    })().catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "contract sync failed",
      );
      process.exitCode = 1;
    });
  }, 500);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
