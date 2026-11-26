# Backup and disaster recovery

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Targets: PostgreSQL RPO ≤ 300 seconds, full-runtime RTO ≤ 4 hours, object/config RPO ≤ 24 hours. These require measurement on the actual provider, workload, credentials, and network.

The database image includes pgvector and pinned pgBackRest. PostgreSQL archives WAL continuously. Local fixtures use an encrypted local repository; remote environments use encrypted S3 storage. A daily full-backup systemd timer is the conservative implementation default; `backup capture --kind diff` supports an operator-selected differential cadence. Keep the full dependency chain for the configured 30-day window.

```sh
bin/fv backup capture --kind full
bin/fv backup verify
bin/fv backup restore-drill
```

The physical backup includes all registered application databases, Hasura metadata, the control database, roles, and extension state. The isolated drill creates and archives a fresh named WAL recovery point, starts a fresh recovery container using the authenticated source settings, verifies replay reached that point, and checks the vector extension, migration state, and queries in every application database. It does not start restored workers, connect restored services to production, or replace a serving data volume. Its receipt explicitly records `clean_host: false`.

The five-minute database target concerns the active offsite WAL repository. An immutable mirror taken on the daily backup cadence has a separate, up-to-one-day fallback window; configure and verify a tighter mirror cadence if that failure mode also requires five-minute protection.

Remote capture additionally builds an age-encrypted configuration/secret bundle and runs independently credentialed immutable replication. Objects are streamed through a bounded temporary file, SHA-256 checked at the destination, version recorded, and retained in compliance mode. The chosen S3 provider must support the required operations; incompatibility fails the operation. Local-copy receipts never claim offsite or immutable-copy proof.

Remote `backup verify` also requires completion of the immutable copy for the exact authenticated backup receipt. A partial replication blocks promotion until a completed capture passes verification.

Recovery bundles contain an authenticated exact artifact set. Verification rejects extras, omissions, altered sizes/checksums, duplicate names, symlinks, and unsafe names. Preserve the backup-HMAC verification key independently of the backup repository, along with the age private identity. The recipient alone does not authenticate the sender.

On a replacement host with the matching signed source:

```sh
node --import tsx scripts/verify-recovery.ts /protected/recovery-bundle
node --import tsx scripts/restore-secrets.ts production /protected/recovery-bundle /offline/age-identity
```

Provide `BACKUP_HMAC_KEY_FILE` from independent custody. Secrets are decrypted and validated before replacing any current catalog. The previous catalog is preserved. For a WireGuard deployment, restore the encrypted server key and peer inventory through the verified artifact procedure before applying the interface. For a Tunnel SSH deployment, recover or rotate the connector credential and verify Access, host keys, and the public-inbound firewall proof before reopening traffic.

## Vaultwarden

For a manifest with `vaultwarden_domain` enabled, the backup timer briefly stops Vaultwarden to archive the SQLite database, signing keys, attachments and sends together. The archive streams through age encryption into `vaultwarden-data.tar.age` and the runtime restarts Vaultwarden. The recovery manifest authenticates the archive and the immutable copy records its SHA-256 and object version. The transfer supports encrypted vault archives up to 4 GiB. The Vaultwarden admin hash can be projected again from independent operator custody.

On an isolated replacement host, verify the recovery manifest using the independent backup verifier. As the recovery operator, decrypt into a new owner-only directory using the escrowed age identity.

```sh
set -o pipefail
umask 077
mkdir -m 0700 "$vault_restore_dir"
age -d -i "$age_identity_file" "$recovery_bundle/vaultwarden-data.tar.age" |
  tar -xf - -C "$vault_restore_dir"
```

Check SQLite integrity and start the matching pinned Vaultwarden image with the new directory on a private network. Verify you can sign in and retrieve an attachment. Keep the prior data directory for rollback. To activate the restored vault, stop the serving Vaultwarden service, install the verified data at `.state/production/vaultwarden/data` with UID and GID `65532` and mode `0700` on the directory, then start the runtime under the production manifest. Verify the public hostname and the denial of `/admin` before reopening vault access. [Vaultwarden recovery files](https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault)

## Clean-host recovery

For a real disaster:

1. Stop ingress and freeze automated jobs/notifications. Preserve the failed host, current volumes, partial transfers, and independent audit history.
2. Provision a clean replacement VM and install verified source/runtime artifacts. Recover the matching configuration and offline credentials.
3. Use pgBackRest restore into a **new** PostgreSQL data volume. For PITR, select the documented target timestamp and confirm the required backup/WAL chain before recovery. Never run a drill or ordinary deployment against a serving data directory.
4. Verify every application database/source, roles, vector extension/indexes, migrations, object references, and backup inventory. Individual-application recovery uses this isolated cluster as the source for a separately reviewed logical export/import.
5. Reconcile revoked users/admins/sessions/peers, independent audit checkpoints, queue provenance/idempotency, schedules, and external provider effects. Rotate recovered credentials before exposing services. Old outbox `published` rows need a reviewed replay decision, not blanket reset.
6. Rebuild the broker from declarations and replay only validated pending work. Restore objects/versioned references and compare inventories. A database PITR does not rewind object storage or external providers.
7. Run authenticated external acceptance checks and reopen traffic only after confirming actual identities, domains, serving artifact, denial paths, and notifications policy.
8. Record elapsed recovery time and observed data-loss interval. A monthly clean-VM drill is operational work beyond the local isolated-container test; archive its evidence independently.

Do not purge the last usable recovery point to make disk space. Retention cleanup uses a separate identity and is performed only after offsite/immutable verification. Provider retention locks and offline custody must be independently verified.
