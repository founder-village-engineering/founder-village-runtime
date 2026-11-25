import { z } from "zod";
import frontendRegistry from "../../config/frontends.json" with { type: "json" };
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

const customOriginSchema = origin.refine(
  (value) =>
    /^https:\/\/[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.foundervillage\.xyz$/.test(
      value,
    ),
  "alias must be one HTTPS label below foundervillage.xyz",
);

export const customOriginFields = {
  customOrigin: customOriginSchema.optional(),
  customOrigins: z
    .array(
      z.union([
        customOriginSchema,
        z.literal(["https://founderhaus.org", "https://foundervillage.org"]),
      ]),
    )
    .min(1)
    .refine(
      (values) => new Set(values).size === values.length,
      "duplicate alias",
    )
    .optional(),
};

export function usesOneAliasFormat(frontend: {
  customOrigin?: string;
  customOrigins?: string[];
}) {
  return !frontend.customOrigin || !frontend.customOrigins;
}

const applicationRoutes: Partial<Record<string, RegExp>> = {
  "founder-village-app":
    /^\/(?:food-deliveries(?:\/tenants)?|founders\/me|expenses|members\/(?:me|profile|delete|membership|directory(?:\/[^/]+\/whatsapp)?|checkout(?:\/[^/]+\/(?:open|check|cancel))?))$/,
  "founder-village-team":
    /^\/team\/(?:tenants|capabilities|bots(?:\/[^/]+)?|conversations(?:\/[^/]+(?:\/messages(?:\/[^/]+\/content)?|\/replies)?)?|engineering\/items(?:\/[^/]+\/status)?)$/,
};

export const featureFrontendsSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/))
  .min(1)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "duplicate feature frontend",
  );

export const frontendSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    application: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    pagesProject: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    productionOrigin: origin,
    ...customOriginFields,
    localOrigins: z.array(origin).min(1),
    frontendPath: z.string().regex(/^apps\/[a-z][a-z0-9-]{0,62}$/),
    contractSource: z
      .string()
      .regex(/^packages\/frontend-contracts\/[a-z][a-z0-9-]{0,62}$/),
    featureFrontends: featureFrontendsSchema.optional(),
  })
  .strict()
  .refine(usesOneAliasFormat, "use customOrigin or customOrigins");

export type FrontendApplication = z.infer<typeof frontendSchema>;

export const frontends = z.array(frontendSchema).min(1).parse(frontendRegistry);

const ids = new Set<string>();
const projects = new Set<string>();
const paths = new Set<string>();
const contractSources = new Set<string>();
const origins = new Set<string>();
const applicationsById = new Set(applications.map((entry) => entry.id));

export function productionOrigins(
  frontend: Pick<
    FrontendApplication,
    "productionOrigin" | "customOrigin" | "customOrigins"
  >,
) {
  return [
    frontend.productionOrigin,
    ...(frontend.customOrigins ??
      (frontend.customOrigin ? [frontend.customOrigin] : [])),
  ];
}

export function frontendOrigins(frontend: FrontendApplication) {
  return [...productionOrigins(frontend), ...frontend.localOrigins];
}

export function featureFrontends(frontend: FrontendApplication) {
  const sources = (frontend.featureFrontends ?? []).map((id) => {
    const source = frontends.find((entry) => entry.id === id);
    if (
      !source ||
      source.id === frontend.id ||
      source.featureFrontends ||
      source.application === frontend.application
    )
      throw new Error(
        "feature must reference a standalone frontend in another application",
      );
    return source;
  });
  if (
    sources.length &&
    ![frontend, ...sources].every((source) =>
      Object.hasOwn(applicationRoutes, source.application),
    )
  )
    throw new Error(
      "integrated frontend requires scoped routes for each application",
    );
  return sources;
}

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
  featureFrontends(frontend);
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
  for (const value of frontendOrigins(frontend)) {
    if (origins.has(value)) throw new Error("frontend origins must be unique");
    origins.add(value);
  }
}

export function originAllowed(
  application: string,
  originValue: string,
  requestPath?: string,
): boolean {
  const frontend = frontends.find((entry) =>
    frontendOrigins(entry).includes(originValue),
  );
  if (!frontend) return false;
  if (!frontend.featureFrontends) return frontend.application === application;
  return (
    !!requestPath && grantsFeatureRoute(frontend, requestPath, application)
  );
}

function grantsFeatureRoute(
  frontend: FrontendApplication,
  requestPath: string,
  application?: string,
) {
  const path = requestPath.split("?", 1)[0]!.replace(/^\/v1(?=\/)/, "");
  return [frontend, ...featureFrontends(frontend)].some(
    (source) =>
      (application === undefined || source.application === application) &&
      applicationRoutes[source.application]?.test(path),
  );
}

export function registeredOrigin(
  originValue: string,
  requestPath?: string,
): boolean {
  if (!requestPath) return origins.has(originValue);
  const frontend = frontends.find((entry) =>
    frontendOrigins(entry).includes(originValue),
  );
  return (
    !!frontend &&
    (!frontend.featureFrontends || grantsFeatureRoute(frontend, requestPath))
  );
}
