# Founder Village Runtime

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

Each database has its own API, worker, Hasura, migration, and monitoring login. `PUBLIC` cannot connect to application databases. Shared privilege groups cannot log in. `fv_control` and `fv_hasura` are internal control-plane and Hasura metadata databases. Staging and production use separate hosts and credentials; application database names stay the same in each environment.

## Local startup

Requires Docker, Rust 1.90.0, and Node 24.22.0. The CLI never removes data volumes during normal shutdown. Local resources use the separate `fv-local` Compose project.

```sh
npm ci
bin/fv init
bin/fv up
npm run build
```

Start these in separate terminals:

```sh
bin/dev api
bin/dev admin
bin/dev workers
```

To execute console operations, also run `bin/fv ops` for the constrained host runner and `bin/dev domain-worker` for domain/job/audit operations. Provider operations require the configured private catalog; the console preserves queued work across refreshes.

Open **http://127.0.0.1:43802** and choose **Open local console**. This synthetic owner login is restricted to the local environment and a loopback connection. The API uses http://127.0.0.1:43801. Hasura's administration endpoint is loopback-only on port 43803; its secret stays in the private generated catalog. No real provider account is needed for local verification.

```sh
bin/fv doctor
bin/fv down
```

For UI hot reload, run `npm run dev -w services/admin-web` and set the local private catalog's `ADMIN_ORIGIN` to `http://127.0.0.1:43800` before starting the admin backend. The built console uses port 43802. Do not reuse development credentials outside local fixtures.

## API and tenant access

API requests carry a verified OIDC bearer token, `x-application-id`, and `x-tenant-id`. The application header defaults to `founder-village` for the initial client. Unknown application IDs are rejected; membership is checked inside the selected database. Clients cannot supply trusted Hasura roles or actor identities.

`POST /records` accepts `{ "content": "example", "embedding": [1, 0.1, 0.2] }` and a UUID `idempotency-key`. It atomically writes a record and an outbox job. Workers process the durable job once at the effect boundary despite repeated delivery. `GET /records`, `POST /search`, the scoped `/graphql` relay, and signed file URL endpoints share the same membership boundary.

The initial vector model is deliberately named `synthetic-v1` with three dimensions for executable platform fixtures. A real embedding model requires an additive application migration and a re-embedding/versioning decision. The runtime does not silently send data to an AI provider.

A scoped Hasura query for the cafe is:

```graphql
{ founder_cafe { app_records { id content result } } }
```

Select `founder-cafe` in the application header and use a cafe membership. A village token cannot gain cafe access by changing headers. There is no public Hasura admin proxy.

## Verification

```sh
npm run check
npm run security:scan
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
npm run test:integration
npx playwright install chromium webkit
npm run test:browser
bin/fv backup capture
bin/fv backup restore-drill
```

`npm run test:integration` uses the real isolated PostgreSQL/pgvector, Hasura, and RabbitMQ stack. Browser checks use the built console at desktop and mobile sizes. The backup drill starts a separate PostgreSQL recovery container without application workers or production data mounts. Local evidence is written under `.state/evidence/`, `.state/qa/`, and `.state/local/restore-receipt.json`.

`npm run release:verify` is the explicit expanded verification workflow. Routine deployment does not invoke this whole collection automatically. See [implementation status](IMPLEMENTATION.md) for executed evidence and live prerequisites.

## Operations and production

- [Architecture and decisions](docs/adr/0001-runtime.md)
- [Security boundaries](docs/SECURITY.md)
- [Provisioning and first launch](docs/runbooks/PROVISIONING.md)
- [Release and rollback](docs/runbooks/DEPLOYMENT.md)
- [Backup and disaster recovery](docs/runbooks/RECOVERY.md)
- [Application onboarding](docs/runbooks/APPLICATIONS.md)
- [Incident response](docs/runbooks/INCIDENTS.md)

Production configuration is explicit and fails closed when required inputs are absent. Account/zone IDs, administrator identity, provider credentials, immutable storage custody, actual restore times, and deployment status are never invented by local fixtures. No Git publication or production deployment is implied by building this repository.
