# Security model

Security is a set of enforced boundaries and measured evidence, not a claim that compromise is impossible. No regulated-data or compliance certification is asserted.

| Threat | Control |
| --- | --- |
| Forged API identities | Issuer/audience/signature/expiry validation; local HS256 identities disabled outside `local`; no caller actor/role headers. |
| Cross-application access | Registry-selected connection pools, separate database logins, denied `PUBLIC CONNECT`, source-specific Hasura roles. |
| Cross-tenant access | Verified membership in the selected database and forced RLS for records; transaction-local actor/tenant context. |
| Browser/admin abuse | Exact OIDC assurance and recent MFA, verified Access JWTs, short opaque sessions stored as hashes, CSRF/origin checks, explicit action/application grants, restrictive browser headers. Local sign-in requires a five-minute single-use CLI credential. |
| Hasura administrative exposure | Embedded root-only console; current full application grants on every asset/API request; upstream credentials stay server-side; read-only SQL syntax validation and transactions; mutation/metadata-write denial; no standalone hostname. |
| Forged privileged operation rows | Fresh OIDC nonce bound to exact ID/actor/environment/action/parameters; independent runner verification; one-time authorization ledger. |
| Shell injection | Fixed operation catalog, strict schemas, argument arrays, bounded subprocesses; no browser command endpoint. |
| Lost/duplicated work | Transactional outbox, publisher confirms, manual acknowledgements, durable idempotency/effect records, bounded retry and dead-letter state. |
| Backup corruption/deletion | Encrypted pgBackRest, signed inventories, separate immutable-copy credentials, exact artifact manifests, isolated restore checks. |
| Audit manipulation | Application roles cannot update/delete/truncate the control ledger; independent signed exports/checkpoints detect divergence. Database owners remain privileged. |
| Host/container exposure | Outbound Tunnel, provider/UFW/forwarding policy, loopback ports, distroless non-root app runtime without npm/shell, read-only filesystem, dropped capabilities, private generated files. |
| Supply-chain changes | Exact dependency locks, image digests, tool hashes, workflow action SHAs, signer/registry policy, scans and explicit updates. |

The Rust operation runner and root CLI hold host authority. Compromising the host can compromise online secrets. Independent retention, offline recovery keys, separately administered provider accounts, and external audit history remain necessary. Disk encryption/provider guarantees must be assessed for the chosen VPS and key-custody model; they are not established by a container setting.

The application runtime copies the checksum-pinned Node binary from its build stage into a digest-pinned [distroless C++ runtime](https://github.com/GoogleContainerTools/distroless). The verified Cloudflare launch script is executed through that Node binary directly. Build tooling stays in the build stage. Hosted release scanning must independently pass for the actual candidate and target architecture; a local scan does not establish the state of PostgreSQL, Hasura, RabbitMQ, proxy, or tunnel images.

OIDC must support PKCE, nonce, `amr` containing `mfa`, the exact configured `acr`, and recent `auth_time`. Initial admin authentication is bounded to one hour; operation step-up is bounded to five minutes and the exact operation. The backend uses the configured client ID for ID-token audience verification and the API audience for API bearer tokens. Multi-audience administrator ID tokens require the matching `azp`. Provider behavior must be verified in staging. Missing proofs cannot authorize production operations. See [administrator exercises and evidence limits](runbooks/ADMIN_SECURITY.md).

Recovery can resurrect sessions, memberships, queued work, and provider credentials. Before reopening ingress, revoke old sessions, reconcile revoked administrators/memberships against independent records, rotate restored credentials, and reconcile external effects. Restored applications remain stopped during validation.

Source scans must never print secret matches. General logs contain status/category/request IDs, not payloads, SQL arguments, cookies, tokens, query strings, or raw provider diagnostics. Synthetic canaries are the only data used by the checked-in acceptance scenarios. Audit exports are restricted and require independently managed storage/retention policy.
