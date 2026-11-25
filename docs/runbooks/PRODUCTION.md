# Founder Village production

[The production manifest template](../../config/production.example.json) defines the runtime topology. [The frontend registry](../../config/frontends.json) defines the Pages project and browser origins.

| Host | Service |
| --- | --- |
| `api.foundervillage.org` | Public API through Cloudflare Tunnel |
| `admin.foundervillage.org` | Admin through Cloudflare Access and runtime OIDC |
| `ssh.foundervillage.org` | Operator SSH through a separate Access policy and a pinned host key |
| `founder-village-app.pages.dev` | Production Cloudflare Pages Direct Upload |
| `founderhaus.org`, `foundervillage.org` | Apex domains attached to that Pages project |

PostgreSQL, RabbitMQ, Hasura and workers run on the runtime's private network. Hasura is available to authorized administrators under `/hasura/`.

## Prepare the private inputs

Create `config/production.private.json` with mode 0600 from the template. Bind the existing Ubuntu 26.04 ARM64 VM by ID, name and assigned IPv4 in its dedicated Hetzner project. Populate the temporary SSH allowlist, Cloudflare account and zone IDs, Access team, pinned `cf` launcher digest, OIDC settings and root actors, and storage bindings from the approved secret store. Keep the workstation bootstrap settings and runtime catalogs in protected paths. [Provisioning and private catalog](PROVISIONING.md)

Both apex zones must be active in the same Cloudflare account as the Pages project. Use that account for the `foundervillage.org` Tunnel too. Use the Pages reconciliation command for the apex records. Tunnel reconciliation owns the three service subdomains. [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

Register the admin OIDC client with the organization's identity provider and configure MFA. Use a separate public authorization-code-with-PKCE client for Founder Village App. Store its client ID in `auth.frontend_client_ids.founder-village-app`. The plan prints the exact redirects and browser origins to register for that public client. [Administrator sign-in](ADMIN_SECURITY.md)

```sh
manifest=config/production.private.json
npm run frontend:production -- plan --app founder-village-app --config "$manifest"
bin/fv --config "$manifest" provision audit
bin/fv --config "$manifest" provision status
```

## Install and promote the runtime

Use `npm run release:rules -- plan` to review the GitHub protections. A repository administrator can install them with `npm run release:rules -- apply`. Verify them with `npm run release:rules -- verify` before publishing a release tag on the chosen `main` revision. [GitHub rulesets](https://docs.github.com/en/rest/repos/rules)

Download the signed `fv-linux-arm64-<revision>` artifact from its successful GitHub Actions run. Follow the [first-launch procedure](PROVISIONING.md) to bind the provider, bootstrap over pinned SSH, initialize the private runtime, reconcile Access and Tunnel, and verify a current immutable backup copy. Set `host` in the bootstrap file to the configured Tunnel hostname for subsequent installations.

From the VM's operator session, use the successful release run's exact commit SHA as `runtime_revision`.

```sh
cd /opt/founder-village
manifest=config/production.private.json
sudo bin/fv --config "$manifest" release promote --revision "$runtime_revision"
sudo bin/fv --config "$manifest" doctor
```

Enable the monitoring, backup and ingress units using the first-launch procedure. Verify the public API revision from the workstation before publishing the app. Check admin Access MFA and operator SSH before closing the temporary SSH allowlist. [Release and rollback](DEPLOYMENT.md)

```sh
PUBLIC_API_URL=https://api.foundervillage.org PUBLIC_API_REVISION="$runtime_revision" node scripts/probe.ts
```

## Deploy the app and verify the connection

From the runtime checkout, keep the matching frontend checkout at `../founder-village-frontends` or pass its absolute path using `--frontends-root`. Supply the account-scoped Pages and DNS credentials through the workstation secret store. The production command uses the private runtime manifest to select the API and the browser OIDC configuration.

```sh
manifest=config/production.private.json
npm run frontend:production -- provision --app founder-village-app --config "$manifest"
npm run frontend:production -- deploy --app founder-village-app --config "$manifest" --revision "$runtime_revision"
npm run frontend:production -- verify --app founder-village-app --config "$manifest" --revision "$runtime_revision"
```

After the automated checks pass, sign in with a real, approved account on each app hostname. Open Members, Food Deliveries and Team using an account with the corresponding grants, and verify the expected access boundaries with an approved restricted account. Verify an authorized production admin sign-in through Access. Record the signed runtime revision, Pages deployment revision and the authenticated browser results separately from provider, immutable-copy and restore evidence.
