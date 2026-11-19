# ADR 0001: Runtime and trust boundaries

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Accepted implementation baseline, 2026-11-16.

A Rust workspace owns deterministic rendering, Hetzner resource convergence, host setup, deployment, backup orchestration, and WireGuard. A locked Node/TypeScript project owns the public API, admin backend, browser console, durable workers, domain adapter, monitoring, and automation scripts. Frontend bundles and compiled runtime files are generated artifacts.

One PostgreSQL cluster per environment contains separate application databases. Names and source mappings come from `config/applications.json`; they are not caller-selected connection strings. Separate per-application login credentials plus `CONNECT` restrictions protect cross-database access. PostgreSQL RLS protects tenant records inside each database. Hasura sources have separate JWT roles, permissions, and GraphQL namespaces to prevent root-field collisions.

The sample shared schema is a platform acceptance workflow. Application-specific SQL belongs under `database/applications/<application>/`. Shared migrations apply first, then that application's checksummed migrations. Hasura table metadata can be specialized under `hasura/applications/<application>/tables.json`; regeneration is explicit and reviewed.

The admin browser and TypeScript backend have no Docker socket or root shell endpoint. Operations are typed and durable. In production, a fresh MFA identity token signs an operation-specific nonce through OIDC; runners independently verify that proof, current grants, and one-time consumption before acting. Local synthetic mode is a different, explicitly selected environment. The host CLI is an operating-system administrative boundary and records its delegated service identity.

RabbitMQ provides durable transport; PostgreSQL outbox/job-effect tables provide transaction intent, provenance, retry state, and deduplication. Queues are application-scoped. Schedules use a transaction-scoped leader lock and coalesce missed intervals. External side effects require their own provider idempotency/reconciliation.

Cloudflare Tunnel fronts an internal Caddy router. Stateful services remain private; host diagnostic ports bind to loopback. Browser admin access additionally requires Cloudflare Access and server-side authorization. WireGuard is split-tunnel management access, not a workstation default-route change.

The initial topology is one host per remote environment. Application blue/green deployment does not provide database or host HA. PostgreSQL physical PITR is cluster-wide; individual application recovery requires an isolated cluster restore followed by a reviewed logical export/import.
