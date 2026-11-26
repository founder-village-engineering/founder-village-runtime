# Founder Village production

[The production manifest template](../../config/production.example.json) defines the runtime topology. [The frontend registry](../../config/frontends.json) defines the Pages project and browser origins.

| Host | Service |
| --- | --- |
| `api.foundervillage.org` | Public API through Cloudflare Tunnel |
| `admin.foundervillage.org` | Admin through Cloudflare Access and runtime OIDC |
| `ssh.foundervillage.org` | Operator SSH through a separate Access policy and a pinned host key |
| `founder-village-app.pages.dev` | Primary Cloudflare Pages Direct Upload project |
| `founder-village-apps.pages.dev` | Additional Pages project serving the same app build |
| `founderhaus.org`, `foundervillage.org` | Apex domains attached to the primary Pages project |

PostgreSQL, RabbitMQ, Hasura and workers run on the runtime's private network. Hasura is available to authorized administrators under `/hasura/`.

## Unattended production bootstrap

Run this command on the trusted release workstation or its deployment runner with Node 24, Rust, Git, Docker, OpenSSH, age, cloudflared and Gitleaks. The grant-issuance path also uses Terraform. The entrypoint installs missing checkout dependencies and builds the current native CLI. It accepts closed stdin.

~~~sh
npm run --silent production:bootstrap -- preflight
npm run production:bootstrap -- apply
~~~

The preflight reports missing or unreadable machine credentials by name and exits with status 1 when the projection is incomplete. It uses the same credential resolution as the deployer, includes the grants that a delegated Cloudflare issuer can provide, and makes zero provider requests. Use `prepare` for live account, project, identity provider, and storage checks.

The runner enrolls separate operator and release-signing identities, pins the signer outside the release bundle, and creates an age recovery identity, Team encryption key and audit HMAC key. It reuses these on subsequent runs. An existing machine enrollment can project its original identities. Private state defaults to `~/.local/share/founder-village/production`. `FV_PRODUCTION_HOME` selects another persistent, owner-only directory outside the checkout. Include this directory in the workstation's protected backup. The age identity and the encrypted backup-verification key stay off the runtime VM.

`init` generates and verifies workstation material offline when using local credential mounts. `prepare` performs provider reads and publishes validated files under `current/` in the private workstation directory. These include the production manifest, bootstrap settings, SSH host pins, Pages account binding and host catalog. An incomplete generation never becomes current.

`apply` signs the native release, reconciles Tunnel, Access and DNS, enrolls or verifies SSH, and installs the signed runtime. It checks the immutable backup and exercises an isolated restore before promotion. It verifies the external API revision, admin Access challenge and a new pinned SSH session with sudo before closing public SSH. It then verifies the provider firewall and SSH again, publishes one app build to both Pages projects, and checks the app on all four origins. A successful repeat deployment verifies the existing release against its receipt. An interrupted lockdown resumes through the Tunnel.

### Machine credentials and ownership

The runner reads individual credentials from a protected `NAME_FILE`, a service manager's `CREDENTIALS_DIRECTORY`, the private `~/.config/founder-village/production/credentials/` directory, or an injected variable. Secret values and provider response bodies stay out of release logs.

| Trust supplied by the deployment platform | What the runner derives or issues |
| --- | --- |
| A project-issued `FV_HCLOUD_TOKEN` | Discovers the exact owner-labelled production VM or uses the existing private candidate binding. Checks its provider ID, address, image, architecture, location and whole-project inventory. |
| The existing VM's trusted host enrollment | Reads `FV_SSH_HOST_PUBLIC_KEY`, a previously pinned machine binding, or authenticated server labels `fv-ssh-host-key-1` and `fv-ssh-host-key-2`. Each label holds one 32-character hex half of the raw Ed25519 public key written by the trusted VM factory. Generates both IP and Tunnel entries in the dedicated known_hosts file. |
| An SSH identity already authorized on that VM | Uses an enrolled operator key, or uses `FV_INITIAL_ROOT_SSH_KEY` on first launch to install the generated operator public key and prove operator access before disabling root SSH. |
| Cloudflare access to both apex zones | Verifies the active zones share an owner, checks any existing Founder account pin, discovers the Access team and audience, and provisions an expiring SSH service credential. Its Service Auth policy names that single credential on the SSH application. Browser admin policy continues to require MFA. |
| Workforce policy | `ACCESS_ADMIN_EMAILS` and `OIDC_MFA_ACR` come from the organization's authorization policy. `ACCESS_SSH_EMAILS` preserves named human SSH access when configured. `ROOT_ADMIN_ACTORS` carries approved issuer/subject bindings. The deployment identity receives no application administrator grant. |

Hetzner issues the initial API token inside its project. A machine secret broker can deliver an existing grant on every run. A fresh local key cannot authenticate to an existing VM until that VM has enrolled its public key or trusts a separate enrollment identity. [Hetzner API token issuance](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/) · [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

### Generate provider grants

The optional Cloudflare credential issuer uses a delegated Founder Village account token with account-token management and visibility of both active zones. It creates dedicated DNS, Tunnel and Pages credentials in that account. Its Terraform state and plans stay in the workstation's protected directory. The runner checks the saved plan before applying and stops on deletions and replacements. [Cloudflare grant configuration](../../infra/production-authority/cloudflare.tf)

Runtime deployments use the organization's existing OIDC provider and S3-compatible backup service. The Pages site can be published independently.

An existing provider deployment can project its issued bindings directly. The [input resolver](../../scripts/production/discovery.ts) accepts dedicated DNS read/write, Tunnel provisioning and Pages credentials, OIDC registration outputs, and backup, mirror, audit and optional file-service credentials. The host receives only its runtime allowlist. Existing keys can be enrolled through `FV_OPERATOR_SSH_KEY`, `FV_RELEASE_SIGNING_KEY`, `AGE_RECIPIENT`, `TEAM_CONTENT_KEY` and `AUDIT_HMAC_KEY`.

## Check an existing VM

For a VM already allocated in the dedicated Hetzner project, start with the provider-only example and make a mode-0600 copy at `config/candidate.private.json`. Set the environment, exact server name, and provider server ID and IPv4 from the approved project. For a Helsinki CX23, the provider selection is `hel1`, `cx23` and `amd64`. Supply `root_disk_gb` to verify the VM's reported root disk capacity. Bind any registered keys or other project resources as documented in the provisioning runbook. [Candidate manifest example](../../config/candidate.example.json) · [Hetzner locations](https://docs.hetzner.com/cloud/general/locations/) · [Provisioning and private catalog](PROVISIONING.md)

With a read-only token for the dedicated Founder Village project in `FV_HCLOUD_TOKEN`, run the audit from the operator workstation. It checks the whole project and reports the bound VM's location, platform, server type, stock Ubuntu 24.04 or 26.04 image, and root disk. Supply `provider.image` to require an exact match to the reported image. The installation procedure also checks the running OS and architecture over pinned SSH. [Hetzner project-scoped API tokens](https://docs.hetzner.com/cloud/api/getting-started/using-api/) · [Hetzner server response schema](https://github.com/hetznercloud/hcloud-go/blob/main/hcloud/schema/server.go) · [First-launch procedure](PROVISIONING.md)

```sh
bin/fv --config config/candidate.private.json candidate-audit
```

## Inspect the generated inputs

For individual diagnostics, use the mode-0600 production manifest under the workstation's `current/` directory. The remaining commands illustrate the underlying release steps. [Production manifest template](../../config/production.example.json) · [Provisioning and private catalog](PROVISIONING.md)

Both apex zones must be active in the same Cloudflare account as the Pages project. Use that account for the `foundervillage.org` Tunnel too. Use the Pages reconciliation command for the apex records. Tunnel reconciliation owns the three service subdomains. [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

The generated manifest holds distinct admin and app OIDC client IDs. The app uses authorization code with PKCE. The plan prints the redirects and browser origins those clients use. [Administrator sign-in](ADMIN_SECURITY.md)

```sh
manifest="${FV_PRODUCTION_HOME:-$HOME/.local/share/founder-village/production}/current/production.private.json"
npm run frontend:production -- plan --app founder-village-app --config "$manifest"
bin/fv --config "$manifest" provision audit
bin/fv --config "$manifest" provision status
```

## Install and promote the runtime

Build and sign the exact Linux architecture from the clean Founder Village checkout on the workstation. Set `releaseDirectory` and the separately maintained `allowedSigners` path in the bootstrap settings. Use the first-launch procedure to bind the provider, install via pinned SSH, initialize private services and verify the current immutable backup. For later upgrades set `host` to the tested Access SSH hostname. [Build and sign on the workstation](DEPLOYMENT.md) · [First launch](PROVISIONING.md)

From the VM's operator session, set `runtime_revision` to the revision from the signed workstation manifest.

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
manifest="${FV_PRODUCTION_HOME:-$HOME/.local/share/founder-village/production}/current/production.private.json"
npm run frontend:production -- provision --app founder-village-app --config "$manifest"
npm run frontend:production -- deploy --app founder-village-app --config "$manifest" --revision "$runtime_revision"
npm run frontend:production -- verify --app founder-village-app --config "$manifest" --revision "$runtime_revision"
```

The deployment verifies the public app builds, API version, origin checks, unauthenticated access boundaries, Access challenge and public OIDC configuration. An authenticated member or browser-admin journey requires an approved workforce identity with the relevant grants. Record any independently executed journey separately from deployment, immutable-copy and restore evidence.
