# Applications, access, and WireGuard

The initial namespaces are `founder-village`, `founder-farm`, `founder-cafe`, and `founder-residences`. They are separate databases, not schema aliases for one database. Registry database and Hasura names are exact; GraphQL namespaces use underscores because GraphQL identifiers cannot contain hyphens.

```sh
npm run namespace:add -- founder-library 'Founder Library'
npm run hasura:generate
bin/fv render
bin/fv up
```

Review the registry/metadata diff before applying it remotely. Rendering generates private Compose overrides so an added namespace receives its own role URLs without editing a static service matrix. SQL migrations are checksummed per database. Shared migrations run first; application-specific migrations live under `database/applications/<id>/`. Never edit a migration already applied to an environment.

Grant/revoke membership using the trusted CLI procedure:

```sh
node --env-file=.state/local.env --import tsx scripts/membership.ts founder-village grant <tenant-uuid> '<verified-issuer>|<subject>'
```

`revoke` disables the membership. Existing tenant records stay intact and other applications' grants remain unchanged. Tenant creation and application-specific data lifecycle changes belong in explicit migrations/owned application features; the runtime does not infer them from email addresses or headers.

A named console administrator needs explicit actions and application scopes:

```sh
bin/fv admin-grant --actor '<verified-issuer>|<subject>' --actions dashboard.read --applications founder-village,founder-farm
```

Production use also needs the configured MFA/Access identity. Cluster-wide backup/deploy/network operations require grants covering the complete application inventory. Adding an application does not silently expand existing grants. Revocation is checked for every request and again before execution.

For WireGuard, prefer client-generated keys and `wireguard enroll` with the public key. An optional local profile generator writes a private file and never activates workstation routes:

```sh
node --import tsx scripts/wireguard-profile.ts laptop 10.89.0.2 vpn.example.com:51827 2027-02-01 config/local.json
bin/fv wireguard status
```

Profiles are distinct per device, mode 0600, and split-tunnel to the management host. The generator preserves an existing client key on retries. Import the profile only on the named device. On Linux, `wireguard apply` reconciles the interface without restarting other peers; the expiry timer removes expired peers from live configuration. `wireguard revoke --name laptop` persists revocation; apply it on the host and verify the removed public key and real inability to reconnect.

A recent handshake is necessary but not sufficient proof of intended routing. Verify private SSH access and the absence of unexpected default-route/DNS/IPv6 changes. Keep provider-console recovery and a narrowly scoped, expiring bootstrap SSH procedure available.
