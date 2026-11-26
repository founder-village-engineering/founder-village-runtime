# Backup and disaster recovery

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Targets: PostgreSQL RPO ≤ 300 seconds, full-runtime RTO ≤ 4 hours, object/config RPO ≤ 24 hours. These require measurement on the actual provider, workload, credentials, and network.

The database image includes pgvector and pinned pgBackRest. PostgreSQL archives WAL continuously. In workstation mode the VM writes an encrypted pgBackRest repository to its private backup volume. Local fixtures also use an encrypted local repository. Previously enrolled S3 runtimes continue to archive to their configured bucket. A daily full-backup systemd timer is the conservative implementation default; `backup capture --kind diff` supports an operator-selected differential cadence. Keep the full dependency chain for the configured 30-day window.

```sh
bin/fv backup capture --kind full
bin/fv backup verify
bin/fv backup restore-drill
```

The physical backup includes all registered application databases, Hasura metadata, the control database, roles, and extension state. The isolated drill creates and archives a fresh named WAL recovery point, starts a fresh recovery container using the authenticated source settings, verifies replay reached that point, and checks the vector extension, migration state, and queries in every application database. It does not start restored workers, connect restored services to production, or replace a serving data volume. Its receipt explicitly records `clean_host: false`.

## Workstation copies

The workstation pulls the completed capture into the checkout’s private `backups/` directory. Each snapshot contains the encrypted pgBackRest repository, archived WAL through the capture’s named restore point, the signed recovery bundle and its encrypted audit archive. Git and the release packager exclude the directory. The recovery identity and independently escrowed verifier stay in the private workstation identity directory.

```sh
npm run backup:pull
npm run backup:verify
npm run backup:schedule -- --plan
```

Production bootstrap installs the scheduled pull on the Mac after verifying the sealed SSH tunnel. Pulls authenticate the descriptor, check the streamed byte count and SHA-256, and return the saved bytes to a network-isolated restore drill. Inspect the time of the last successful capture and pull when assessing exposure to a VM loss. With daily captures the workstation can be a day or more behind, including time the Mac is offline. The five-minute WAL target on the running host does not establish a five-minute off-host recovery point. A clean-host rebuild requires a separate exercise.

If the original VM is lost, choose the snapshot directory under `backups/` for the recovery point you want. Set `backup_id` to its directory name and use the independently retained workstation identity. Run the following in the matching Founder Village checkout. These steps authenticate one saved generation offline and unpack it into a new private directory.

```sh
set -eu
umask 077
npm run backup:verify -- "$backup_id"
restore_dir=$(mktemp -d)
tar -xf "backups/$backup_id/snapshot.tar" -C "$restore_dir" repository recovery
production_home=${FV_PRODUCTION_HOME:-"$HOME/.local/share/founder-village/production"}
age_identity_file=${FV_BACKUP_AGE_IDENTITY_FILE:-"$production_home/identity/recovery.agekey"}
age -d -i "$age_identity_file" -o "$restore_dir/backup-verifier" "$production_home/identity/backup-verifier.age"
export BACKUP_HMAC_KEY_FILE="$restore_dir/backup-verifier"
node --import tsx scripts/verify-recovery.ts "$restore_dir/recovery"
```

The `repository/` directory is the encrypted pgBackRest repository. Mount it read-only at `/var/lib/pgbackrest` on the isolated replacement. Recover the matching catalog with the verified `recovery/` bundle and age identity. Use the catalog’s pgBackRest cipher passphrase and the named recovery point in the authenticated `backup-receipt.json` for a restore into a fresh PostgreSQL data directory. Keep the verifier and decrypted catalog in protected operator custody.

## Legacy S3 copies

In S3 mode, remote capture additionally builds an age-encrypted configuration/secret bundle and runs independently credentialed immutable replication. Objects are streamed through a bounded temporary file, SHA-256 checked at the destination, version recorded, and retained in compliance mode. The chosen S3 provider must support the required operations; incompatibility fails the operation. Local-copy receipts never claim offsite or immutable-copy proof.

In S3 mode, remote `backup verify` also requires completion of the immutable copy for the exact authenticated backup receipt. A partial replication blocks promotion until a completed capture passes verification.

Recovery bundles contain an authenticated exact artifact set. Verification rejects extras, omissions, altered sizes/checksums, duplicate names, symlinks, and unsafe names. Preserve the backup-HMAC verification key independently of the backup repository, along with the age private identity. The recipient alone does not authenticate the sender.

On a replacement host with the matching signed source:

```sh
node --import tsx scripts/verify-recovery.ts /protected/recovery-bundle
node --import tsx scripts/restore-secrets.ts production /protected/recovery-bundle /offline/age-identity
```

Provide `BACKUP_HMAC_KEY_FILE` from independent custody. Secrets are decrypted and validated before replacing any current catalog. The previous catalog is preserved. For a WireGuard deployment, restore the encrypted server key and peer inventory through the verified artifact procedure before applying the interface. For a Tunnel SSH deployment, recover or rotate the connector credential and verify Access, host keys, and the public-inbound firewall proof before reopening traffic.

## Workstation audit recovery

In workstation backup mode the audit worker verifies the database hash chain and records signed checkpoints. Each recovery bundle includes `audit.jsonl.age`, a full ledger export from one PostgreSQL snapshot, including entries since the latest checkpoint. The export authenticates the environment, backup fingerprint, records and count with the enrolled audit HMAC key and encrypts them for the workstation's recovery recipient. The workstation copy retains this archive with that recovery point. S3 deployments continue to write signed segments to the configured audit bucket.

After verifying the recovery bundle, use its backup fingerprint and supply `AUDIT_HMAC_KEY_FILE` from the workstation's independent custody. Verification streams the records and prints only a count.

```sh
set -o pipefail
age -d -i "$age_identity_file" "$recovery_bundle/audit.jsonl.age" |
  FV_ENV=production node --import tsx scripts/verify-audit-snapshot.ts "$backup_fingerprint"
```

## Vaultwarden

For a manifest with `vaultwarden_domain` enabled, the backup timer briefly stops Vaultwarden to archive the SQLite database, signing keys, attachments and sends together. The archive streams through age encryption into `vaultwarden-data.tar.age` and the runtime restarts Vaultwarden. The recovery manifest authenticates the archive. Workstation mode includes it in the transferred snapshot. S3 mode records the SHA-256 and version of the object in the immutable mirror. The transfer supports encrypted vault archives up to 4 GiB. The Vaultwarden admin hash can be projected again from independent operator custody.

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
