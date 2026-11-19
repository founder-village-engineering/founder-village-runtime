# End-to-end hardening review

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Review date: 2026-11-17. Scope: application API, administrator console, PostgreSQL/Hasura boundaries, broker workers, privileged operations, host execution, configuration, deployment and recovery. Existing unrelated staged and unstaged work is preserved. No production deployment or provider mutation is part of this review.

## Administrator red/blue follow-up

The authenticated local HTTPS admin and embedded Hasura follow-up passed 36 live adversarial checks. Local credential-free login was replaced with five-minute, single-use CLI credentials. Hasura's standalone hostnames were removed; root identity, full current grants and CSRF checks protect the embedded console and every asset. PostgreSQL syntax-tree validation rejects transaction escapes and hidden writes before forwarding, in addition to read-only transactions and database permissions. Background workers cannot mint login codes. Remote administrator ID tokens now enforce the configured assurance level, recent authentication and authorized party.

`npm run check` passed with 35 unit/regression tests and the build. The real PostgreSQL/Hasura/RabbitMQ integration suite passed with the competing local worker briefly paused; the same worker was resumed and its readiness verified. All nine canonical HTTPS browser scenarios passed across desktop Chromium, mobile Chromium and mobile WebKit, including table browsing and source switching. Rust formatting, workspace Clippy, four focused CLI tests, source scanning and formatting passed. DNS/TLS and application health passed for every registered `.fv` route.

The production npm audit reported zero vulnerabilities; the full audit retains five development dependency entries from one unpatched picomatch advisory. Live identity-provider MFA/Access behavior, deployed ingress and recovery remain separate evidence. See the [repeatable administrator exercise](runbooks/ADMIN_SECURITY.md), `.state/evidence/admin-red-blue.json`, and `.state/qa/hasura-*.png`. These are automated local exercises, not an independent penetration test. Earlier verification counts below describe the preceding hardening pass.

## Findings and implementation

| Priority | Finding | Remediation and verification |
| --- | --- | --- |
| High | Rejected broker messages could mutate another job's retry budget using its ID. | Bind retry updates to application, tenant, actor, correlation and published state. Reject invalid provenance before retry. Focused tests and real PostgreSQL/broker integration. |
| High | Administrator scope reduction could remove the final cluster administrator; an operation owner could cancel a cluster operation after losing cluster scope. | Require current cluster scope for cancellation and retain a cluster administrator when changing scope. Route regression coverage. |
| High | Step-up approval state and audit were separate writes, and current grants were not rechecked atomically. | Lock the operation and administrator, verify claim freshness and exact nonce/environment, and commit approval plus audit together. |
| High | Host process timeouts killed only the immediate process, leaving descendants with inherited authority. | Give each operation a Unix process group and clean up descendants on completion, failure and timeout. Rust descendant lifetime tests. |
| High | Initial host adoption could continue after Docker inventory failure. | Refuse adoption when inventory is unavailable or existing Docker data cannot be inspected. |
| Medium | A session cookie alone reported authenticated status; login rotation left the previous session active. | Query current enabled administrator and unexpired session; rotate sessions atomically; disable auth response caching and token endpoint redirects. |
| Medium | Cloud-init interpolated unquoted SSH key comments. | Quote keys as YAML-compatible JSON scalars and reject control characters. Rust injection regression. |
| High | Independent operation verification did not enforce full current cluster scope and accepted future authentication times. | Validate the fixed catalog, exact namespace and current cluster scope independently; bound both proof timestamps. Supply the domain worker with its missing OIDC verification settings. |
| High | Recovery manifests accepted weak identifiers or incomplete inventories; restored plaintext used a predictable temporary path. | Require complete environment-specific artifact sets, reject links, verify generated bundles, and restore through a private unique directory with private preserved catalogs. |
| Medium | Local configuration could target unrelated Compose project names; provider URLs and environment keys were weakly validated. | Enforce the local/fv-local project boundary, parsed HTTPS URLs, hexadecimal checksums and strict environment keys. |
| Medium | GraphQL followed upstream redirects and trusted malformed response envelopes. | Refuse redirects, bound and validate responses, cancel non-success streams, and return sanitized gateway failures. Upload signatures explicitly bind content type and length. |
| Medium | Private JSON could be cached; malformed internal status values could escape error handling. | Apply no-store to JSON replies, normalize status values and keep server errors generic. Validate upstream byte budgets and cancel failed streams. |
| Medium | Failed rollback could return an unusable connection to the pool; removing applied migrations escaped checksum comparison. | Discard failed rollback connections while retaining the original error; compare the complete applied migration ledger to source inventory. No applied SQL was edited. |
| Medium | Deployment state accepted invalid active colors, image policy allowed loose prefix semantics, and release trees could include special files. | Require blue/green state, exact repository and digest policy, distinct rollback target, and regular release input files. Three Rust regressions. |
| Medium | Unprivileged services lacked several host restrictions and app containers lacked a PID budget. | Apply 128-task limits, empty capability bounds, kernel protections, restricted namespaces/address families/native syscall architectures and disabled core dumps. Compose config validation passed; live Linux unit verification remains pending. |

## Implementation ownership

Twelve focused subagents implemented disjoint areas in batches of at most three: queue provenance, admin authentication, admin scope, host execution, configuration, recovery, independent operation authorization, HTTP, API, database, deployment, and infrastructure. The primary agent reviewed the combined patches, added real database retry rejection checks, and ran integration and recovery validation. Pre-existing UI/CSP/keyboard changes were preserved.

## Local verification

- `npm run check`: TypeScript checks, 29 unit/regression tests and production build passed.
- `npm run test:integration`: real PostgreSQL, Hasura and RabbitMQ passed, including forged retry rejection and unchanged terminal states. Integration evidence is under `.state/evidence/integration.json`.
- Browser checks: six scenarios passed across desktop Chromium, mobile Chromium and mobile WebKit.
- `npm run format:check`, `npm run security:scan`, Rust formatting, workspace Clippy with warnings denied and 12 workspace Rust tests passed.
- `bin/fv backup capture` and `bin/fv backup restore-drill` passed against `fv-local`. The isolated restore receipt records named point-in-time recovery, PostgreSQL startup, vector extension, migration and data checks; `clean_host` is false. Evidence is under `.state/local/restore-receipt.json`.

Source changes to systemd and Compose are configuration evidence only until applied and checked on the target Linux host. Existing application services were not restarted by this hardening pass.

## Boundaries retained

Application selection always precedes membership checks in the selected database; exact PostgreSQL and Hasura namespaces remain registry-owned. Existing forced row security and source-specific Hasura roles remain intact. [PostgreSQL documents](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) that table owners and bypass roles need separate consideration; membership/API tests alone do not establish the security of a superuser connection.

The host CLI and Rust runner retain host authority. Process cleanup reduces inherited child authority but does not establish host compromise resistance. [Node's child-process documentation](https://nodejs.org/api/child_process.html) likewise distinguishes process termination, timeouts and subprocess behavior; TypeScript subprocess callers require their own controls.

## Remaining live evidence

Local checks cannot prove external OIDC MFA/Access policy, deployed ingress/firewall behavior, signed image admission, independent immutable object retention, offsite-copy completeness, or clean-host recovery. Verify those against the exact staging candidate and separately administered storage before production promotion. Do not treat local fixtures as provider or deployed evidence.
