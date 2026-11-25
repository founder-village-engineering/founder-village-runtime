# Founder Village Runtime

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Rust runtime control, TypeScript API/admin/workers, PostgreSQL + pgvector, private Hasura, RabbitMQ, deployment automation, encrypted recovery, domain management, and WireGuard device profiles.

Authored application and automation sources are **TypeScript only** (`.ts`/`.tsx`). Runtime control is Rust; minimal host/container entrypoints are shell. Generated compiler/browser artifacts live in ignored build directories.

## Application databases

`config/applications.json` owns the application inventory. Every environment has these **separate PostgreSQL databases and matching Hasura source names**:

| Application | PostgreSQL database | Hasura source | GraphQL namespace |
| --- | --- | --- | --- |
| Founder Village | `founder-village` | `founder-village` | `founder_village` |
| Founder Farm | `founder-farm` | `founder-farm` | `founder_farm` |
| Founder Cafe | `founder-cafe` | `founder-cafe` | `founder_cafe` |
| Founder Residences | `founder-residences` | `founder-residences` | `founder_residences` |
| Founder Village app | `founder-village-app` | `founder-village-app` | `founder_village_app` |
| Founder Village Team | `founder-village-team` | `founder-village-team` | `founder_village_team` |

Each database has its own API, worker, Hasura, migration, and monitoring login. `PUBLIC` cannot connect to application databases. Shared privilege groups cannot log in. `fv_control` and `fv_hasura` are internal control-plane and Hasura metadata databases. Staging and production use separate hosts and credentials; application database names stay the same in each environment.

The two product apps are Founder Village and Founder Village Team. `founder-village-app` owns the member directory, profiles, premium checkout, founder companies, expenses, and food deliveries. A delivery creates its matching posted expense atomically. Internal workspaces stay in `founder-village-team`, with the same Team permissions whether accessed from the Team frontend or the main app. Existing installations should follow the [consolidation runbook](docs/runbooks/CONSOLIDATE_APP.md) before promoting a release that uses the new database.

`config/frontends.json` is the canonical browser frontend registry. It maps each static Cloudflare Pages project to one application and its exact production/local origins. Runtime-owned TypeScript contracts live under `packages/frontend-contracts/<frontend>/` and are copied, with a checksummed ownership marker, into the matching frontend by `npm run frontend-contracts:sync`. See [application onboarding](docs/runbooks/APPLICATIONS.md).

## Local startup

Requires Docker, Rust 1.90.0, and Node 24.22.0. The CLI never removes data volumes during normal shutdown. Local resources use the separate `fv-local` Compose project.

```sh
npm ci
bin/fv local-edge setup
npm start
```

`npm start` (or `bin/fv start`) opens an arrow-key menu for local servers, data-stack startup/migrations, health checks, shutdown, routine checks, backups, restore drills, and release preparation/deployment/rollback. Use **Up/Down** or **j/k**, **Enter** to run, and **Esc**, **q**, or **Ctrl-C** to exit. Opening or cancelling the menu does not start services.

Choose **Start local servers** to build the console, initialize the private local catalog, start PostgreSQL/RabbitMQ/Hasura, apply migrations and synthetic seeds, and launch the API, admin, workers, monitor, domain worker, and constrained Rust operation runner together. The command stays in the foreground and waits for API/admin/worker readiness. **Ctrl-C** stops only this session's host processes; the `fv-local` data containers and volumes remain available. Logs are private files under `.state/local/start/`. An occupied application port or another local start is reported without terminating existing services.

Direct shortcuts also work without a menu:

```sh
npm start -- local       # start the complete local runtime
npm start -- --list      # list available shortcuts without running anything
bin/fv start doctor
bin/fv start check       # npm run check + Rust Clippy
```

Without a terminal, bare `npm start` prints the shortcut list and exits. Release prepare/deploy menu actions prompt for exact immutable inputs; scripts should use the existing `bin/fv release ...` commands with explicit arguments. Select another configuration with `npm start -- --config config/staging.private.json`. The menu shows the environment and project; release operations execute on the current host with the existing gates. The `local` shortcut requires `fv-local`. Full release verification uses local fixtures and stays an explicit action.

For separate service terminals, the existing commands remain available:

```sh
bin/fv up
npm run build
bin/dev api
bin/dev admin
bin/dev workers
```

To execute console operations, also run `bin/fv ops` for the constrained host runner and `bin/dev domain-worker` for domain/job/audit operations. Provider operations require the configured private catalog; the console preserves queued work across refreshes.

Run `bin/fv admin-login --open` to sign in to **https://admin.fv**. The CLI issues a single-use link that expires in five minutes. Codes and sessions are stored as hashes; the browser removes the sign-in fragment before requesting protected content. The API uses **https://api.fv**, forwarding to http://127.0.0.1:43801. Other published routes are **https://workers.fv** and **https://monitor.fv**. All names have exactly one label before `.fv`; nested names are rejected. Add future services to `config/local-domains.json`. See [local DNS and HTTPS](docs/runbooks/LOCAL_DOMAINS.md).

**https://api-dev.fv** is an alias of the existing local API and shares its data. Hasura has no published hostname: root administrators inspect all registered sources through the **Hasura** page inside `admin.fv`. The server supplies its private credential; browser requests use the existing authenticated session and CSRF protection. Inspection is read-only; schema and metadata changes use versioned migrations and the constrained operation catalog.

The one-time `local-edge setup` command starts the dedicated `fv-local` DNS/TLS containers and uses macOS administrator authentication to install a scoped `.fv` resolver and trust this runtime's local CA in your login keychain. The edge listens on IPv6 loopback `[::1]:443`, preserving Archlife's existing IPv4 HTTPS listener. Subsequent local starts bring up the edge automatically. No public DNS or provider account is needed. Direct loopback URLs remain available for diagnostics and fixtures; Hasura still requires its private admin secret.

```sh
bin/fv doctor
bin/fv local-edge doctor
bin/fv down
```

Vite asset development uses `npm run dev -w services/admin-web` on port 43800. Verify authenticated journeys through the built console at `https://admin.fv`; its backend listens on port 43802. Browser test fixtures explicitly enable synthetic login in their isolated test process. Normal `start` and `bin/dev` never enable it. Do not reuse development credentials outside local fixtures.

## API and tenant access

API requests carry a verified OIDC bearer token, `x-application-id`, and `x-tenant-id`. The application header defaults to `founder-village` for the initial client. Unknown application IDs are rejected; membership is checked inside the selected database. Clients cannot supply trusted Hasura roles or actor identities.

Existing unversioned routes remain supported. Clients that need a contract pinned across breaking backend changes can use the equivalent `/v1/...` routes. `/api/versions` publishes supported versions and lifecycle state; `/openapi.json` and `/v1/openapi.json` publish the unversioned and explicit v1 contracts. A new major never silently repoints the unversioned surface. See [public API versioning](docs/runbooks/API_VERSIONING.md).

`POST /records` accepts `{ "content": "example", "embedding": [1, 0.1, 0.2] }` and a UUID `idempotency-key`. It atomically writes a record and an outbox job. Workers process the durable job once at the effect boundary despite repeated delivery. `GET /records`, `POST /search`, the scoped `/graphql` relay, and signed file URL endpoints share the same membership boundary.

The initial vector model is deliberately named `synthetic-v1` with three dimensions for executable platform fixtures. A real embedding model requires an additive application migration and a re-embedding/versioning decision. The runtime does not silently send data to an AI provider.

A scoped Hasura query for the cafe is:

```graphql
{ founder_cafe { app_records { id content result } } }
```

Select `founder-cafe` in the application header and use a cafe membership. A village token cannot gain cafe access by changing headers. There is no public Hasura admin proxy.

## Verification

Install [Gitleaks](https://github.com/gitleaks/gitleaks#getting-started) for the secret scans. In a checkout without custom Git hooks, enable the tracked pre-commit hook with `git config --local core.hooksPath .githooks`. If you already use a pre-commit hook, add `node scripts/security-scan.ts --staged` to it. See the [public repository security skill](.agents/skills/public-repo-security/SKILL.md) for review and incident steps.

```sh
npm run check
npm run security:scan
npm run security:scan -- --history
npm run security:admin  # local HTTPS red/blue exercise; runtime must be running
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
npm run test:integration
npx playwright install chromium webkit
npm run test:browser
npm run test:browser:https # use the running canonical local HTTPS admin
bin/fv backup capture
bin/fv backup restore-drill
```

`npm run test:integration` uses the real isolated PostgreSQL/pgvector, Hasura, and RabbitMQ stack. Browser checks use the built console at desktop and mobile sizes. The backup drill starts a separate PostgreSQL recovery container without application workers or production data mounts. Local evidence is written under `.state/evidence/`, `.state/qa/`, and `.state/local/restore-receipt.json`.

`npm run release:verify` is the explicit expanded verification workflow. Routine deployment does not invoke this whole collection automatically. See [implementation status](IMPLEMENTATION.md) for executed evidence and live prerequisites.

## Operations and production

The production profile targets a Helsinki CAX11 on Ubuntu 26.04 ARM64. Tagged releases produce one signed AMD64/ARM64 image index and separate native CLI bundles. The production runbook connects the runtime API, admin, and operator SSH to the Pages app and its two apex domains.

- [Architecture and decisions](docs/adr/0001-runtime.md)
- [Security boundaries](docs/SECURITY.md)
- [Administrator red/blue exercises](docs/runbooks/ADMIN_SECURITY.md)
- [Founder Village production](docs/runbooks/PRODUCTION.md)
- [Provisioning and first launch](docs/runbooks/PROVISIONING.md)
- [Release and rollback](docs/runbooks/DEPLOYMENT.md)
- [Backup and disaster recovery](docs/runbooks/RECOVERY.md)
- [Application onboarding](docs/runbooks/APPLICATIONS.md)
- [Incident response](docs/runbooks/INCIDENTS.md)

Production configuration is explicit and fails closed when required inputs are absent. Account/zone IDs, administrator identity, provider credentials, immutable storage custody, actual restore times, and deployment status are never invented by local fixtures. No Git publication or production deployment is implied by building this repository.
