# Incident response

1. Identify the affected environment/application, operator, UTC time, observed impact, and serving release. Preserve receipts, audit checkpoints, volumes, and relevant redacted diagnostics. Do not copy payloads or credentials into general logs or tickets.
2. Contain the affected identity/service at its narrowest effective boundary: revoke sessions/memberships/Access grants or close declared ingress; preserve management access and independent alerting. A provider or identity outage must not force reliance on the browser console for recovery.
3. Treat an API/container compromise separately from host/provider compromise. Rotate all reachable credentials when the host boundary is lost, including backup ingestion credentials; independently verify immutable/offline recovery copies before trusting the compromised host's claims.
4. Reconcile queued/running operations. Expired leases and uncertain external outcomes are failures requiring review. Never reset one-time authorization ledgers to force an operation through. Check actual DNS, running artifacts, backup objects, and job effects before issuing a new request.
5. Recover with the tested release or recovery procedures. Keep restored side effects disabled until external delivery/payment/job state and revocations are reconciled.
6. Record root cause, containment, recovery evidence, remaining risk, owners, and follow-up dates. Any required legal/privacy notifications follow the organization's separately approved process; the platform never automatically emails all users.

Monitor disk/inodes, database size/connections, WAL archiving, backup age, pending/dead jobs, failed operations, certificate expiry, and external uptime. Do not delete database volumes, serving/rollback images, or unverified backups during capacity incidents. Alert transport itself must be tested with a synthetic receiver before real operational use.
