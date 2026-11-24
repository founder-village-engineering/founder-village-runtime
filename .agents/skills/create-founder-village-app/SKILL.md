---
name: create-founder-village-app
description: Create or complete a Founder Village application across the founder-village-frontends and founder-village-runtime repositories. Use when adding a database-backed frontend, its runtime namespace and exact-origin allowlist, runtime-owned TypeScript contracts, or its shared static Cloudflare Pages release path.
---

# Create Founder Village App

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Build a complete, repeatable vertical slice. The runtime owns databases, API behavior, access boundaries, frontend registrations, and canonical TypeScript contracts. The frontend repository owns static React apps, generated contract snapshots, shared browser API/auth code, and shared Cloudflare Pages Direct Upload tooling.

Never improvise a third deployment path or publish a frontend as a Worker. Every frontend is a static Pages project, and Pages Functions and `_worker.*` are forbidden.

## 1. Establish scope

Read all applicable `AGENTS.md` files before editing. Run:

```sh
python3 .agents/skills/create-founder-village-app/scripts/audit_workspace.py \
  --runtime . \
  --frontends ../founder-village-frontends
```

Confirm the frontend slug, title, owner, purpose, one-label `.fv` hostname, unused local port, Pages project, and its runtime data boundary. A new product defaults to an application/database/Hasura source named for the slug. Map a frontend to an existing application only when the products share an approved data boundary.

Copy `assets/project.example.json` into an ignored path such as `founder-village-frontends/.state/new-apps/<slug>.json` and edit the copy. Runtime onboarding deliberately requires the manifest to remain inside the frontend repository. Keep:

- an optional `customOrigin` for a requested one-label HTTPS alias under `foundervillage.xyz`, registered with Pages, DNS and OIDC;
- `productionOrigin` equal to `https://<pagesProject>.pages.dev`;
- `contractSource` equal to `packages/frontend-contracts/<slug>`;
- the frontend slug, application mapping, database/Hasura source, frontend path, and generated contract ownership explicit.

For a frontend that uses other applications, list their registered standalone frontend IDs in `featureFrontends`. Define a runtime route group for the primary application and for each referenced application. The primary app owns its Members and Food Deliveries contracts and imports the separate Team contracts under `features/founder-village-team/`.

See `references/workspace-map.md` for ownership and `references/verification-and-release.md` for proof boundaries.

## 2. Plan both repositories

From the frontend repository:

```sh
npx tsx scripts/scaffold-app.ts --manifest /absolute/path/project.json --plan
```

From the runtime repository:

```sh
npm run frontend:add -- \
  --manifest /absolute/path/project.json \
  --frontends-root /absolute/path/founder-village-frontends \
  --plan
```

Review both plans. Resolve collisions before applying. Do not edit registries by guesswork when the onboarding commands can validate the same manifest.

## 3. Scaffold and register

Apply the frontend scaffold first, then runtime registration:

```sh
# founder-village-frontends
npx tsx scripts/scaffold-app.ts --manifest /absolute/path/project.json --apply

# founder-village-runtime
npm run frontend:add -- \
  --manifest /absolute/path/project.json \
  --frontends-root /absolute/path/founder-village-frontends \
  --apply
```

The runtime command creates a missing application or validates and reuses the manifest's existing shared application. It registers exact frontend origins, the local domain, and the frontend-specific contract source, then regenerates metadata and copies contracts.

Follow `references/backend-onboarding.md` to implement additive SQL, Hasura metadata, API routes, tenant/member authorization, idempotency, and tests. Prices, privileges, actor identity, and tenant access remain server-controlled.

## 4. Own and synchronize contracts

Author browser-safe Zod schemas and inferred TypeScript types only in:

```text
founder-village-runtime/packages/frontend-contracts/<slug>/
```

Never hand-edit `apps/<slug>/src/generated/contracts/`. Synchronize after every canonical contract change:

```sh
# one shot
npm run frontend-contracts:sync -- \
  --frontends-root ../founder-village-frontends

# only the requested frontend and its contract dependencies
npm run frontend-contracts:sync -- \
  --frontends-root ../founder-village-frontends --app <slug>

# during active runtime work
npm run frontend-contracts:watch -- \
  --frontends-root ../founder-village-frontends
```

The copy contains a source path, file list, and SHA-256 marker. Runtime pushes also run the cross-repository sync workflow, which opens a frontend pull request when the configured token is available. Frontend CI refuses corrupted or locally stale snapshots.

## 5. Build the frontend

Use the shared `@founder-village/frontend-platform` package for runtime config, OIDC authorization-code-with-PKCE, bearer calls, application/tenant headers, timeouts, and sanitized errors. Do not store bearer tokens in local storage or accept arbitrary runtime origins from query parameters.

Keep the app responsive, keyboard accessible, and useful on phone and desktop. Use the runtime-owned generated schemas at every network boundary. See `references/frontend-and-pages.md`.

## 6. Verify locally

Run the app-specific checks first, then the repository checks:

```sh
# runtime
npm run frontend-contracts:check -- --frontends-root ../founder-village-frontends
npm run check
bin/fv up
npm run test:integration

# frontends
npm run contracts:workspace
npm run check
npm run test:e2e
npm run pages -- plan --app <slug>

# cross-repository invariant audit
python3 .agents/skills/create-founder-village-app/scripts/check_app.py \
  --runtime . \
  --frontends ../founder-village-frontends \
  --app <slug>
```

Use the proportional Rust, backup/restore, security, and browser checks listed in `references/verification-and-release.md` when the change reaches those boundaries.

## 7. Provision and deploy Pages explicitly

Do not invent public API or OIDC values. Before deployment, register the exact `https://<pagesProject>.pages.dev/auth/callback` URI in the existing public OIDC client, allow the Pages origin to call the token endpoint, and verify that its access-token audience equals the runtime `OIDC_AUDIENCE`. Keep administrator assurance and frontend API access as separate claims even if they use the same provider.

Provisioning and deployment require Cloudflare credentials and real public runtime configuration:

```sh
# founder-village-frontends
npm run pages -- provision --app <slug>

FV_RUNTIME_API_ORIGIN=https://... \
FV_OIDC_AUTHORIZATION_ENDPOINT=https://... \
FV_OIDC_TOKEN_ENDPOINT=https://... \
FV_OIDC_CLIENT_ID=... \
npm run pages -- deploy --app <slug>

npm run pages -- verify --app <slug>
```

The shared release code builds the app, rejects Worker/Functions output and placeholder production values, records an artifact digest, deploys with `wrangler pages deploy`, and verifies the exact `pages.dev` origin. The manual GitHub workflow invokes this same code.

Report local, authenticated, provider, deployed, and backup proof separately. A successful build is not a deployment, a Pages upload is not backend readiness, and desktop proof is not mobile proof.

## 8. Keep the skill current

When the onboarding contract changes, update this repository-owned skill, its references, scripts, and example manifest in the same change. Validate it with:

```sh
python3 /Users/zernach/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/create-founder-village-app
python3 -m unittest discover \
  .agents/skills/create-founder-village-app/tests
```

The installed copy at `~/.codex/skills/create-founder-village-app` should be synchronized only after the repository-owned copy passes validation.
