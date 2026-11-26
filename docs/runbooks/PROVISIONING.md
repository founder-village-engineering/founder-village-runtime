# Provisioning and first launch

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

[The staging example](../../config/remote.example.json) uses Ubuntu 24.04 LTS and [the production example](../../config/production.example.json) uses Ubuntu 26.04 LTS. Both target a Helsinki CAX11 (`hel1`, `eu-central`, Linux ARM64). Set `provider.architecture` to `amd64` alongside the matching Hetzner server type for an x86 host. Match `provider.image` to the installed Ubuntu LTS version. Assign the VM to one environment. Staging and production use separate servers, domains, and secret catalogs. Use one-label API and admin names under the configured public zone. [Hetzner locations](https://docs.hetzner.com/cloud/general/locations/) · [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

## 1. Bind the existing VM and its network

For unattended production, the runner performs the following steps from a verified provider binding. Use the production entrypoint to discover the VM, generate the private manifest and keys, and resume through the Tunnel after lockdown. [Unattended production bootstrap](PRODUCTION.md#unattended-production-bootstrap)

On the operator workstation, copy the environment's example to `config/<environment>.private.json` with mode 0600. Set `project` to the exact server name in the Hetzner project. For a VM created in the Hetzner Console, add `provider.existing_server` with its numeric `id` and assigned `ipv4` from that console. Keep the address and ID in this private manifest. The example's loopback SSH CIDR is a placeholder. Set a temporary allowlist for the operator's actual public IPv4 `/32` or IPv6 `/128`.

Complete the Cloudflare account, zone, team and exact managed API, admin, and SSH names, OIDC endpoints and named root actors, and backup mode. The example enables Tunnel-based operator SSH through `cloudflare.ssh_domain`. Use a distinct one-label hostname such as `ssh-dev.example.com` for staging. The admin Access audience is filled by the Cloudflare bootstrap. With `npm ci` installed on the workstation, use `cf_project foundervillage status` in a workstation shell to confirm the signed-in account and active zone. Use that account's ID and zone in the private manifest. Pin the launcher hash using `shasum -a 256 node_modules/cf/bin/cf`. The example points to that launcher under the VM's fixed install path.

```sh
manifest=config/staging.private.json
bin/fv --config "$manifest" validate
bin/fv --config "$manifest" provision plan
bin/fv --config "$manifest" provision audit
bin/fv --config "$manifest" provision status
bin/fv --config "$manifest" provision apply
bin/fv --config "$manifest" provision status
```

Supply a token issued inside the dedicated Founder Village project as `FV_HCLOUD_TOKEN` through the workstation secret store. Existing callers may supply `HCLOUD_TOKEN` and undergo the same project checks. Use read-only credentials for audit and status. The audit uses the same project inventory checks that run before apply can write. It prints counts by resource class. Correctly scoped credentials must see the bound server and its declared keys, and must fail to see resources pinned to an independent project. [Hetzner project-scoped API tokens](https://docs.hetzner.com/cloud/api/getting-started/using-api/)

For the first release on a pinned VM, create a read/write API token in the dedicated project's Hetzner Console. In an interactive workstation terminal, run the following command and paste the new token at the hidden prompt. The command validates the token against the pinned production candidate and project inventory, then stores it in the configured Vaultwarden item and checks the saved value. A protected runner can pipe the new token directly into the same npm command. [Vaultwarden setup](PRODUCTION.md#vaultwarden-distribution)

```sh
python3 -c 'import getpass; print(getpass.getpass("New Hetzner project token: "))' | npm run --silent production:enroll-hetzner
```

For browser entry on the workstation, run `npm run --silent production:enroll-hetzner -- --browser`. Open the printed loopback URL and submit the token within three minutes. The command reports the candidate audit and Vaultwarden read-back in the terminal.

The audit reads all pages of servers, registered SSH keys, firewalls, networks, primary and floating IPs, volumes, load balancers, placement groups, certificates, DNS zones, backups, snapshots and Storage Boxes. It recognizes the bound VM, its assigned IPs and volumes, images attributable to admitted servers, and the managed firewall and network. Declare any additional approved project resource by API collection name and numeric ID in the private `provider.project_resource_ids` object. For example, standalone snapshot IDs go under `snapshots`. Review the resource owner in the provider console before adding a binding. Keep the private manifest and IDs out of version control. The provisioner enumerates Storage Boxes through the separate Hetzner API using the same project token. Bind each box by its provider ID under `storage_boxes`, including an unused box. A missing, inaccessible or unexpected box stops provisioning. Bucket policies, data-plane credentials and restore access require separate checks. [Hetzner API endpoints](https://docs.hetzner.cloud/)

The bound path checks the server ID, name, IPv4, location, type, OS image, CPU architecture, ownership and attachments. It rejects foreign or selector-based firewall attachments, verifies the managed network, reads back the applied state, and enables delete and rebuild protection. A project containing another tenant must be separated by its owner before applying. Preserve independent console or authenticated private SSH access during a transfer. In Tunnel SSH mode the initial firewall allows the temporary SSH source CIDRs. The final firewall has zero public inbound rules for IPv4 and IPv6. [Hetzner project transfers](https://docs.hetzner.com/cloud/general/faq/) · [Cloud firewall behavior](https://docs.hetzner.com/cloud/firewalls/faq/)

For a **new allocation**, omit `existing_server`, configure `provider.ssh_key_ids`, and use `provision apply --public-key /protected/operator.pub`. The provisioner resolves the correct Ubuntu system image before creating the server. Cloud-init creates the `fv` operator with the supplied Ed25519 key and disables root and password SSH. The private provider receipt in `.state/<environment>/provider.json` contains the allocated address.

## 2. Install the signed release over pinned SSH

Read the host's Ed25519 public key in the Hetzner Console using `cat /etc/ssh/ssh_host_ed25519_key.pub`. Put the verified address and key in a dedicated private `known_hosts` file. Keep the provider console open until operator SSH and sudo have been verified.

Build the signed bundle on the operator workstation for the architecture in the private provider manifest. The CX23 uses Linux AMD64. Copy the bootstrap example to mode-0600 `config/bootstrap.private.json`. Set `releaseDirectory`, the independent `allowedSigners` file, the manifest and the SSH paths. [Workstation build and signing](DEPLOYMENT.md) · [Bootstrap example](../../config/bootstrap.example.json)

```sh
node --import tsx scripts/remote-bootstrap.ts config/bootstrap.private.json
```

`initialRootPublicKey` applies only to an existing VM with initial root key access. The tool uses the console-pinned host key, binds that session to the configured existing IPv4, and proves a separate `fv` session works before disabling root SSH. Omit the field for cloud-init-created VMs and later updates. Keep the operator key on the workstation. The Mac and VM independently verify the signed manifest and artifacts. The root-owned installation under `/opt/founder-village` contains a precompiled Linux CLI, Node, compiled host scripts, dependencies, and a platform-specific image archive. Docker on the VM imports these images and runs the services.

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

Scope `CF_READ_TOKEN` to the Founder Village zone and grant it access to zone details. On apply and verify, the provisioner checks the returned zone ID, name, active status and owning account before it uses Tunnel, Access or DNS. It repeats the ownership check before changes. [Cloudflare zone details](https://developers.cloudflare.com/api/resources/zones/methods/get/)

On the workstation, supply the exact, separately approved browser and SSH administrator allowlists in a protected file. Select the Founder Village profile. Its default read-only login supports account and DNS inspection. Tunnel or Access reconciliation requires a login with the permissions for the requested operation. The provisioner rechecks the active zone, account, routes, proxied CNAMEs and MFA policies. The signed-in CLI session stays on the workstation. A protected workstation invocation may also select separate read, write, and provisioning tokens using `FV_CLOUDFLARE_WORKSTATION=1`. [Cloudflare Tunnel origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)

```sh
manifest=config/production.private.json
cf_project foundervillage exec -- node --env-file=/protected/fv-cloudflare.env --import tsx scripts/cloudflare-bootstrap.ts "$manifest" plan
cf_project foundervillage exec -- node --env-file=/protected/fv-cloudflare.env --import tsx scripts/cloudflare-bootstrap.ts "$manifest" apply
```

Apply writes the Access audience to the private manifest and a mode-0600 connector token to `.state/operator/cloudflare/<environment>/connector.token` (relative to `CF_WORK_DIR` when overridden). Put only that connector credential in the approved host catalog as `CLOUDFLARE_TUNNEL_TOKEN`. Transfer the updated private manifest through the pinned bootstrap procedure. In the verified operator session run the following commands against the selected environment.

```sh
cd /opt/founder-village
manifest=config/production.private.json
sudo bin/fv --config "$manifest" render
sudo ./.fv-current/node "$(realpath dist/scripts/materialize-service-env.js)" production
sudo bin/fv --config "$manifest" backup capture
sudo bin/fv --config "$manifest" backup verify
sudo bin/fv --config "$manifest" backup restore-drill
```

Substitute the chosen environment consistently in paths and arguments. Bootstrap the named administrator with `fv admin-grant` and explicit actions and applications. Use the IdP's exact signed assurance value for `OIDC_MFA_ACR` and verify phishing-resistant MFA, revocation, and step-up using the [administrator security runbook](ADMIN_SECURITY.md).

Follow [release promotion](DEPLOYMENT.md) using the signed manifest revision and image identities from the workstation bundle. After `fv doctor` passes, enable the runtime units and open ingress.

```sh
sudo systemctl enable fv-runtime.service
sudo systemctl enable --now fv-ops.service fv-domain-worker.service fv-monitor.service
sudo systemctl enable --now fv-backup.timer fv-restore.timer fv-audit.timer
sudo systemctl enable --now fv-ingress.service
```

On an existing runtime, restart `fv-domain-worker.service` to load the tunnel DNS restrictions. Restart `fv-ingress.service` from the provider console or a verified bootstrap session to attach the dedicated SSH bridge.

From the workstation, run the same Cloudflare bootstrap command with `verify` after the connector starts. It reads the deployed configuration, DNS, and connector status using `cf`. Use a scoped read token for verification where available. Revoke the temporary provisioning token and remove its protected file after verification. Audit other zones and the assigned IPv6 range for historical origin records before treating the address as private. [Protect your origin server](https://developers.cloudflare.com/fundamentals/security/protect-your-origin-server/)

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
| Legacy S3 database backup | `BACKUP_S3_KEY`, `BACKUP_S3_SECRET`. Endpoint, bucket and region come from the manifest. |
| Recovery escrow | `AGE_RECIPIENT`. The age identity and backup HMAC verification key belong in independent offline custody. |
| Legacy S3 immutable mirror | `IMMUTABLE_ENDPOINT`, `IMMUTABLE_REGION`, `IMMUTABLE_BUCKET`, `IMMUTABLE_ACCESS_KEY`, `IMMUTABLE_SECRET_KEY`. |
| Audit authentication | The workstation generates `AUDIT_HMAC_KEY` and captures the authenticated ledger in its backup. |
| Legacy S3 audit archive | `AUDIT_ENDPOINT`, `AUDIT_REGION`, `AUDIT_BUCKET`, `AUDIT_ACCESS_KEY`, `AUDIT_SECRET_KEY`. |
| Files | `OBJECT_ENDPOINT`, `OBJECT_REGION`, `OBJECT_BUCKET`, `OBJECT_ACCESS_KEY`, `OBJECT_SECRET_KEY`. |
| Alerts | `ALERT_WEBHOOK_URL` for an independent HTTPS receiver. |
| Members payments | `MEMBERS_*` credentials are scoped to the API service. |

Use one private catalog per environment. Test actual storage retention locks, deletion denial, encryption, signed uploads, and recovery credentials. The installer checks available space against the actual artifact and unpacked file sizes before staging the generation. Monitor headroom on the 40 GB VM for upgrades, both application colors, PostgreSQL WAL, and temporary backup transfers. Preserve all runtime volumes and usable recovery points during capacity work.
