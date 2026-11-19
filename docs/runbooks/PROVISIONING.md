# Provisioning and first launch

The first supported remote release target is Ubuntu 24.04 on Linux amd64. Local arm64 container verification is separate. Staging and production must use separate VPS resources and secret catalogs.

1. Copy `config/remote.example.json` to an environment-specific private manifest. Set `environment`, a unique resource `project`, provider region/type/image and SSH key IDs, narrow bootstrap SSH CIDRs, management CIDR, owned domains, Cloudflare account/zone/team, OIDC endpoints/audiences/client ID and root-owned `auth.root_actors`, backup endpoint/bucket/region, and independently verified immutable-copy custody. The staging example contains placeholders and must be deliberately completed; it is not production-ready. Use exactly one label under the owned zone for API/admin and managed records, such as `api-dev.example.com`; nested names and the private `.fv` namespace are not public deployment names.
2. Install locked dependencies with `npm ci`. Pin the actual `cf` launcher path and SHA-256 in the manifest. The executable comes from the locked `cf` npm package; never install an unrelated package named `@cloudflare/cli`.
3. Create a mode-0600 `secrets/<environment>.env` catalog. Allowed external key prefixes are `CF_`, `CLOUDFLARE_`, `BACKUP_S3_`, `IMMUTABLE_`, `AUDIT_`, `OBJECT_`, `ALERT_`, `ACCESS_ADMIN_`, and `AGE_`. Keep provider provisioning credentials outside the VM; `HCLOUD_TOKEN` is read only by the provider CLI. Catalogs and generated state are ignored by Git.
4. Validate and inspect the resource plan:

```sh
bin/fv --config config/staging.private.json validate
bin/fv --config config/staging.private.json provision plan
```

`provision apply --public-key /path/to/operator.pub` creates/converges owned network/firewall/server resources. It does not delete foreign resources or resize a live server. The public key must be Ed25519; cloud-init creates the operator account and disables root/password SSH. Verify the SSH host key through the provider console and write an independent known-hosts file.

5. Obtain signed source/runtime artifacts from the release workflow. `scripts/remote-bootstrap.ts` accepts a private JSON file containing `host`, `knownHosts`, `source`, `sourceBundle`, `binary`, `binaryBundle`, `manifest`, `manifestBundle`, and `config`. It verifies both signatures against `policies/release.json`, uses strict SSH host checking, installs the signed source/binary, and runs host convergence. It deliberately does not copy a secret catalog. Install the environment's catalog through an authenticated protected channel, or restore a verified encrypted recovery bundle.
6. On the host, `fv init` generates distinct credentials without overwriting existing ones. `host apply` installs checksum-pinned Node/cosign, Docker, host hardening, scoped systemd definitions, and compiled TypeScript services. Materialize service environments after secrets are present:

```sh
sudo node --import tsx scripts/materialize-service-env.ts staging
sudo target/release/fv --config config/staging.private.json up
```

7. Configure Cloudflare using `scripts/cloudflare-bootstrap.ts <manifest> plan|apply`, with the generated environment loaded by Node. It manages the named Tunnel, the admin Access app/MFA policy, and explicitly owned ingress records through the common `cf` adapter. Use a separate `CLOUDFLARE_PROVISION_TOKEN`; DNS read/write tokens remain scoped. Supply `ACCESS_ADMIN_EMAILS`. Finish the manifest's Access audience from the created app, rerender, and verify the actual Access policy before enabling browser access. Existing unrelated Access apps/policies are rejected instead of silently adopted.
8. Enroll an operator device using the profile procedure in the applications/access runbook. Verify a recent handshake and real SSH access over the private address before narrowing bootstrap ingress. Maintain provider-console recovery access. Do not automatically replace the control machine's route.
9. Bootstrap the named administrator with explicit actions and applications using `fv admin-grant`. Configure the IdP to require phishing-resistant MFA and satisfy the documented MFA/nonce/auth-time contract. Set `OIDC_MFA_ACR` in the private catalog to its exact assurance value; the backend verifies the returned signed `acr`, not just the authorization request. Verify real sign-in, recovery, revocation and step-up in staging using the [administrator security runbook](ADMIN_SECURITY.md).
10. Capture and restore a backup, configure independent monitoring/alerts, and promote an exact signed release. Start the `ingress` Compose profile only after its Tunnel token and routing have been verified. Enable the applicable systemd services/timers. A provider VM reaching `running` is not runtime/application readiness.

External catalog settings include:

| Boundary | Required settings |
| --- | --- |
| Domain adapter | `CF_READ_TOKEN`, `CF_WRITE_TOKEN`, `CF_WORK_DIR`; account/zone/names/binary/hash come from the manifest. |
| Database backup | `BACKUP_S3_KEY`, `BACKUP_S3_SECRET`; endpoint/bucket/region come from the manifest. |
| Recovery escrow | `AGE_RECIPIENT`; independent age identity and backup-HMAC verification key stored offline. |
| Immutable mirror | `IMMUTABLE_ENDPOINT`, `IMMUTABLE_REGION`, `IMMUTABLE_BUCKET`, `IMMUTABLE_ACCESS_KEY`, `IMMUTABLE_SECRET_KEY`, optional bounded retention days. |
| Independent audit | `AUDIT_ENDPOINT`, `AUDIT_REGION`, `AUDIT_BUCKET`, `AUDIT_ACCESS_KEY`, `AUDIT_SECRET_KEY`, `AUDIT_HMAC_KEY`. |
| Files | `OBJECT_ENDPOINT`, `OBJECT_REGION`, `OBJECT_BUCKET`, `OBJECT_ACCESS_KEY`, `OBJECT_SECRET_KEY`. |
| Alerts | `ALERT_WEBHOOK_URL` targeting an independent HTTPS receiver; no live test sends are performed by the acceptance suite. |

Use restrictive per-service provider policies and test actual storage encryption, retention locks, deletion denial, signed uploads, and recovery credentials. A configuration flag is not provider proof.
