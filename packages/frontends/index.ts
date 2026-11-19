import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { applications } from "../database/applications.ts";

const origin = z
  .string()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.origin === value &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  }, "origin must contain only scheme, host, and optional port");

export const frontendSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    application: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    pagesProject: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    productionOrigin: origin,
    localOrigins: z.array(origin).min(1),
    frontendPath: z.string().regex(/^apps\/[a-z][a-z0-9-]{0,62}$/),
    contractSource: z
      .string()
      .regex(/^packages\/frontend-contracts\/[a-z][a-z0-9-]{0,62}$/),
  })
  .strict();

export type FrontendApplication = z.infer<typeof frontendSchema>;

export const frontends = z
  .array(frontendSchema)
  .min(1)
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../config/frontends.json", import.meta.url)),
        "utf8",
      ),
    ),
  );

const ids = new Set<string>();
const projects = new Set<string>();
const paths = new Set<string>();
const contractSources = new Set<string>();
const origins = new Set<string>();
const applicationsById = new Set(applications.map((entry) => entry.id));

for (const frontend of frontends) {
  if (
    ids.has(frontend.id) ||
    projects.has(frontend.pagesProject) ||
    paths.has(frontend.frontendPath) ||
    contractSources.has(frontend.contractSource)
  )
    throw new Error("duplicate frontend registration");
  ids.add(frontend.id);
  projects.add(frontend.pagesProject);
  paths.add(frontend.frontendPath);
  contractSources.add(frontend.contractSource);
  if (!applicationsById.has(frontend.application))
    throw new Error("frontend references unknown application");
  if (frontend.contractSource !== `packages/frontend-contracts/${frontend.id}`)
    throw new Error("frontend contract source must match frontend id");
  const production = new URL(frontend.productionOrigin);
  if (
    production.protocol !== "https:" ||
    production.hostname !== `${frontend.pagesProject}.pages.dev` ||
    production.port
  )
    throw new Error(
      "frontend production origin must be its exact Pages origin",
    );
  for (const value of frontend.localOrigins) {
    const local = new URL(value);
    const canonicalLocalHttps =
      local.protocol === "https:" &&
      /^[a-z][a-z0-9-]*\.fv$/.test(local.hostname) &&
      !local.port;
    const loopbackHttp =
      local.protocol === "http:" &&
      local.hostname === "127.0.0.1" &&
      Boolean(local.port);
    if (!canonicalLocalHttps && !loopbackHttp)
      throw new Error(
        "frontend local origin must be one-label .fv HTTPS or loopback HTTP",
      );
  }
  for (const value of [frontend.productionOrigin, ...frontend.localOrigins]) {
    if (origins.has(value)) throw new Error("frontend origins must be unique");
    origins.add(value);
  }
}

export function originAllowed(
  application: string,
  originValue: string,
): boolean {
  return frontends.some(
    (frontend) =>
      frontend.application === application &&
      [frontend.productionOrigin, ...frontend.localOrigins].includes(
        originValue,
      ),
  );
}

export function registeredOrigin(originValue: string): boolean {
  return origins.has(originValue);
}
