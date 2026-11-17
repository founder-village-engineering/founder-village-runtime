# Founder Village runtime

- Author application and automation code in TypeScript (`.ts`/`.tsx`) and host/runtime control code in Rust. Do not create JavaScript or MJS source files. TypeScript source imports use `.ts`; compiler/browser output stays ignored.
- `config/applications.json` is the namespace registry. Preserve the exact PostgreSQL and Hasura source names: `founder-village`, `founder-farm`, `founder-cafe`, and `founder-residences`. Application selection must not replace server-side membership checks.
- Never copy Archlife secrets, production data, deployment state, or application-specific behavior. Preserve unrelated worktrees and running services.
- Keep local integration resources under the `fv-local` Compose project. Never remove volumes as an implicit cleanup step.
- Schema changes require additive, checksummed migrations. Hasura metadata is versioned, source-specific, and private.
- Admin/browser services have no Docker socket, unrestricted shell endpoint, or provider-wide key. Privileged operations use the fixed Rust catalog with durable authorization and audit checks.
- Keep routine checks proportional. `npm run check`, `cargo clippy --workspace --all-targets -- -D warnings`, real integration tests, browser checks for UI changes, and recovery tests for backup changes are the principal gates. The explicit full-release workflow includes the wider collection.
- Distinguish local, provider, deployed, offsite-copy, isolated-restore, and clean-host recovery evidence. Never label a missing live proof as passed.
