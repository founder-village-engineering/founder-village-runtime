import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  applicationSchema,
  applications,
} from "../packages/database/applications.ts";
import {
  customOriginFields,
  featureFrontends,
  featureFrontendsSchema,
  frontendOrigins,
  frontendSchema,
  frontends,
  pagesProjectFields,
  registeredOrigin,
  usesOneAliasFormat,
} from "../packages/frontends/index.ts";

const run = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reservedApplications = new Set(["postgres", "template0", "template1"]);

const manifestSchema = z
  .object({
    version: z.literal(1),
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    title: z.string().min(1).max(100),
    owner: z.string().min(1).max(100),
    description: z.string().min(1).max(240),
    application: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    ...pagesProjectFields,
    ...customOriginFields,
    runtimeApiOrigin: z
      .url({ protocol: /^https$/ })
      .refine(
        (value) => new URL(value).origin === value,
        "expected HTTPS origin",
      )
      .optional(),
    localOrigin: z.string().url(),
    localPort: z.number().int().min(1024).max(65535),
    contractSource: z
      .string()
      .regex(/^packages\/frontend-contracts\/[a-z][a-z0-9-]{0,62}$/),
    featureFrontends: featureFrontendsSchema.optional(),
  })
  .strict()
  .refine(usesOneAliasFormat, "use customOrigin or customOrigins");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function desired(manifestPath: string, frontendsRoot: string) {
  const root = resolve(frontendsRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("frontend root must be a real directory");
  const absoluteManifest = resolve(manifestPath);
  if (!inside(root, absoluteManifest))
    throw new Error("frontend manifest must be inside the frontend repository");
  const manifestStat = await lstat(absoluteManifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error("frontend manifest must be a real file");
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(absoluteManifest, "utf8")),
  );
  if (reservedApplications.has(manifest.application))
    throw new Error("application namespace is reserved");
  if (
    manifest.contractSource !== `packages/frontend-contracts/${manifest.slug}`
  )
    throw new Error("contract source must match frontend slug");
  const production = new URL(manifest.productionOrigin);
  const local = new URL(manifest.localOrigin);
  if (
    production.origin !== manifest.productionOrigin ||
    production.protocol !== "https:" ||
    production.hostname !== `${manifest.pagesProject}.pages.dev` ||
    production.pathname !== "/" ||
    production.search ||
    production.hash
  )
    throw new Error("production origin must be the exact Pages origin");
  if (
    local.origin !== manifest.localOrigin ||
    local.protocol !== "https:" ||
    !/^[a-z][a-z0-9-]*\.fv$/.test(local.hostname) ||
    local.pathname !== "/" ||
    local.search ||
    local.hash
  )
    throw new Error("local origin must be one-label .fv HTTPS");
  const registeredApplication = applications.find(
    (entry) => entry.id === manifest.application,
  );
  if (
    registeredApplication &&
    (registeredApplication.database !== manifest.application ||
      registeredApplication.hasuraSource !== manifest.application)
  )
    throw new Error(
      "shared application database and Hasura source must match its id",
    );
  if (
    applications.some(
      (entry) =>
        entry.id !== manifest.application &&
        (entry.database === manifest.application ||
          entry.hasuraSource === manifest.application),
    )
  )
    throw new Error("application namespace collides with another registration");
  const appEntry =
    registeredApplication ??
    applicationSchema.parse({
      id: manifest.application,
      database: manifest.application,
      hasuraSource: manifest.application,
      owner: manifest.owner,
    });
  const frontendEntry = frontendSchema.parse({
    id: manifest.slug,
    application: manifest.application,
    pagesProject: manifest.pagesProject,
    productionOrigin: manifest.productionOrigin,
    ...(manifest.additionalPagesProjects
      ? { additionalPagesProjects: manifest.additionalPagesProjects }
      : {}),
    ...(manifest.customOrigin ? { customOrigin: manifest.customOrigin } : {}),
    ...(manifest.customOrigins
      ? { customOrigins: manifest.customOrigins }
      : {}),
    localOrigins: [
      manifest.localOrigin,
      `http://127.0.0.1:${manifest.localPort}`,
    ],
    frontendPath: `apps/${manifest.slug}`,
    contractSource: manifest.contractSource,
    ...(manifest.featureFrontends
      ? { featureFrontends: manifest.featureFrontends }
      : {}),
  });
  featureFrontends(frontendEntry);
  return { root, manifest, local, appEntry, frontendEntry };
}

async function plan(manifestPath: string, frontendsRoot: string) {
  const next = await desired(manifestPath, frontendsRoot);
  const existingApplication = applications.find(
    (entry) => entry.id === next.appEntry.id,
  );
  const existingFrontend = frontends.find(
    (entry) =>
      entry.id === next.frontendEntry.id ||
      entry.pagesProject === next.frontendEntry.pagesProject ||
      entry.frontendPath === next.frontendEntry.frontendPath ||
      entry.contractSource === next.frontendEntry.contractSource,
  );
  if (existingFrontend && !equal(existingFrontend, next.frontendEntry))
    throw new Error("frontend collides with a different registration");
  if (
    !existingFrontend &&
    frontendOrigins(next.frontendEntry).some((origin) =>
      registeredOrigin(origin),
    )
  )
    throw new Error("frontend origin collides with a different registration");
  const domains = JSON.parse(
    await readFile(resolve(runtimeRoot, "config/local-domains.json"), "utf8"),
  ) as Record<string, unknown>;
  const hostname = next.local.hostname;
  if (
    domains[hostname] !== undefined &&
    domains[hostname] !== next.manifest.localPort
  )
    throw new Error("local frontend domain or port collides");
  if (
    Object.entries(domains).some(
      ([name, port]) => name !== hostname && port === next.manifest.localPort,
    )
  )
    throw new Error("local frontend port is already registered");
  return {
    ...next,
    domains,
    addApplication: !existingApplication,
    addFrontend: !existingFrontend,
    addDomain: domains[hostname] === undefined,
  };
}

async function apply(
  manifestPath: string,
  frontendsRoot: string,
): Promise<void> {
  const next = await plan(manifestPath, frontendsRoot);
  if (next.addApplication)
    await writeFile(
      resolve(runtimeRoot, "config/applications.json"),
      `${JSON.stringify([...applications, next.appEntry], null, 2)}\n`,
    );
  if (next.addFrontend)
    await writeFile(
      resolve(runtimeRoot, "config/frontends.json"),
      `${JSON.stringify([...frontends, next.frontendEntry], null, 2)}\n`,
    );
  if (next.addDomain) {
    const domains = Object.fromEntries(
      Object.entries({
        ...next.domains,
        [next.local.hostname]: next.manifest.localPort,
      }).sort(([left], [right]) => left.localeCompare(right)),
    );
    await writeFile(
      resolve(runtimeRoot, "config/local-domains.json"),
      `${JSON.stringify(domains, null, 2)}\n`,
    );
  }
  await mkdir(
    resolve(runtimeRoot, `database/applications/${next.manifest.application}`),
    {
      recursive: true,
    },
  );
  await mkdir(
    resolve(runtimeRoot, `hasura/applications/${next.manifest.application}`),
    {
      recursive: true,
    },
  );
  const contractDirectory = resolve(runtimeRoot, next.manifest.contractSource);
  await mkdir(contractDirectory, { recursive: true });
  const contract = resolve(contractDirectory, "index.ts");
  try {
    await readFile(contract);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(
      contract,
      `export const applicationId = ${JSON.stringify(next.manifest.application)} as const;\nexport type ApplicationId = typeof applicationId;\n`,
    );
  }
  await run(
    process.execPath,
    ["--import", "tsx", "scripts/generate-hasura.ts"],
    { cwd: runtimeRoot },
  );
  await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/sync-frontend-contracts.ts",
      "--write",
      "--frontends-root",
      next.root,
      "--app",
      next.frontendEntry.id,
    ],
    { cwd: runtimeRoot },
  );
}

async function main(): Promise<void> {
  const manifest = option("--manifest");
  if (!manifest) throw new Error("--manifest is required");
  const root = option("--frontends-root") ?? "../founder-village-frontends";
  const modes = ["--plan", "--apply"].filter((mode) =>
    process.argv.includes(mode),
  );
  if (modes.length !== 1)
    throw new Error("choose exactly one of --plan or --apply");
  if (modes[0] === "--plan") {
    const result = await plan(manifest, root);
    console.log(
      JSON.stringify(
        {
          application: result.appEntry.id,
          frontend: result.frontendEntry.id,
          addApplication: result.addApplication,
          addFrontend: result.addFrontend,
          addDomain: result.addDomain,
          contractSource: result.frontendEntry.contractSource,
        },
        null,
        2,
      ),
    );
    return;
  }
  await apply(manifest, root);
  console.log("frontend runtime onboarding synchronized");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
