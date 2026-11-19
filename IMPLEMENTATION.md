# Implementation and verification status

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

The runtime is codified in this repository. Live infrastructure activation is separate from local engineering proof. No commit, push, production deployment, real notification, or provider credential creation was performed during implementation.

## Implemented paths

| Area | Code and behavior |
| --- | --- |
| Rust control plane | `crates/fv-cli`, `fv-config`, `fv-provider`, `fv-host`, `fv-ops`; `bin/fv` provides validated config, convergence, provider plan/apply/status, diagnostics, releases, backups, device enrollment/revocation, and a constrained operation runner. |
| VM/host | Hetzner ownership labels, network/firewall/server convergence, narrow SSH bootstrap, Ed25519-only operator input, cloud-init hardening, verified tool installation, Docker forwarding policy, owned-host guard, systemd definitions, and signed remote bootstrap. |
| Four applications | `config/applications.json` defines `founder-village`, `founder-farm`, `founder-cafe`, and `founder-residences`. Each has a separate PostgreSQL database and identically named Hasura source, independent login roles, tenant membership, and migration state. |
| Database/Hasura | pgvector, forced tenant RLS, denied cross-application `CONNECT`, checksummed migrations, source-specific GraphQL roles/namespaces, metadata consistency checks, and application onboarding/generation. |
| API/contracts | Runtime validation, schema-derived OpenAPI, verified OIDC, request IDs, bounded responses, idempotent create/outbox transaction, tenant records/vector search, scoped GraphQL relay, and private signed file URL adapter. |
| Jobs | Confirmed RabbitMQ delivery, manual acknowledgements, per-application queues, provenance checks, deduplicated effects, bounded retry/dead state, scheduler leader lock, missed-run coalescing, and staged broker upgrades without volume deletion. |
| Admin | React/TypeScript console and TypeScript backend, local synthetic entry, production MFA/Access verification, short hashed sessions, CSRF/origin checks, explicit action/application grants, filtered delegated views, durable operations, and one-time operation-bound authorization. |
| Privileged operations | Root-owned administrator allowlist plus independently verified fresh MFA nonce; rechecked grants/scope and one-time consumption prevent row edits or state resets from impersonating/replaying a production operation. |
| Cloudflare | Locked `cf` dependency, executable hash verification, scoped token adapter, managed-name checks, pagination, canonical before/after fingerprints, drift detection, delete postconditions, and account/Tunnel/Access bootstrap code. |
| WireGuard | Client-local key generation/export, private retry-stable profiles, public-key enrollment, unique peer addresses, expiry/revocation, persistent reconciliation, and Linux interface application. No workstation routes are activated by profile generation. |
| Recovery | Encrypted pgBackRest and WAL archiving; authenticated database/settings inventory; configuration/secret escrow; exact artifact verification; immutable offsite replication; isolated named-point PITR with captured PostgreSQL settings and per-database validation. |
| Observability/security | Metadata-only logs/HTTP spans, Prometheus-compatible metrics, optional bounded OTLP export, namespace/capacity/backup monitoring, independent audit checkpoints, external HTTPS/TLS probe, dependency/secret checks, and incident/recovery runbooks. |
| Delivery | Locked artifacts/tool hashes/images/actions; reusable CI; signed image/runtime/source manifest; SBOM/vulnerability gate; separate staging/production promotion; candidate checks, preserved color artifacts, routing rollback, and worker handover. |

All authored application/automation code is `.ts`/`.tsx`; host control is Rust with small shell entrypoints. Generated JavaScript and vendored dependencies are ignored build artifacts.

## Executed local evidence

The isolated Docker project is `fv-local`. Archlife containers, databases, secrets, and worktrees were not modified.

- TypeScript type checks, unit/security tests, production compilation, and the console build pass.
- Fourteen real integration checks cover migrations, authenticated persistence/idempotency, tenant RLS, four application databases, cross-database login denial, unroutable outbox rollback, real RabbitMQ delivery, duplicate-effect suppression, vector search, real Hasura relay/source denial, session/CSRF controls, operation tamper/replay denial, delegated-dashboard filtering and grant-escalation denial, immutable audit denial, and revocation.
- Desktop and mobile browser journeys pass against the built console; screenshots are under `.state/qa/`.
- Rust formatting, Clippy with warnings denied, and workspace tests pass. ShellCheck and Actionlint check the authored shell/workflows.
- Node production dependency audit and Rust advisory audit report no known vulnerabilities at the recorded local check. These are point-in-time dependency results, not a security certification.
- The final local ARM64 application image passes the pinned Trivy scan with zero HIGH/CRITICAL findings. The runtime uses a digest-pinned distroless Debian 13 base and the verified Node binary, without a shell or npm. Both API colors, admin and workers reach healthy state; both proxy routes answer readiness; the packaged Cloudflare CLI runs without provider requests. Other service images and the hosted AMD64 release remain separate verification layers.
- The owned RabbitMQ fixture was upgraded from 4.1 through the pinned 4.2 intermediate to 4.3.7 with its volume preserved.
- Physical backup and named-point PITR complete in an isolated recovery container, validate every registered application database, and record observed timing and replay LSN. Recovery configuration follows settings authenticated with the backup. The drill explicitly does not claim clean-host recovery.
- The actual Rust operation runner executed a queued local operation after checking its bound assertion; local identity mode is synthetic and does not establish real-provider MFA proof.
- WireGuard profile generation rejects addresses outside the configured management network, preserves the private key on retry, writes mode `0600`, and exports only the management gateway route. The synthetic peer was revoked afterward; no interface or workstation routes were activated.

Detailed private receipts are under `.state/evidence/` and `.state/local/`. The checked-in [local verification summary](docs/evidence/local-verification.json) records the final source fingerprint and available receipt summaries without credentials or data payloads.

## External activation and operational proof

The following remain unexecuted and cannot be inferred from local tests:

- Real Hetzner allocation, fresh Linux host convergence/ownership, IPv4/IPv6 exposure, and provider-console recovery.
- Actual account/zone adoption, DNS/Tunnel/Access configuration, certificate behavior, `cf` provider requests, and identity-provider MFA/nonce/auth-time compatibility.
- Real administrator sign-in, signed artifact publication and hosted CI, configured GitHub environment protections/deploy runner, and a serving production blue/green cutover/rollback.
- Physical WireGuard device import, recent real handshake, intended private SSH access, and actual revocation/expiry on a Linux interface.
- S3 signed uploads/downloads, storage quotas/lifecycle policy selected for real applications, provider encryption/retention-lock/deletion behavior, independent account/key custody, offsite immutable replication, and independently readable audit archives.
- Actual provider alert delivery, sustained workload/capacity budgets, measured production RPO/RTO, and a monthly clean-VM disaster-recovery exercise.

The single-host topology is not HA. Shared API/worker services are trusted processes holding their configured application credentials; database separation does not itself isolate a compromised shared process. File storage and business data lifecycle rules require application/provider policy before real data is introduced. The sample three-dimensional vector workflow is synthetic, not a selected production embedding model. Legal/data-classification/provider approvals remain organizational decisions.

These gaps are stated explicitly; no fake domains, approval records, successful provider deliveries, or deployment receipts are manufactured. Follow the runbooks with the actual environment's authorized accounts and credentials.
