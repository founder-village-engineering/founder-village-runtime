# Verification and release

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

## Focused proof

- Runtime contract source: `npm run frontend-contracts:validate`.
- Exact generated copies: `npm run frontend-contracts:check -- --frontends-root ../founder-village-frontends`.
- Frontend snapshot integrity: `npm run contracts:check` in the frontend repository.
- Shared release dry run: `npm run pages -- plan --app <slug>`.
- Responsive journey: the app's Playwright desktop and mobile projects.

## Repository proof

Runtime changes normally require `npm run check`. Database, auth, worker, Hasura, or idempotency changes also require `bin/fv up` and `npm run test:integration`. Rust boundary changes require fmt, Clippy, and workspace tests. Backup-format or database-inventory changes require `bin/fv backup capture` and `bin/fv backup restore-drill`.

Frontend changes require `npm run check` and `npm run test:e2e`. The Pages plan is local artifact proof only and deliberately uses a non-deployable `.test` API origin.

## Live proof

Run provider inventory/provision/deploy only with explicit credentials and real public runtime/OIDC values. The production bridge compares the public runtime with the signed revision, checks API CORS and the anonymous admin Access challenge, and verifies the configured provider's SPA callbacks and token CORS. Verify the deployed artifact at the exact Pages origin and each configured alias. Complete a real authenticated browser journey against the intended runtime and database to confirm issued bearer tokens and application membership.

Name every unrun layer in the handoff: public runtime, OIDC, Cloudflare project, upload, authenticated browser, mobile viewport/device, database backup, and restore drill are distinct claims.
