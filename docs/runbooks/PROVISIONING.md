# Provisioning and first launch

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

[The staging example](../../config/remote.example.json) uses Ubuntu 24.04 LTS and [the production example](../../config/production.example.json) uses Ubuntu 26.04 LTS. Both target a Helsinki CAX11 (`hel1`, `eu-central`, Linux ARM64). Set `provider.architecture` to `amd64` alongside the matching Hetzner server type for an x86 host. Match `provider.image` to the installed Ubuntu LTS version. Assign the VM to one environment. Staging and production use separate servers, domains, and secret catalogs. Use one-label API and admin names under the configured public zone. [Hetzner locations](https://docs.hetzner.com/cloud/general/locations/) · [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

## 1. Bind the existing VM and its network

On the operator workstation, copy the environment's example to `config/<environment>.private.json` with mode 0600. Set `project` to the exact server name in the Hetzner project. For a VM created in the Hetzner Console, add `provider.existing_server` with its numeric `id` and assigned `ipv4` from that console. Keep the address and ID in this private manifest. The example's loopback SSH CIDR is a placeholder. Set a temporary allowlist for the operator's actual public IPv4 `/32` or IPv6 `/128`.

Complete the Cloudflare account, zone, team and exact managed API, admin, and SSH names, OIDC endpoints and named root actors, backup endpoint, and independently verified immutable storage settings. The example enables Tunnel-based operator SSH through `cloudflare.ssh_domain`. Use a distinct one-label hostname such as `ssh-dev.example.com` for staging. The admin Access audience is filled by the Cloudflare bootstrap. With `npm ci` installed on the workstation, use `node node_modules/cf/bin/cf auth whoami --json` in a private terminal to confirm the intended Cloudflare account. Use that account's ID and zone in the private manifest. Pin the launcher hash using `shasum -a 256 node_modules/cf/bin/cf`. The example points to that launcher under the VM's fixed install path.

```sh
manifest=config/staging.private.json
bin/fv --config "$manifest" validate
bin/fv --config "$manifest" provision plan
bin/fv --config "$manifest" provision audit
bin/fv --config "$manifest" provision status
bin/fv --config "$manifest" provision apply
bin/fv --config "$manifest" provision status
```

Supply a token issued inside the dedicated Founder Village project as `FV_HCLOUD_TOKEN` through the workstation secret store. Existing callers may supply `HCLOUD_TOKEN`; both paths undergo identical project checks. Use read-only credentials for audit and status. The audit uses the same Cloud API inventory checks that run before apply can write. It prints counts by resource class. Correctly scoped credentials must see the bound server and its declared keys, and must fail to see resources pinned to an independent project. [Hetzner project-scoped API tokens](https://docs.hetzner.com/cloud/api/getting-started/using-api/)

The audit reads all pages of servers, registered SSH keys, firewalls, networks, primary and floating IPs, volumes, load balancers, placement groups, certificates, DNS zones, backups and snapshots. It recognizes the bound VM, its assigned IPs and volumes, images attributable to admitted servers, and the managed firewall and network. Declare any additional approved project resource by API collection name and numeric ID in the private `provider.project_resource_ids` object. For example, standalone snapshot IDs go under `snapshots`. Review the resource owner in the provider console before adding a binding. Keep the private manifest and IDs out of version control. Independent storage credentials and object-store access require their own checks.

The bound path checks the server ID, name, IPv4, location, type, OS image, CPU architecture, ownership and attachments. It rejects foreign or selector-based firewall attachments, verifies the managed network, reads back the applied state, and enables delete and rebuild protection. A project containing another tenant must be separated by its owner before applying. Preserve independent console or authenticated private SSH access during a transfer. In Tunnel SSH mode the initial firewall allows the temporary SSH source CIDRs. The final firewall has zero public inbound rules for IPv4 and IPv6. [Hetzner project transfers](https://docs.hetzner.com/cloud/general/faq/) · [Cloud firewall behavior](https://docs.hetzner.com/cloud/firewalls/faq/)

For a **new allocation**, omit `existing_server`, configure `provider.ssh_key_ids`, and use `provision apply --public-key /protected/operator.pub`. The provisioner resolves the correct Ubuntu system image before creating the server. Cloud-init creates the `fv` operator with the supplied Ed25519 key and disables root and password SSH. The private provider receipt in `.state/<environment>/provider.json` contains the allocated address.

## 2. Install the signed release over pinned SSH

Read the host's Ed25519 public key in the Hetzner Console using `cat /etc/ssh/ssh_host_ed25519_key.pub`. Put the verified address and key in a dedicated private `known_hosts` file. Keep the provider console open until operator SSH and sudo have been verified.

Download `fv-linux-arm64-<source-sha>` from the successful tag workflow. Use `fv-linux-amd64-<source-sha>` for an x86 VM. Copy [the bootstrap example](../../config/bootstrap.example.json) to a mode-0600 `config/bootstrap.private.json` and set its protected paths. Run from a trusted checkout on the workstation with the locked npm dependencies and Cosign installed.

```sh
node --import tsx scripts/remote-bootstrap.ts config/bootstrap.private.json
```

`initialRootPublicKey` applies only to an existing VM with initial root key access. The tool uses the console-pinned host key, binds that session to the configured existing IPv4, and proves a separate `fv` session works before disabling root SSH. Omit the field for cloud-init-created VMs and later updates. Keep the operator key on the workstation. The script verifies the signed source archive, manifest, and native ELF before upload. It rechecks the bytes on the VM, installs a root-owned tree under `/opt/founder-village`, and configures updates, Docker logging and packet filtering, and systemd. Host tools use the locked TypeScript dependencies and checksum-pinned Node and Cosign. The tagged workflow builds the application image off-host.

## 3. Initialize private services

Install the mode-0600 `/opt/founder-village/secrets/<environment>.env` from the approved secret store through the authenticated operator session, or restore an authenticated encrypted recovery bundle. Keep temporary Hetzner and Cloudflare provisioning credentials separate from the runtime catalog.

On the host, select the corresponding manifest. The runtime service initializes credentials and starts PostgreSQL, RabbitMQ, Hasura, and migrations. It leaves public ingress disabled until release promotion.

```sh
cd /opt/founder-village
manifest=config/staging.private.json
sudo systemctl start fv-runtime.service
```

For an older deployment using WireGuard, follow the [WireGuard enrollment procedure](APPLICATIONS.md#wireguard). Tunnel SSH deployments can take their first backup without creating WireGuard state. Recovery preserves a complete key and peer inventory if one exists.

## 4. Configure Access and promote before opening ingress

From the host, use a temporary mode-0600 env file supplying `CLOUDFLARE_PROVISION_TOKEN`, `ACCESS_ADMIN_EMAILS`, `ACCESS_SSH_EMAILS`, and a protected `CF_WORK_DIR`. SSH operators receive host authority, so supply their exact email allowlist separately from the browser admins. The script uses the checksum-pinned `cf` CLI with the manifest's account and zone. Use an account-scoped token for Tunnel and Access and the restricted DNS token from the runtime catalog. The script reads back the routes, proxied tunnel CNAMEs, and both named MFA policies. For a bound VM it also checks zone records for its configured IPv4. Admin and SSH routes validate their own Access audiences. The admin application independently verifies Access and its OIDC assurance requirements. [Cloudflare Tunnel origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)

```sh
sudo /usr/local/bin/node --env-file=.state/staging.env --env-file=/protected/cloudflare-bootstrap.env --import tsx scripts/cloudflare-bootstrap.ts "$manifest" plan
sudo /usr/local/bin/node --env-file=.state/staging.env --env-file=/protected/cloudflare-bootstrap.env --import tsx scripts/cloudflare-bootstrap.ts "$manifest" apply
sudo bin/fv --config "$manifest" render
sudo /usr/local/bin/node --import tsx scripts/materialize-service-env.ts staging
sudo bin/fv --config "$manifest" backup capture
sudo bin/fv --config "$manifest" backup verify
sudo bin/fv --config "$manifest" backup restore-drill
```

Substitute the chosen environment consistently in paths and arguments. Bootstrap the named administrator with `fv admin-grant` and explicit actions and applications. Use the IdP's exact signed assurance value for `OIDC_MFA_ACR` and verify phishing-resistant MFA, revocation, and step-up using the [administrator security runbook](ADMIN_SECURITY.md).

Follow [release promotion](DEPLOYMENT.md) using the signed manifest revision and exact image digest from the downloaded artifact. After `fv doctor` passes, enable the runtime units and open ingress.

```sh
sudo systemctl enable fv-runtime.service
sudo systemctl enable --now fv-ops.service fv-domain-worker.service fv-monitor.service
sudo systemctl enable --now fv-backup.timer fv-restore.timer fv-audit.timer
sudo systemctl enable --now fv-ingress.service
```

On an existing runtime, restart `fv-domain-worker.service` to load the tunnel DNS restrictions. Restart `fv-ingress.service` from the provider console or a verified bootstrap session to attach the dedicated SSH bridge.

Run the same Cloudflare bootstrap command with `verify` after the connector starts. It reads the deployed configuration, DNS, and connector status using `cf`. Use a scoped read token for verification where available. Revoke the temporary provisioning token and remove its protected file after verification. Audit other zones and the assigned IPv6 range for historical origin records before treating the address as private. [Protect your origin server](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)

## 5. Close public inbound access

Install the Cloudflare `cloudflared` SSH client on the operator workstation. Add a second entry in the dedicated `known_hosts` file, using the configured `ssh_domain` and the same console-verified Ed25519 host key. Verify a fresh Access MFA login, OpenSSH key authentication, and `sudo -n true` through the Tunnel. Keep the provider console open for recovery. [Cloudflare client-side SSH](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/ssh/ssh-cloudflared-authentication/)

```sh
ssh -o 'ProxyCommand=cloudflared access ssh --hostname %h' \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/protected/fv-known-hosts \
  -i /protected/operator-key fv@ssh.example.com sudo -n true
```

Verify HTTPS API readiness and its exact serving revision from outside the VM, then verify the admin Access challenge and real sign-in. Set `ssh_cidrs` to `[]` in the host and workstation manifests. Use `sudo bin/fv --config "$manifest" host apply` on the VM to remove its bootstrap allowlist. From the workstation, apply the matching provider configuration. The CLI tests a fresh pinned SSH session over Cloudflare before closing the Hetzner firewall.

```sh
bin/fv --config "$manifest" provision apply \
  --tunnel-known-hosts /protected/fv-known-hosts --tunnel-identity /protected/operator-key
bin/fv --config "$manifest" provision status
```

Require `firewall_rules_match: true` and `public_inbound_closed: true`. Confirm the Tunnel still works and direct access to the VM's public IPv4 and IPv6 is denied. Keep provider, deployed, offsite, and clean-host recovery evidence. The single VM retains its assigned addresses for outbound connectivity. Removing the addresses themselves requires a tested private Internet egress path and a separate powered-off Hetzner network change. [Tunnel egress](https://developers.cloudflare.com/tunnel/configuration/), [Hetzner Primary IPs](https://docs.hetzner.com/cloud/servers/primary-ips/faq/)

## Private catalog

| Boundary | Settings |
| --- | --- |
| Domain adapter | `CF_READ_TOKEN`, `CF_WRITE_TOKEN`. Account, zone, allowed names, launcher and checksum come from the manifest. |
| OIDC | `OIDC_MFA_ACR` matching the IdP's signed assurance claim. |
| Database backup | `BACKUP_S3_KEY`, `BACKUP_S3_SECRET`. Endpoint, bucket and region come from the manifest. |
| Recovery escrow | `AGE_RECIPIENT`. The age identity and backup HMAC verification key belong in independent offline custody. |
| Immutable mirror | `IMMUTABLE_ENDPOINT`, `IMMUTABLE_REGION`, `IMMUTABLE_BUCKET`, `IMMUTABLE_ACCESS_KEY`, `IMMUTABLE_SECRET_KEY`. |
| Independent audit | `AUDIT_ENDPOINT`, `AUDIT_REGION`, `AUDIT_BUCKET`, `AUDIT_ACCESS_KEY`, `AUDIT_SECRET_KEY`, `AUDIT_HMAC_KEY`. |
| Files | `OBJECT_ENDPOINT`, `OBJECT_REGION`, `OBJECT_BUCKET`, `OBJECT_ACCESS_KEY`, `OBJECT_SECRET_KEY`. |
| Alerts | `ALERT_WEBHOOK_URL` for an independent HTTPS receiver. |
| Members payments | `MEMBERS_*` credentials are scoped to the API service. |

Use one private catalog per environment. Test actual storage retention locks, deletion denial, encryption, signed uploads, and recovery credentials. Host installation checks for 8 GiB of free space under `/opt`. Monitor headroom on the 40 GB VM for upgrades, both application colors, PostgreSQL WAL, and temporary backup transfers. Preserve all runtime volumes and usable recovery points during capacity work.
