import type { FastifyInstance } from "fastify";
import {
  publicApiVersions,
  unversionedPublicApiContract,
  type PublicApiVersion,
} from "../../packages/contracts/api-versioning.ts";

function lifecycleDate(value: string): Date {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds))
    throw new Error(`invalid API lifecycle date: ${value}`);
  return new Date(milliseconds);
}

function versionById(id: string): PublicApiVersion | undefined {
  return publicApiVersions.find((version) => version.id === id);
}

function lifecycleHeaders(
  version: PublicApiVersion,
): ReadonlyArray<readonly [string, string]> {
  const headers: Array<readonly [string, string]> = [
    ["api-version", version.id],
  ];
  if (version.deprecatedAt)
    headers.push([
      "deprecation",
      `@${Math.floor(lifecycleDate(version.deprecatedAt).valueOf() / 1000)}`,
    ]);
  if (version.sunsetAt)
    headers.push(["sunset", lifecycleDate(version.sunsetAt).toUTCString()]);
  if (version.successor) {
    const successor = versionById(version.successor);
    if (!successor)
      throw new Error(`unknown successor API version: ${version.successor}`);
    headers.push(["link", `<${successor.basePath}>; rel="successor-version"`]);
  }
  return headers;
}

function assertVersionRegistry(): void {
  const ids = new Set<string>();
  const basePaths = new Set<string>();
  for (const version of publicApiVersions) {
    if (!/^v[1-9][0-9]*$/.test(version.id))
      throw new Error(`invalid API version id: ${version.id}`);
    if (ids.has(version.id))
      throw new Error(`duplicate API version id: ${version.id}`);
    if (basePaths.has(version.basePath))
      throw new Error(`duplicate API version base path: ${version.basePath}`);
    if (version.basePath !== `/${version.id}`)
      throw new Error(`API version base path must match ${version.id}`);
    if (version.openApiPath !== `${version.basePath}/openapi.json`)
      throw new Error(`invalid OpenAPI path for ${version.id}`);
    if (
      Number(version.semanticVersion.split(".")[0]) !==
      Number(version.id.slice(1))
    )
      throw new Error(`semantic major must match ${version.id}`);
    if (version.status === "deprecated") {
      const deprecatedAt = lifecycleDate(version.deprecatedAt);
      if (version.sunsetAt && lifecycleDate(version.sunsetAt) <= deprecatedAt)
        throw new Error(`sunset must follow deprecation for ${version.id}`);
    }
    ids.add(version.id);
    basePaths.add(version.basePath);
  }
  if (!ids.has(unversionedPublicApiContract.id))
    throw new Error("unversioned API contract is not registered");
  for (const version of publicApiVersions)
    if (
      version.successor &&
      (version.successor === version.id || !ids.has(version.successor))
    )
      throw new Error(`invalid successor for ${version.id}`);
}

export function installApiVersionHeaders(
  app: FastifyInstance,
  version: PublicApiVersion,
): void {
  const headers = lifecycleHeaders(version);
  app.addHook("onSend", async (_request, reply, payload) => {
    for (const [name, value] of headers) reply.header(name, value);
    return payload;
  });
}

export function registerApiVersionCatalog(app: FastifyInstance): void {
  assertVersionRegistry();
  app.get("/api/versions", async () => ({
    strategy: "url-major",
    unversioned: {
      basePath: "/",
      contract: unversionedPublicApiContract.id,
      policy: "backward-compatible",
    },
    versions: publicApiVersions.map((version) => ({
      id: version.id,
      semanticVersion: version.semanticVersion,
      basePath: version.basePath,
      openApiPath: version.openApiPath,
      status: version.status,
      ...(version.deprecatedAt ? { deprecatedAt: version.deprecatedAt } : {}),
      ...(version.sunsetAt ? { sunsetAt: version.sunsetAt } : {}),
      ...(version.successor ? { successor: version.successor } : {}),
    })),
  }));
}
