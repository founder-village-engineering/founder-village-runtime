# Move Members and Food Deliveries into Founder Village

The former `founder-village-members` and `founders` databases supply the data for `founder-village-app`. Team uses its own `founder-village-team` namespace. A fresh installation uses `bin/fv up` to provision and migrate the new namespace. Follow these steps for a cluster that already has the legacy databases.

## Prepare the existing cluster

1. Verify the environment, signed source, and exact PostgreSQL container. Check the recovery point and preserve the last known compatible release and metadata. Review aggregate counts, old schema versions, old access grants, and pending payment work. [Recovery](RECOVERY.md)
2. Freeze writes to both legacy databases. Include both API colors, Hasura access, workers, scheduled jobs, and payment reconciliation. Coordinate Stripe webhook retries across the cutover. Settle published jobs and resolve enabled schedules before copying. Pending outbox rows can be copied and published after switching to the new queue. Preserve the Stripe metadata identifier in existing sessions and check any outstanding browser redirects to a retired hostname.
3. Render the target using its verified environment manifest. On an existing database service, run the generated `/run/fv/init.sql` against its PostgreSQL maintenance database. Apply `packages/database/migrate.ts` with that environment's generated file. This creates the destination schema using its own credentials. The destination starts with one migration-created tenant. On local upgrade, run these steps before `bin/fv up` inserts synthetic fixtures.

## Copy and verify the data

Run the rehearsal from the runtime checkout with the verified PostgreSQL container name in `postgres`. The transaction reads both legacy databases using the existing operator connection on the same server. It checks the source table inventory, keeps constraints active, and rolls back destination writes by default.

```sh
docker exec -i "$postgres" psql -X -U postgres -d founder-village-app -q \
  < database/maintenance/consolidate-founder-village-app.sql
```

Review the per-table counts. The import keeps the community tenant and every delivery tenant ID. Tenant IDs duplicated in the Members source receive separate deterministic UUIDs, with their memberships and dependent rows moved together. The import preserves checkout IDs, delivery-to-expense links, idempotency keys, and outbox history. The insert aborts if any destination constraint fails or the destination contains previous imports or other data. Resolve unexpected source tables, schema history, tenant collisions, or job states before continuing.

With writers still frozen, repeat against the same destination with `-v apply=on`. Compare persisted counts and relationships with the rehearsal. If the commit outcome is uncertain, inspect the destination before resuming. The copy leaves both source databases available for the recovery window.

If legacy storage objects exist, reconcile their exact keys from the old application prefixes to the new namespace and any remapped tenant IDs. Review administrator grants independently. Grant the new namespace only to identities approved for its combined scope. Reconcile old control operations and monitor entries with the retired namespaces.

## Promote and retire

- Release the compatible runtime and the two surviving frontend builds through the signed release and Pages procedures. Verify new Hasura source consistency, authorization for both product apps, authenticated Members and delivery persistence, Team access, and denial of the retired app IDs and origins. Reconcile both release colors, the admin pin, workers, and host service state. [Signed releases](DEPLOYMENT.md)
- Preserve the legacy data through the rollback window and control traffic to prevent writes from diverging. Once the new database accepts writes, returning to the old databases requires a reviewed data reconciliation or restore. Verify a backup of the new state before any authorized legacy database, role, queue, provider, or cache cleanup. [App retirement skill](../../.agents/skills/delete-founder-village-app/SKILL.md)
