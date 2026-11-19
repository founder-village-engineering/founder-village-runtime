# Backend onboarding

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

## Database

Use a distinct application/database/Hasura source by default. Reuse an existing application only for an explicit shared data boundary. In that case, keep each frontend's contracts and origin registration separate while placing shared entities and feature tables in the existing application's additive migrations.

The application, database, and Hasura source retain one exact identity even when several frontends map to them. A frontend slug is not automatically a database name. Add only new numbered SQL migrations. Enable and force row-level security for tenant data. Grant the minimum API, worker, and Hasura privileges; never grant public application-database access.

For mutation APIs, accept an idempotency key, persist the key beside the tenant-scoped request, return the original result for an exact retry, and reject reuse with different input. Compute price and authorization server-side.

## API and access

Require the verified bearer token, registered `x-application-id`, and `x-tenant-id`. Resolve actor and membership through the runtime auth boundary. A frontend registration is not authentication and an Origin header is not authorization.

`config/frontends.json` is the browser-origin allowlist. Keep origins exact. Do not use wildcard domains or suffix matching, do not reflect arbitrary preflight origins, and do not enable credentialed CORS for bearer-token calls.

## Contracts

Canonical contracts must be browser-safe TypeScript and Zod. Do not import server credentials, Node-only modules, database clients, or runtime implementation code into a frontend-contract directory. Validate request and response shapes at the API and browser boundaries.

## Hasura

Keep Hasura private. Regenerate metadata with `npm run hasura:generate`, verify consistency, and expose application behavior through the authenticated runtime API unless an existing scoped relay is intentionally extended.
