# Founder Village production

[The production manifest template](../../config/production.example.json) defines the runtime topology. [The frontend registry](../../config/frontends.json) defines the Pages project and browser origins.

| Host | Service |
| --- | --- |
| `api.foundervillage.org` | Public API through Cloudflare Tunnel |
| `admin.foundervillage.org` | Admin through Cloudflare Access and runtime OIDC |
| `ssh.foundervillage.org` | Operator SSH through a separate Access policy and a pinned host key |
| `vault.foundervillage.org` | Vaultwarden for the web vault and Bitwarden clients through Cloudflare Tunnel |
| `founder-village-app.pages.dev` | Primary Cloudflare Pages Direct Upload project |
| `founder-village-apps.pages.dev` | Additional Pages project serving the same app build |
| `founderhaus.org`, `foundervillage.org` | Apex domains attached to the primary Pages project |

PostgreSQL, RabbitMQ, Hasura and workers run on the runtime's private network. Hasura is available to authorized administrators under `/hasura/`.

## Unattended production bootstrap

Run this command on the trusted release workstation or its deployment runner with Node 24, Rust, Git, Docker, OpenSSH, age, cloudflared and Gitleaks. The grant-issuance path also uses Terraform. The entrypoint installs missing checkout dependencies and builds the current native CLI. It accepts closed stdin.

~~~sh
npm run --silent production:bootstrap -- preflight && npm run production:bootstrap -- apply
~~~

The preflight reports missing or unreadable machine credentials by name and exits with status 1 when the projection is incomplete. It uses the deployer's credential resolver, syncs the selected Vaultwarden collection when configured, and counts grants that a delegated Cloudflare issuer can provide. Use `prepare` for live account, project and sign-in provider checks. Bootstrap reports the selected backup mode.

### Resume a release blocked at preflight

On a first deployment, a missing binding often means its resource or grant still needs to be created. Start with an authenticated administrator for each provider. In Hetzner, create the deployment token in the project that contains the pinned VM and enroll it directly into Vaultwarden. [First Hetzner token enrollment](PROVISIONING.md#1-bind-the-existing-vm-and-its-network)

At the chosen identity provider, register separate public clients for the administration console and the app, enable authorization code with S256 PKCE, and register the API audience. The admin client redirects to the configured admin origin at `/auth/callback`. The app client uses that path on each registered production app origin. Set the approved administrator email policy and use the assurance value actually issued after the required MFA. [Administrator sign-in requirements](ADMIN_SECURITY.md)

New deployments use the Founder Village workstation backup. The VM captures encrypted PostgreSQL backups and recovery files. The release workstation pulls them over pinned SSH into this checkout’s Git-ignored `backups/` directory, verifies the authenticated archive and exercises a restore from the returned bytes. The backup toolchain and audit archive are part of this repository. [Backup and recovery](RECOVERY.md)

Use the production runner's preflight report to route each `missing` or `invalid` name to the authority below. Each authority supplies its issued value as a hidden field in the bound Vaultwarden item or as an owner-only file of the same name in the protected runner mount. Keep values in those channels. Workstation mode requires the following 11 names. [Binding definitions](../../scripts/production/bindings.ts)

| Supplying authority | Required bindings |
| --- | --- |
| Hetzner project owner | `FV_HCLOUD_TOKEN` |
| Cloudflare account owner for the two apex zones | `CF_READ_TOKEN`, `CF_WRITE_TOKEN`, `CLOUDFLARE_PROVISION_TOKEN`, `FV_PAGES_API_TOKEN` |
| Workforce identity provider and application registration owner | `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`, `FV_APP_OIDC_CLIENT_ID`, `OIDC_MFA_ACR` |
| Administrator access policy owner | `ACCESS_ADMIN_EMAILS` |

The Cloudflare account owner can supply `FV_CF_TOKEN_ISSUER` to authorize issuance of the four dedicated Cloudflare grants. Preflight reports the outstanding grants under `delegated`. The release runner issues them during `apply`. [Cloudflare grant issuance](#generate-provider-grants)

A vault import can also carry five fields from an enrolled workstation. The target and account pins use `FV_HETZNER_CANDIDATE` and `FV_CLOUDFLARE_ACCOUNT_ID`. The recovery recipient and application keys use `AGE_RECIPIENT`, `TEAM_CONTENT_KEY` and `AUDIT_HMAC_KEY`. Preflight counts these enrollment fields separately from release bindings. The private operator SSH key, release-signing key and age recovery identity stay in their existing independent custody. [Workstation enrollment and import](../../scripts/production/vaultwarden.ts)

For an existing protected mount at another location, set `CREDENTIALS_DIRECTORY` to its absolute directory path. For another configured Founder Village vault binding, set `FV_VAULTWARDEN_BINDING_FILE` to the absolute path of its owner-only binding file. The runner checks for conflicts when both sources supply a name.

After the supplying authorities update the source, run `npm run production:bootstrap -- apply` in that runner environment. Both `prepare` and `apply` repeat preflight before building the native CLI, enrolling identities or contacting the infrastructure providers. A successful preflight establishes that the named inputs are present and readable or covered by the delegated issuer. Confirm provider validation, backup and restore checks, runtime promotion and Pages publication from the subsequent release results.

### Workstation identity and release verification

The runner enrolls separate operator and release-signing identities, pins the signer outside the release bundle, and creates an age recovery identity, Team encryption key and audit HMAC key. It reuses these on subsequent runs. An existing machine enrollment can project its original identities. Private state defaults to `~/.local/share/founder-village/production`. `FV_PRODUCTION_HOME` selects another persistent, owner-only directory outside the checkout. Include this directory in the workstation's protected backup. The age identity and the encrypted backup-verification key stay off the runtime VM.

`init` generates and verifies workstation material offline when using local credential mounts. `prepare` performs provider reads and publishes validated files under `current/` in the private workstation directory. These include the production manifest, bootstrap settings, SSH host pins, Pages account binding and host catalog. An incomplete generation never becomes current.

`apply` signs the native release, reconciles Tunnel, Access and DNS, enrolls or verifies SSH, and installs the signed runtime. It verifies the backup in the selected destination and exercises an isolated restore before promotion. It verifies the external API revision, admin Access challenge and a new pinned SSH session with sudo before closing public SSH. It then verifies the provider firewall and SSH again, publishes one app build to both Pages projects, and checks the app on all four origins. A repeat deployment checks the saved revision and configuration against the serving API, firewall, protected SSH route and backup. Once these checks pass, an interrupted Pages publication resumes against that runtime. The frontend receipt is recorded after both projects pass public verification. An interrupted lockdown resumes through the Tunnel.

### Vaultwarden distribution

Vaultwarden is the Founder Village production secret store. For shared access, bind the release runner to a Founder Village organization collection available to the production release operators. The runner reads the secure note named `Founder Village production bindings`. Each hidden field carries one production binding and uses the variable name from preflight.

Use the workstation Vaultwarden and its dedicated release account to stage bindings before public ingress is available. Its data and admin passphrase live under `FV_PRODUCTION_HOME/bootstrap-vault`, with the default workstation directory used when `FV_PRODUCTION_HOME` is unset. The service shares the existing loopback HTTPS edge at `https://vault.fv`. [Local HTTPS setup](LOCAL_DOMAINS.md)

```sh
npm run production:vault -- workstation
read -r vault_email
printf '%s\n' "$vault_email" | npm run production:vault -- workstation-invite
```

Use the invited address at `https://vault.fv/#/signup`, then configure a separate Bitwarden CLI profile for Founder Village. Save the release binding at `~/.config/founder-village/production/vaultwarden/binding.json` with mode `0600`. Include `server` as `https://vault.fv` or `https://vault.foundervillage.org` and the absolute owner-only `profile` directory. Bind an organization collection with `organizationId` and `collectionId`. For a dedicated release account's own vault, supply its Bitwarden `userId` as `ownerId`. For the workstation vault, set `caFile` to the pinned local CA. The optional `cli` field selects an absolute path to the official Bitwarden CLI.

Unlock the dedicated profile and supply `BW_SESSION` or an owner-only `BW_SESSION_FILE`. A logged-in deployment profile can use an owner-only master password file named by `unlockFile` in the binding. Keep the release signing key, operator SSH key, and the age recovery identity in their independent custody. [Bitwarden CLI connection and unlock](https://bitwarden.com/help/cli/#log-in)

```sh
npm run production:vault -- import
npm run production:vault -- status
npm run production:vault -- project
npm run --silent production:bootstrap -- preflight
```

`import` takes the present production bindings from the protected mount or injected environment and the already enrolled workstation identity and provider bindings. It merges missing fields and checks them by reading the item back. `status` reports binding names and counts. `project` writes the vault values as owner-only release files. A configured production bootstrap also reads the vault directly, so the selected release can start without a persistent file projection. Resolve any disagreement between the vault and a projected file before applying.

Keep the workstation Vaultwarden available during initial deployment. After the hosted store is healthy, migrate the vault data using the isolated recovery procedure or import the protected projection into the hosted Founder Village collection. Verify the item by reading it back before switching the runner's binding to `https://vault.foundervillage.org`. [Vaultwarden recovery](RECOVERY.md#vaultwarden)

### Machine credentials and ownership

The runner can also read individual credentials from a protected `NAME_FILE`, a service manager's `CREDENTIALS_DIRECTORY`, the private `~/.config/founder-village/production/credentials/` directory, or an injected variable. Secret values and provider response bodies stay out of release logs.

With a file projection, use mode `0700` on the directory and mode `0600` on each file. Name each file for the binding printed by preflight and load its value from the approved machine secret broker or independent operator custody. Keep the provider, OIDC, storage and recovery bindings available off-host so they can bootstrap a replacement VM and restore the vault.

| Trust supplied by the deployment platform | What the runner derives or issues |
| --- | --- |
| A project-issued `FV_HCLOUD_TOKEN` | Discovers the exact owner-labelled production VM or uses the existing private candidate binding. Checks its provider ID, address, image, architecture, location and whole-project inventory. |
| The existing VM's trusted host enrollment | Reads `FV_SSH_HOST_PUBLIC_KEY`, a previously pinned machine binding, or authenticated server labels `fv-ssh-host-key-1` and `fv-ssh-host-key-2`. Each label holds one 32-character hex half of the raw Ed25519 public key written by the trusted VM factory. Generates both IP and Tunnel entries in the dedicated known_hosts file. |
| An SSH identity already authorized on that VM | Uses an enrolled operator key, or uses `FV_INITIAL_ROOT_SSH_KEY` on first launch to install the generated operator public key and prove operator access before disabling root SSH. |
| Cloudflare access to both apex zones | Verifies the active zones share an owner, checks any existing Founder account pin, discovers the Access team and audience, and provisions an expiring SSH service credential. Its Service Auth policy names that single credential on the SSH application. Browser admin policy continues to require MFA. |
| Workforce policy | `ACCESS_ADMIN_EMAILS` and `OIDC_MFA_ACR` come from the organization's authorization policy. `ACCESS_SSH_EMAILS` preserves named human SSH access when configured. `ROOT_ADMIN_ACTORS` carries approved issuer/subject bindings. The deployment identity receives no application administrator grant. |

Hetzner issues the initial API token inside its project. A machine secret broker can deliver an existing grant on every run. A fresh local key cannot authenticate to an existing VM until that VM has enrolled its public key or trusts a separate enrollment identity. [Hetzner API token issuance](https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/) · [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

### Generate provider grants

For a first deployment, a release operator can use the pinned `cf` CLI's named `founder-village-release` OAuth profile. Authorize token creation and the DNS, Pages, Tunnel and Access permissions in the Founder account. Cloudflare reports which permissions the profile can delegate on each account and zone. [Cloudflare token provisioning](https://developers.cloudflare.com/changelog/post/2026-10-01-account-api-token-provisioning/)

```sh
npm run production:vault -- issue-cloudflare
```

To use a newly issued temporary account token, run `npm run production:vault -- issue-cloudflare --browser` and enter it in the one-use workstation form. The URL expires after three minutes. This path uses the same Terraform issuance checks and saves the four scoped grants. The submitted issuer stays in process memory.

When the runner already has a delegated `FV_CF_TOKEN_ISSUER`, the same command uses the locked Terraform configuration and its persistent workstation state. The command works before the other providers are ready. It verifies both active zones against the private account pin and uses the [same policies as Terraform](../../infra/production-authority/grants.json). It writes each issued token to the owner-only runner mount, merges the available bindings into Vaultwarden and verifies them by reading the item back. An exit status of 1 with `unavailable` names identifies roles the current profile could not issue. Re-running the command preserves available bindings and attempts the outstanding roles. If the provider may have created a token before its value reached the mount, reconcile the named provider token and the private issuance marker before retrying.

The optional Cloudflare credential issuer uses a delegated Founder Village account token with account-token management and visibility of both active zones. It creates dedicated DNS, Tunnel and Pages credentials in that account. Its Terraform state and plans stay in the workstation's protected directory. The runner checks the saved plan before applying and stops on deletions and replacements. [Cloudflare grant configuration](../../infra/production-authority/cloudflare.tf)

Runtime deployments use the organization's OIDC provider. Existing runtimes enrolled in S3 backup mode continue to use their primary bucket, immutable mirror and audit bucket, including their 15 storage bindings. First deployments select workstation mode in the [production template](../../config/production.example.json).

An existing provider deployment can project its issued bindings directly. The [input resolver](../../scripts/production/discovery.ts) accepts dedicated DNS read/write, Tunnel provisioning and Pages credentials, OIDC registration outputs, and backup, mirror, audit and optional file-service credentials. The host receives only its runtime allowlist. Existing keys can be enrolled through `FV_OPERATOR_SSH_KEY`, `FV_RELEASE_SIGNING_KEY`, `AGE_RECIPIENT`, `TEAM_CONTENT_KEY` and `AUDIT_HMAC_KEY`.

## Vaultwarden

The production manifest enables the Vaultwarden service and reserves its hostname for the Tunnel. Use `https://vault.foundervillage.org` as the self-hosted Bitwarden server URL. The vault uses its own credentials and two-step login. Its SQLite database, keys, and attachments live in the dedicated vault data directory. The reverse proxy disables caching and blocks the public `/admin` route.

To enroll users, generate a strong admin passphrase in the operator's independent store. Use the pinned Vaultwarden image's `/vaultwarden hash` command and project only the Argon2id output as `VAULTWARDEN_ADMIN_TOKEN_HASH` in the production credentials directory. Bootstrap applies the hash to Vaultwarden's private configuration. [Vaultwarden admin token instructions](https://github.com/dani-garcia/vaultwarden/wiki/Enabling-admin-page#secure-the-admin_token)

From the workstation, run the following in Bash. The passphrase and invite address go through stdin over pinned SSH.

```sh
vault_workstation="${FV_PRODUCTION_HOME:-$HOME/.local/share/founder-village/production}"
IFS= read -r -p 'Invite email: ' vault_invitee
IFS= read -r -s -p 'Vault admin passphrase: ' vault_admin
printf '\n' >&2
printf '%s\n%s\n' "$vault_invitee" "$vault_admin" |
  ssh -F /dev/null -T -o 'ProxyCommand=cloudflared access ssh --hostname %h' \
    -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null \
    -o "UserKnownHostsFile=$vault_workstation/current/known_hosts" -o IdentitiesOnly=yes \
    -i "$vault_workstation/identity/operator" fv@ssh.foundervillage.org \
    'cd /opt/founder-village && sudo -n bin/fv --config config/production.private.json vaultwarden-invite'
unset vault_invitee vault_admin
```

The invited user can open `https://vault.foundervillage.org/#/signup` and register with the invited email address. Confirm enrollment with the user before sharing an organization collection. Public signups and organization invitations are disabled. [Vaultwarden invitation behavior](https://github.com/dani-garcia/vaultwarden/wiki/Disable-registration-of-new-users#invitations-via-the-admin-page) · [Vaultwarden recovery](RECOVERY.md#vaultwarden)

## Check an existing VM

For a VM already allocated in the dedicated Hetzner project, start with the provider-only example and make a mode-0600 copy at `config/candidate.private.json`. Set the environment, exact server name, and provider server ID and IPv4 from the approved project. For a Helsinki CX23, the provider selection is `hel1`, `cx23` and `amd64`. Supply `root_disk_gb` to verify the VM's reported root disk capacity. Bind any registered keys or other project resources as documented in the provisioning runbook. [Candidate manifest example](../../config/candidate.example.json) · [Hetzner locations](https://docs.hetzner.com/cloud/general/locations/) · [Provisioning and private catalog](PROVISIONING.md)

With a read-only token for the dedicated Founder Village project in `FV_HCLOUD_TOKEN`, run the audit from the operator workstation. It checks the whole project and reports the bound VM's location, platform, server type, stock Ubuntu 24.04 or 26.04 image, and root disk. Supply `provider.image` to require an exact match to the reported image. The installation procedure also checks the running OS and architecture over pinned SSH. [Hetzner project-scoped API tokens](https://docs.hetzner.com/cloud/api/getting-started/using-api/) · [Hetzner server response schema](https://github.com/hetznercloud/hcloud-go/blob/main/hcloud/schema/server.go) · [First-launch procedure](PROVISIONING.md)

```sh
bin/fv --config config/candidate.private.json candidate-audit
```

## Inspect the generated inputs

For individual diagnostics, use the mode-0600 production manifest under the workstation's `current/` directory. The remaining commands illustrate the underlying release steps. [Production manifest template](../../config/production.example.json) · [Provisioning and private catalog](PROVISIONING.md)

Both apex zones must be active in the same Cloudflare account as the Pages project. Use that account for the `foundervillage.org` Tunnel too. Use the Pages reconciliation command for the apex records. Tunnel reconciliation owns the service subdomains. [Cloudflare Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

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
