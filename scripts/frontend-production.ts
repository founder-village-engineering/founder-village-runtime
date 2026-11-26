import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  customOriginFields,
  featureFrontendsSchema,
  frontends,
  originAllowed,
  pagesProjectFields,
  productionOrigins,
  usesOneAliasFormat,
} from "../packages/frontends/index.ts";
import { boundedJson } from "../packages/observability/http.ts";
import { assertNoSymlinkPath } from "./sync-frontend-contracts.ts";

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const exampleProfile = resolve(runtimeRoot, "config/production.example.json");
const profileSchema = z.object({
  environment: z.literal("production"),
  api_domain: z.string(),
  admin_domain: z.string(),
  cloudflare: z.object({
    account_id: z.string(),
    zone_name: z.string(),
    access_team: z.string(),
  }),
  auth: z.object({
    issuer: z.string(),
    jwks_url: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    client_id: z.string(),
    audience: z.string(),
    frontend_client_ids: z.record(z.string(), z.string()).optional(),
  }),
});
type Profile = z.infer<typeof profileSchema>;

const manifestSchema = z
  .object({
    slug: z.string(),
    application: z.string(),
    ...pagesProjectFields,
    ...customOriginFields,
    runtimeApiOrigin: z.string().optional(),
    contractSource: z.string(),
    featureFrontends: featureFrontendsSchema.optional(),
  })
  .refine(usesOneAliasFormat, "use customOrigin or customOrigins");

const apiRoutes: Record<string, ReadonlyArray<readonly [string, string]>> = {
  "founder-village-app": [
    ["founder-village-app", "/v1/members/me"],
    ["founder-village-app", "/v1/food-deliveries/tenants"],
    ["founder-village-team", "/v1/team/tenants"],
  ],
  "founder-village-team": [["founder-village-team", "/v1/team/tenants"]],
};

async function jsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("could not read production profile or frontend manifest");
  }
}

async function readProfile(path: string, plan: boolean): Promise<Profile> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error("could not open a regular production profile file");
  });
  let contents: string;
  try {
    const info = await handle.stat();
    const publicExample = plan && resolve(path) === exampleProfile;
    if (!info.isFile() || (!publicExample && (info.mode & 0o077) !== 0))
      throw new Error(
        "private production profile requires a mode-0600 regular file",
      );
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const profile = profileSchema.safeParse(JSON.parse(contents));
  const topology = profileSchema.parse(await jsonFile(exampleProfile));
  if (
    !profile.success ||
    profile.data.api_domain !== topology.api_domain ||
    profile.data.admin_domain !== topology.admin_domain ||
    profile.data.cloudflare.zone_name !== topology.cloudflare.zone_name
  )
    throw new Error(
      "profile must use the codified production API and admin hosts",
    );
  return profile.data;
}

function browserSettings(profile: Profile, slug: string) {
  const auth = profile.auth;
  for (const endpoint of [
    auth.issuer,
    auth.jwks_url,
    auth.authorization_endpoint,
    auth.token_endpoint,
  ]) {
    const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !url.hostname.includes(".") ||
      /\.(?:fv|test|localhost|invalid|example)$/.test(url.hostname) ||
      /[\s\\]/.test(endpoint)
    )
      throw new Error(
        "production OIDC requires public HTTPS discovery endpoints",
      );
  }
  const clientId = auth.frontend_client_ids?.[slug];
  if (
    !clientId ||
    [clientId, auth.client_id, auth.audience].some(
      (value) => !value || value.length > 256 || /[\s\p{Cc}]/u.test(value),
    ) ||
    new Set([clientId, auth.client_id, auth.audience]).size !== 3
  )
    throw new Error(
      "configure a separate public SPA client, admin client, and API audience",
    );
  return {
    FV_RUNTIME_API_ORIGIN: `https://${profile.api_domain}`,
    FV_OIDC_AUTHORIZATION_ENDPOINT: auth.authorization_endpoint,
    FV_OIDC_TOKEN_ENDPOINT: auth.token_endpoint,
    FV_OIDC_CLIENT_ID: clientId,
    FV_OIDC_AUDIENCE: auth.audience,
  };
}

function request(url: URL | string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
}

function location(response: Response): URL | undefined {
  const value = response.headers.get("location");
  if (
    response.status >= 300 &&
    response.status < 400 &&
    value &&
    URL.canParse(value)
  )
    return new URL(value);
}

async function verifyOidc(
  profile: Profile,
  clientId: string,
  origins: string[],
) {
  const auth = profile.auth;
  const discovery = await request(
    `${auth.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  const metadata = discovery.ok
    ? ((await boundedJson(discovery)) as Record<string, unknown>)
    : undefined;
  if (
    metadata?.issuer !== auth.issuer ||
    metadata.jwks_uri !== auth.jwks_url ||
    metadata.authorization_endpoint !== auth.authorization_endpoint ||
    metadata.token_endpoint !== auth.token_endpoint
  )
    throw new Error("OIDC discovery differs from the production profile");

  const jwks = await request(auth.jwks_url);
  const keyset = z
    .object({
      keys: z.array(
        z.object({
          kty: z.string(),
          use: z.string().optional(),
          alg: z.string().optional(),
        }),
      ),
    })
    .safeParse(jwks.ok ? await boundedJson(jwks) : undefined);
  if (
    !keyset.success ||
    !keyset.data.keys.some(
      ({ kty, use, alg }) =>
        (!use || use === "sig") &&
        ((kty === "RSA" && (!alg || alg === "RS256")) ||
          (kty === "EC" && (!alg || alg === "ES256"))),
    )
  )
    throw new Error("OIDC key set has no compatible signing key");

  await Promise.all(
    origins.map(async (origin) => {
      const redirectUri = `${origin}/auth/callback`;
      const verifier = randomBytes(64).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      const authorization = new URL(auth.authorization_endpoint);
      authorization.search = new URLSearchParams({
        audience: auth.audience,
        client_id: clientId,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        prompt: "none",
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile email",
        state,
      }).toString();
      const authorizationResponse = await request(authorization);
      const callback = location(authorizationResponse);
      await authorizationResponse.body?.cancel();
      if (
        callback?.origin !== origin ||
        callback.pathname !== "/auth/callback" ||
        callback.searchParams.get("state") !== state ||
        callback.searchParams.has("code") ||
        ![
          "login_required",
          "interaction_required",
          "consent_required",
          "account_selection_required",
        ].includes(callback.searchParams.get("error") ?? "")
      )
        throw new Error(
          `OIDC callback registration could not be verified for ${origin}`,
        );

      // Exercise the browser-equivalent simple POST with an invalid synthetic code.
      const exchange = await request(auth.token_endpoint, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: randomBytes(32).toString("base64url"),
          client_id: clientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      const allowedOrigin = exchange.headers.get("access-control-allow-origin");
      const exchangeError =
        exchange.status === 400
          ? ((await boundedJson(exchange, 64_000)) as { error?: string })
          : undefined;
      if (
        (allowedOrigin !== origin && allowedOrigin !== "*") ||
        exchangeError?.error !== "invalid_grant"
      )
        throw new Error(
          `public OIDC token exchange could not be verified for ${origin}`,
        );
    }),
  );
}

async function verifyIngress(
  profile: Profile,
  slug: string,
  origins: string[],
) {
  const team = profile.cloudflare.access_team;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team))
    throw new Error("production Cloudflare Access team is required");
  const admin = await request(`https://${profile.admin_domain}/`);
  const challenge = location(admin);
  await admin.body?.cancel();
  if (
    challenge?.origin !== `https://${team}.cloudflareaccess.com` ||
    !challenge.pathname.startsWith("/cdn-cgi/access/login/")
  )
    throw new Error(
      "public admin did not issue the configured Access challenge",
    );

  const routes = apiRoutes[slug];
  if (!routes) throw new Error("frontend requires registered API probes");
  await Promise.all(
    origins.flatMap((origin) =>
      routes.map(async ([app, path]) => {
        if (!originAllowed(app, origin, path))
          throw new Error("API probe is outside frontend registration");
        const url = `https://${profile.api_domain}${path}`;
        const preflight = await request(url, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "GET",
            "access-control-request-headers":
              "authorization, x-application-id, x-tenant-id",
          },
        });
        const denied = await request(url, {
          headers: { origin, "x-application-id": app },
        });
        await denied.body?.cancel();
        if (
          preflight.status !== 204 ||
          denied.status !== 401 ||
          preflight.headers.get("access-control-allow-origin") !== origin ||
          denied.headers.get("access-control-allow-origin") !== origin
        )
          throw new Error(
            `public API preflight or bearer boundary failed for ${origin} on ${path}`,
          );
      }),
    ),
  );
}

function run(
  command: string,
  args: string[],
  env = process.env,
): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      cwd: runtimeRoot,
    });
    child.once("error", () => reject(new Error(`could not start ${command}`)));
    child.once("exit", (code) =>
      code === 0 ? accept() : reject(new Error(`${command} failed`)),
    );
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: "string" },
      config: { type: "string" },
      "frontends-root": { type: "string" },
      revision: { type: "string" },
    },
  });
  const [mode] = positionals;
  const {
    app,
    config,
    "frontends-root": frontendsRoot = resolve(
      runtimeRoot,
      "../founder-village-frontends",
    ),
    revision,
  } = values;
  const frontend = frontends.find((entry) => entry.id === app);
  if (
    !frontend ||
    !config ||
    positionals.length !== 1 ||
    !mode ||
    !["plan", "provision", "deploy", "verify"].includes(mode)
  )
    throw new Error(
      "usage: frontend:production <plan|provision|deploy|verify> --app <slug> --config <profile> [--frontends-root <path>] [--revision <sha>]",
    );

  const profile = await readProfile(config, mode === "plan");
  const root = resolve(frontendsRoot);
  const path = resolve(root, frontend.frontendPath, "founder-village-app.json");
  await assertNoSymlinkPath(root, path);
  const manifest = manifestSchema.safeParse(await jsonFile(path));
  const origins = productionOrigins(frontend);
  const apiOrigin = `https://${profile.api_domain}`;
  if (
    !manifest.success ||
    manifest.data.slug !== frontend.id ||
    manifest.data.application !== frontend.application ||
    manifest.data.pagesProject !== frontend.pagesProject ||
    manifest.data.contractSource !== frontend.contractSource ||
    JSON.stringify(manifest.data.featureFrontends ?? []) !==
      JSON.stringify(frontend.featureFrontends ?? []) ||
    JSON.stringify(productionOrigins(manifest.data)) !==
      JSON.stringify(origins) ||
    (manifest.data.runtimeApiOrigin ??
      (frontend.id === "founder-village-app" ? "" : apiOrigin)) !== apiOrigin
  )
    throw new Error(
      "frontend manifest and production runtime registration differ",
    );

  if (mode === "plan") {
    console.log(
      JSON.stringify(
        {
          app: frontend.id,
          pagesProject: frontend.pagesProject,
          additionalPagesProjects: frontend.additionalPagesProjects ?? [],
          apiOrigin,
          adminCallback: `https://${profile.admin_domain}/auth/callback`,
          grantType: "authorization_code",
          tokenEndpointAuthMethod: "none",
          codeChallengeMethod: "S256",
          redirectUris: origins.map((origin) => `${origin}/auth/callback`),
          tokenExchangeOrigins: origins,
          publicClientConfigured: Boolean(
            profile.auth.frontend_client_ids?.[frontend.id],
          ),
        },
        null,
        2,
      ),
    );
    return;
  }

  const env = { ...process.env };
  if (mode === "provision" || mode === "deploy") {
    const id = profile.cloudflare.account_id;
    if (
      !/^[0-9a-f]{32}$/i.test(id) ||
      (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== id)
    )
      throw new Error(
        "Pages account must match the private production profile",
      );
    env.CLOUDFLARE_ACCOUNT_ID = id;
  }
  if (mode !== "provision") {
    if (!revision || !/^[a-f0-9]{40}$/.test(revision))
      throw new Error("provide the signed runtime revision with --revision");
    const settings = browserSettings(profile, frontend.id);
    Object.assign(env, settings, { FV_RUNTIME_REVISION: revision });
    const publicChecks = { ...process.env };
    delete publicChecks.CLOUDFLARE_API_TOKEN;
    await run(
      "npm",
      [
        "run",
        "frontend-contracts:check",
        "--",
        "--frontends-root",
        root,
        "--app",
        frontend.id,
      ],
      publicChecks,
    );
    await run(process.execPath, ["scripts/probe.ts"], {
      ...publicChecks,
      PUBLIC_API_URL: apiOrigin,
      PUBLIC_API_REVISION: revision,
    });
    await Promise.all([
      verifyIngress(profile, frontend.id, origins),
      verifyOidc(profile, settings.FV_OIDC_CLIENT_ID, origins),
    ]);
    console.log(
      "Verified production API, admin Access challenge, and public OIDC callbacks and token CORS.",
    );
  }
  await run(
    "npm",
    [
      "--prefix",
      root,
      "run",
      "pages",
      "--",
      mode,
      "--app",
      frontend.id,
      ...(mode === "verify" ? ["--production"] : []),
    ],
    env,
  );
}

try {
  await main();
} catch (error) {
  // Provider bodies and private profile values must not reach the release log.
  console.error(
    error instanceof SyntaxError
      ? "invalid response or configuration JSON"
      : (error as Error).message,
  );
  process.exitCode = 1;
}
