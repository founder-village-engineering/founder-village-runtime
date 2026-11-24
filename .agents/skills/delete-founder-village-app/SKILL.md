---
name: delete-founder-village-app
description: Retire a Founder Village frontend, feature, or runtime application across its codebases and deployed resources. Use when removing a registered app and its owned data, Cloudflare Pages hosting, integrations, or caches.
---

# Delete Founder Village App

Retire the named application from the requested environments. Establish ownership from the frontend manifest, runtime registries, and provider inventory before removing a resource. For an individual user's data, use the application's account deletion flow.

## 1. Resolve the target

Read the applicable `AGENTS.md` files in `founder-village-runtime`, sibling `founder-village-frontends`, and any other Founder Village checkout that builds, serves, or consumes the target. Follow [public repository security](../public-repo-security/SKILL.md). Keep environment values, data, and sensitive inventory in approved private stores.

Distinguish a frontend retirement, a feature retirement inside a shared application, and removal of a dedicated runtime namespace. Resolve the exact frontend slug and application ID independently, even when they have the same spelling. From the runtime checkout, choose the matching inventory command:

```sh
node --import tsx .agents/skills/delete-founder-village-app/scripts/inspect-app.ts --frontend <slug>
node --import tsx .agents/skills/delete-founder-village-app/scripts/inspect-app.ts --application <application-id>
```

The command reads the two runtime registries. It lists the namespace's direct and composed frontend consumers and, for a frontend target, its feature applications and the other frontends that use it as a feature. Use the pre-removal inventory to reconcile the frontend manifest, canonical and generated contracts, code references, and each selected environment's actual resources. If retirement is already underway, recover missing identifiers from the pre-removal revision, signed release inventory, or verified provider records.

An aggregate frontend can use several applications without owning any of their databases. A standalone frontend can supply API access and contracts to the primary app. Check incoming and outgoing `featureFrontends` mappings, other consumers including native clients and jobs, and the registry requirements for the primary app. Keep the required platform namespaces from `AGENTS.md` and protect data shared with surviving features.

## 2. Set scope and quiesce

- Record the requested environments and exact resources, their dependencies, and their disposition. Resolve local, staging, production and preview resources independently. Identify what should be removed, retained under policy, or handed to a surviving owner.
- Proceed with read-only inventory and scoped source changes. Before an irreversible operation, establish that the user's authorization covers the exact target, environment, and data or provider resources. Ask only about scope or destructive steps that remain unresolved. Skill invocation alone supplies no authorization for mutations.
- Stop admitting new work for the target. Coordinate Pages publish jobs, active clients, API entry points, schedules, queue publishers, webhooks, and external jobs. Drain or explicitly dispose of in-flight work before removing consumers or credentials. Verify that all writers are then quiescent, including older API colors, installed clients, and provider retries.
- Before data deletion, verify the required recovery point and its restore boundary under the environment's retention policy. Decide which release is safe to roll back to before and after the purge. Use the [recovery runbook](../../../docs/runbooks/RECOVERY.md) and [runtime data procedure](references/runtime-data.md).

## 3. Remove the code and deploy the retirement

Follow the [code and verification procedure](references/code-and-verification.md) for both repositories. Remove the retired entry points and any origins exclusive to them, update surviving clients and the runtime-owned contracts, and reconcile deployment inputs that could recreate the app. Test the source changes and surviving app flows locally.

For authorized live work, stage compatible releases so a serving API, worker, or Hasura source can finish using the old schema before data removal. The runtime applies migrations and Hasura metadata before switching the API color. Verify route, writer, and metadata retirement across the deployed components and verify a safe rollback path before removing data required by earlier releases. Follow the [signed release runbook](../../../docs/runbooks/DEPLOYMENT.md).

## 4. Finish the authorized cleanup

- Use the [runtime data procedure](references/runtime-data.md) for PostgreSQL, Hasura, database roles, control state, RabbitMQ, objects, and recovery copies. Determine data ownership before choosing scoped row deletion or removal of a dedicated database.
- Use the [hosting and cache procedure](references/hosting-and-cache.md) for Pages projects and previews, custom DNS, identity callbacks, integrations, and app-scoped caches or artifacts. Stop a source from repopulating a cache before evicting it.
- After a partial failure, re-inventory the exact resource in the authorized environment before retrying. An authenticated absence check can close a step already completed. An access error, name mismatch, or unexpected dependent resource requires reconciliation before mutation.

## 5. Verify completion

Check both negative and positive paths. The retired routes, origins, or resources should be absent or denied as planned. Test a surviving frontend with a real authenticated session when live access is authorized. For a retired API, probe the old route and any old application selection without an `Origin` header. Use an authenticated test identity with applicable access to distinguish retirement from an authentication failure.

Report the source and local checks, exact deployed revisions and negative probes, provider inventory, and data and cache results. Include any retained records, backups, WAL, immutable copies, or device data with their disposition and any follow-up date. Call out missing verification and identify the specific blocker. Close the task once every in-scope resource is either verified removed or accounted for under the agreed disposition.
