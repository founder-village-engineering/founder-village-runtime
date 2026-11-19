# Workspace map

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

## Runtime-owned

- `config/applications.json`: exact database and Hasura source inventory.
- `config/frontends.json`: frontend-to-application mapping and exact allowed origins.
- `config/local-domains.json`: one-label local HTTPS routes.
- `database/applications/<application>/`: additive, checksummed migrations.
- `hasura/applications/<application>/`: private Hasura metadata source.
- `packages/frontend-contracts/<frontend>/`: canonical browser-safe schemas and types.
- `services/api/`: authenticated routes and exact-origin CORS enforcement.
- `scripts/onboard-frontend.ts`: manifest-driven runtime registration.
- `scripts/sync-frontend-contracts.ts`: guarded generated-copy synchronizer.

## Frontend-owned

- `apps/<frontend>/`: static React application and manifest.
- `apps/<frontend>/src/generated/contracts/`: generated runtime contract copy; never hand-edit.
- `packages/frontend-platform/`: shared config, OIDC PKCE, and API transport.
- `templates/app/`: safe scaffold source for future apps.
- `scripts/scaffold-app.ts`: manifest-driven frontend scaffold.
- `scripts/pages.ts`: the only Pages provision/deploy/verify implementation.

The app manifest is the handoff between repositories. A frontend may map to an existing application only when that is an explicit product and data-boundary decision. Otherwise use a separate database.
