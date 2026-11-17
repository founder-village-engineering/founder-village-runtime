# Release and rollback

The release workflow verifies code, builds immutable artifacts, signs the application image and source/runtime artifacts, and records exact digests. GitHub production environment protections and a dedicated trusted `fv-deploy` runner must be configured in the account; checked-in workflow files alone do not enable those settings.

Deployments run from a clean matching source revision. Private environment manifests and state remain outside Git. The deployer checks the image registry and workflow signer, configuration/input fingerprints, backup freshness, migrations, Hasura metadata, inactive candidate readiness, proxy cutover, serving revision, and worker replacement. Application colors preserve independent immutable image/revision settings.

```sh
bin/fv --config config/staging.private.json release prepare --revision <40-character-source-sha> --image <approved-image-at-sha256-digest>
bin/fv --config config/staging.private.json release deploy --id <prepared-fingerprint>
```

Repeat promotion with the same signed image in production, preparing a manifest bound to production configuration. `deploy.yml` accepts only a prepared fingerprint and executes the installed trusted CLI. It never checks out or executes a pull request on a privileged host.

Browser-originated production operations additionally require fresh MFA with a nonce bound to the exact operation. Runners verify this independently and consume authorization once. Expired/failed/uncertain operations require reconciliation and a newly authorized request; resetting a database state field cannot replay the authorization.

On failed candidate checks, serving traffic stays on the existing color. Postcheck failure restores the old routing and environment. Schema migrations must remain compatible with both colors; rollbacks never automatically execute destructive SQL. Keep failed receipts and inspect actual running images/leases before retrying.

```sh
bin/fv --config config/production.private.json release rollback
```

A first launch has no earlier serving application to restore. Rollback requires an existing verified target. Explicit control-plane updates must keep CLI/SSH recovery available; ordinary application promotion preserves the separately pinned admin image.

`npm run release:verify` collects the expanded local checks with source fingerprints. It does not create provider approvals or reuse evidence from another revision. The routine deploy path does not silently launch that full collection.
