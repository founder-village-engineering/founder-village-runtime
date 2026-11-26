# Release and rollback

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

## Build and sign on the workstation

One release targets one Linux architecture. The Helsinki CX23 uses `amd64`. The builder requires a local Docker Engine, the locked checkout, Git, Gitleaks and OpenSSH. It compiles the Rust CLI, native Node runtime and dependencies, and TypeScript services locally. It exports the six pinned runtime images and scans the application image. The signed manifest binds the exact architecture, image identities, application SBOM, checkout, CLI and host files. The install transfers an offline bundle over pinned SSH. [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/)

Keep a dedicated release-signing key on the workstation or in its SSH agent. Verify the public key fingerprint through an independent trusted channel. Keep a single trusted public line in a separate operator-controlled file outside both the checkout and the release directory, using this form with the actual Ed25519 public key. [OpenSSH allowed signers](https://man.openbsd.org/ssh-keygen#ALLOWED_SIGNERS)

```text
founder-village-release namespaces="fv-release-v3" ssh-ed25519 <base64-public-key>
```

Use a new output path in an operator-owned private directory and an audited clean checkout. A passphrase-protected private key can stay in the SSH agent while the build references its public file. An explicit local test build from a dirty checkout uses `--allow-dirty` and records a separate content-derived revision.

```sh
npm ci
npm run release:local -- --arch amd64 --out "$release_dir" \
  --signing-key "$signing_key" --allowed-signers "$allowed_signers"
```

The full build-source archive stays with the workstation evidence. Populate `releaseDirectory` and `allowedSigners` in the private bootstrap settings. The VM independently checks the signer, artifact hashes, architecture and image identities. Its root-owned trust file is `/etc/fv/release.allowed_signers`. A replacement signer requires a separately authorized change to the host trust file. Protect the operator SSH key separately from the signing key. [Provisioning](PROVISIONING.md)

## Stage and promote

From the Mac run the bootstrap against the console-pinned address for first install or the verified Access SSH hostname for updates.

```sh
node --import tsx scripts/remote-bootstrap.ts config/bootstrap.private.json
runtime_revision=$(jq -er .revision "$release_dir/source-manifest.json")
```

Use that revision in an authenticated SSH session on the host. A subsequent install stages the generation alongside the active release. The runtime starts from the locally loaded image IDs. Promotion verifies backup and immutable-copy readiness, runs additive migrations, exercises the inactive API and admin routes, and switches the proxy only after the expected revision passes.

```sh
cd /opt/founder-village
manifest=config/production.private.json
sudo bin/fv --config "$manifest" release promote --revision "$runtime_revision"
sudo bin/fv --config "$manifest" doctor
```

Once ingress is enabled, verify readiness, TLS expiry and serving revision from the workstation. The local uptime LaunchAgent can repeat the readiness and TLS check every ten minutes while the operator session is running.

```sh
PUBLIC_API_URL=https://api.example.com PUBLIC_API_REVISION="$runtime_revision" node scripts/probe.ts
PUBLIC_API_URL=https://api.example.com npm run uptime:install
```

Browser-originated production operations require fresh MFA with a nonce bound to the operation. The runner independently verifies authorization and consumes it once. Expired, failed, or uncertain operations require reconciliation and a fresh authorization.

A failed candidate keeps the current proxy route. If a cutover or worker check fails, the deployer restores the prior settings and route. Schema migrations must remain compatible with both colors. Manual rollback uses the previous verified API image and restarts its workers. Keep the receipt and reconcile the running release after an interrupted promotion.

```sh
sudo bin/fv --config "$manifest" release rollback
sudo bin/fv --config "$manifest" doctor
```

The first launch has no previous color to roll back to. Stop public routing with `sudo systemctl stop fv-ingress.service` if a serving fault requires containment. Use the Hetzner console for stopping or restarting ingress because the same connector carries operator SSH. The runtime service restores promoted services from pinned image references on reboot. The ingress service is enabled separately and checks private readiness before starting Cloudflare Tunnel.

`npm run release:verify` runs the expanded local checks with source fingerprints. Public Pages publication, cloud provisioning, public ingress, authenticated behavior, offsite-copy verification, and clean-host recovery each require their own evidence.
