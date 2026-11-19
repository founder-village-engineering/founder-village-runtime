# Applications, frontends, access, and WireGuard

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

The namespaces are `founder-village`, `founder-farm`, `founder-cafe`, `founder-residences`, and `founders`. They are separate databases, not schema aliases for one database. Registry database and Hasura names are exact; GraphQL namespaces use underscores because GraphQL identifiers cannot contain hyphens.

Frontend and application identities are deliberately independent. Multiple frontends may map to one application only after an explicit product/data-boundary decision. The `founders` database is the first intentional example: `founder-food-deliveries` uses its shared member, company, and expense records plus the food-delivery feature tables. Each frontend still owns its exact origin allowlist entry and runtime-owned contract directory.

```sh
npm run namespace:add -- founder-library 'Founder Library'
npm run hasura:generate
bin/fv render
bin/fv up
```

Review the registry/metadata diff before applying it remotely. Rendering generates private Compose overrides so an added namespace receives its own role URLs without editing a static service matrix. SQL migrations are checksummed per database. Shared migrations run first; application-specific migrations live under `database/applications/<id>/`. Never edit a migration already applied to an environment.

## Frontend onboarding and contracts

Each completed frontend has one manifest in `founder-village-frontends/apps/<slug>/founder-village-app.json`. For initial scaffolding, copy the skill example into an ignored path such as `founder-village-frontends/.state/new-apps/<slug>.json`; runtime onboarding rejects manifests outside the frontend repository. Use that manifest to plan and apply both repositories:

```sh
# In founder-village-frontends
npx tsx scripts/scaffold-app.ts --manifest /absolute/path/project.json --plan
npx tsx scripts/scaffold-app.ts --manifest /absolute/path/project.json --apply

# In founder-village-runtime
npm run frontend:add -- --manifest /absolute/path/project.json \
  --frontends-root ../founder-village-frontends --plan
npm run frontend:add -- --manifest /absolute/path/project.json \
  --frontends-root ../founder-village-frontends --apply
```

The runtime registration is authoritative for the frontend-to-application mapping, application/database, exact `pages.dev` and local browser origins, frontend path, and contract source. Onboarding creates a missing application or validates an explicitly selected existing one. The allowlist uses exact origins; wildcard and suffix matching are not accepted. CORS narrows browser access but does not replace bearer verification, tenant membership, or row-level security.

Canonical browser contracts are organized by frontend under `packages/frontend-contracts/<slug>/`. Never edit the generated frontend copy. During local development, run:

```sh
npm run frontend-contracts:watch -- --frontends-root ../founder-village-frontends
```

Use `frontend-contracts:sync` for a one-shot update and `frontend-contracts:check` in verification. A runtime push that changes canonical contracts or the frontend registry runs `.github/workflows/sync-frontend-contracts.yml`; after the repository secret `FOUNDER_VILLAGE_FRONTENDS_SYNC_TOKEN` is configured, that workflow opens a checksummed update pull request in `founder-village-frontends`.

The repository-owned `$create-founder-village-app` skill under `.agents/skills/` contains the complete reusable workflow and cross-repository audit scripts.

Grant/revoke membership using the trusted CLI procedure:

```sh
node --env-file=.state/local.env --import tsx scripts/membership.ts founder-village grant <tenant-uuid> '<verified-issuer>|<subject>'
```

`revoke` disables the membership. Existing tenant records stay intact and other applications' grants remain unchanged. Tenant creation and application-specific data lifecycle changes belong in explicit migrations/owned application features; the runtime does not infer them from email addresses or headers.

A named console administrator needs explicit actions and application scopes:

```sh
bin/fv admin-grant --actor '<verified-issuer>|<subject>' --actions dashboard.read --applications founder-village,founder-farm
```

Production use also needs the configured MFA/Access identity. Cluster-wide backup/deploy/network operations require grants covering the complete application inventory. Adding an application does not silently expand existing grants. Revocation is checked for every request and again before execution.

For WireGuard, prefer client-generated keys and `wireguard enroll` with the public key. An optional local profile generator writes a private file and never activates workstation routes:

```sh
node --import tsx scripts/wireguard-profile.ts laptop 10.89.0.2 vpn.example.com:51827 2027-02-01 config/local.json
bin/fv wireguard status
```

Profiles are distinct per device, mode 0600, and split-tunnel to the management host. The generator preserves an existing client key on retries. Import the profile only on the named device. On Linux, `wireguard apply` reconciles the interface without restarting other peers; the expiry timer removes expired peers from live configuration. `wireguard revoke --name laptop` persists revocation; apply it on the host and verify the removed public key and real inability to reconnect.

A recent handshake is necessary but not sufficient proof of intended routing. Verify private SSH access and the absence of unexpected default-route/DNS/IPv6 changes. Keep provider-console recovery and a narrowly scoped, expiring bootstrap SSH procedure available.
