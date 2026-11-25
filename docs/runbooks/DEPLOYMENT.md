# Release and rollback

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

A protected `vMAJOR.MINOR.PATCH` tag on a commit reachable from `main` builds on native GitHub-hosted AMD64 and ARM64 runners. Each runner builds the Linux Rust CLI, checks the application containers against the local data stack, and scans its native image. The final job signs the exact multi-platform registry index and the source and CLI artifacts. The signed manifest binds the image index, both CLI hashes, and the exact source inventory to one revision. Tags and the `main` branch require repository-level protection. Configure the GHCR package for anonymous pulls of the public release. [GitHub-hosted runner platforms](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Docker multi-platform images](https://docs.docker.com/build/building/multi-platform/)

Promote from an authenticated operator SSH session through Cloudflare Access using the root-owned CLI. Older manifests can use their existing WireGuard route. Keep privileged self-hosted runners disconnected from the public repository. Prepare each environment independently and promote the same signed image digest for staging and production. [GitHub runner security guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)

For a new host, follow [provisioning](PROVISIONING.md). For an application update, set `host` in the private bootstrap settings to the configured SSH hostname and omit `initialRootPublicKey`. Keep the console-pinned host key and private identity in the workstation settings. The bootstrap tool uses `cloudflared` for the connection. Schedule host or migration changes with an operator session and keep the prior release artifacts. Prepare the exact signed revision and image digest on the VM, then use the fingerprint printed by prepare.

```sh
cd /opt/founder-village
manifest=config/staging.private.json
revision=$(sudo jq -er .revision .state/source-manifest.json)
image=$(sudo jq -er .image .state/source-manifest.json)
prepared=$(sudo bin/fv --config "$manifest" release prepare --revision "$revision" --image "$image")
sudo bin/fv --config "$manifest" release deploy --id "$prepared"
sudo bin/fv --config "$manifest" doctor
```

Promotion binds the installed source and image, checks the registry signer, verifies the recent backup receipt and its immutable-copy completion, and checks the selected image's Linux architecture and source revision. It applies additive migrations and verifies the inactive API color before switching Caddy. The proxy must serve the expected revision and both API and admin readiness routes before the new workers are accepted. The admin image has its own pin.

On a host installed from a signed bundle, `sudo bin/fv --config "$manifest" release promote --revision "$revision"` prepares and deploys the installed v2 bundle under one lock. Use the exact revision from the release workflow you intend to promote. See [Founder Village production](PRODUCTION.md) for the runtime domains, Pages release and public verification.

Once the tunnel is enabled, run the public check from an independent operator device using the production API origin and the signed revision. The scheduled uptime workflow uses the repository's public `FV_PUBLIC_API_URL` variable.

```sh
PUBLIC_API_URL=https://api.example.com PUBLIC_API_REVISION="$revision" node scripts/probe.ts
```

Browser-originated production operations require fresh MFA with a nonce bound to the operation. The runner independently verifies authorization and consumes it once. Expired, failed, or uncertain operations require reconciliation and a fresh authorization.

A failed candidate keeps the current proxy route. If a cutover or worker check fails, the deployer restores the prior settings and route. Schema migrations must remain compatible with both colors. Manual rollback uses the previous verified API image and restarts its workers. Keep the receipt and reconcile the running release after an interrupted promotion.

```sh
sudo bin/fv --config "$manifest" release rollback
sudo bin/fv --config "$manifest" doctor
```

The first launch has no previous color to roll back to. Stop public routing with `sudo systemctl stop fv-ingress.service` if a serving fault requires containment. Use the Hetzner console for stopping or restarting ingress because the same connector carries operator SSH. The runtime service restores promoted services from pinned image references on reboot. The ingress service is enabled separately and checks private readiness before starting Cloudflare Tunnel.

`npm run release:verify` runs the expanded local checks with source fingerprints. Hosted publication, cloud provisioning, public ingress, authenticated behavior, offsite-copy verification, and clean-host recovery each require their own evidence.
