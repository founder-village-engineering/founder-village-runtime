# Administrator security exercises

The local admin panel requires a credential issued by the trusted host CLI:

```sh
bin/fv admin-login --open
```

The 256-bit credential expires after five minutes and is atomically consumed once. Only its SHA-256 hash is stored. Issuing another link invalidates unused earlier links for that administrator. The link carries the credential in its fragment; the frontend removes it before requesting protected content. Sessions expire after one hour and use host-only Secure, HttpOnly, SameSite=Strict cookies over HTTPS. A separate CSRF token is bound to the durable session. Current enabled state, action grants and application grants are checked on each protected request.

`FV_LOCAL_AUTH_FIXTURES=1` enables synthetic login only in an explicitly isolated local test process. Normal `npm start` and `bin/dev` use a fixed environment allowlist and never propagate this flag. They also exclude provider write tokens, runner database credentials, backup credentials and Docker environment variables from the admin service. Anyone controlling the operator's account or private catalog remains inside the host trust boundary.

CLI code issuance uses the existing admin session-issuer database role. The background worker role cannot insert login codes; additive migration `006_control.sql` removes that authority. The local exercise verifies the denial without inserting a row.

## Private Hasura inspection

The Hasura page embeds `/hasura/console/data/manage/source/<source>` inside `admin.fv`. The exact registered source names remain `founder-village`, `founder-farm`, `founder-cafe` and `founder-residences`. Access requires a configured root actor, `admins.manage`, and current grants for all applications. A delegated administrator cannot obtain cluster-wide access by changing the selected application, spoofing Hasura headers or calling a console asset directly.

The proxy constructs its own upstream headers. It discards browser authorization, cookies, role and secret headers and adds the private Hasura credential on the server. The browser bridge supplies CSRF headers and a public transport marker required by the vendor console; that marker grants no access. Each API or asset request authenticates again. HTML, assets, responses and errors use `Cache-Control: no-store` and `Pragma: no-cache`.

Metadata changes, GraphQL mutations/subscriptions and unknown sources are denied. PostgreSQL's version-matched parser validates SQL syntax trees before forwarding: only SELECT and EXPLAIN of reads are accepted; transaction control, writes inside CTEs/EXPLAIN, SELECT INTO, row locks, configuration changes and selected blocking/session functions are rejected. Forwarded SQL also sets `read_only: true` regardless of the caller's flags. Least-privilege database roles remain an independent boundary. Request, query, nesting, response and timeout budgets bound the inspected surface.

The console loads its packaged assets from the private engine. Its own CSP permits nonce-bearing scripts and WebAssembly compilation, without JavaScript string evaluation. Vendor styles require inline styles within this document. External scripts, fonts, telemetry and connections remain blocked. The parent admin page retains its stricter CSP and cannot be embedded; only the Hasura document allows same-origin framing. Hasura's browser assets share the admin origin and are part of its trusted dependency surface. Upstream internal error diagnostics are suppressed.

Hasura has no standalone `.fv` route. Reserved Hasura names and nested names receive NXDOMAIN; port 43803 remains loopback-only for trusted backend tooling. Do not add public Hasura ingress.

## Repeat the local red/blue exercise

Start the local runtime and its trusted HTTPS edge, then run:

```sh
npm run security:admin
npm run test:browser:https
```

The exercise refuses remote environments, other admin origins and synthetic-login servers. It uses the real local control database and private Hasura. It creates temporary credentials and one uniquely named delegated administrator, cleans up its own records, and retains the append-only audit history. It never changes the owner's grants, enqueues privileged work, removes volumes or writes application rows. Its negative SQL probes use false predicates as a second safeguard. A single-use owner link is issued through the same CLI implementation used normally.

Results are written without credentials or query results to `.state/evidence/admin-red-blue.json`. A passing receipt requires successful cleanup and all assertions. The HTTP client explicitly trusts this runtime's public local CA; TLS verification stays enabled. The HTTPS browser command uses the running canonical admin service and real CLI credentials across desktop Chromium, mobile Chromium and mobile WebKit. The ordinary browser command starts an isolated fixture-login service on the direct loopback origin.

| Red-team attempt | Blue-team boundary |
| --- | --- |
| Anonymous console, spoofed root/Hasura headers, credential-free sign-in | 401; durable authenticated session required |
| Background worker attempts to mint a login code | PostgreSQL permission denial |
| Expired/replayed code and simultaneous redemption | Expired/replayed requests return 401; exactly one concurrent redemption succeeds |
| Missing/wrong CSRF token, sibling origin, cross-site fetch | 403 before forwarding |
| Metadata write or write hidden inside bulk reads | 403 before forwarding |
| Unknown source, encoded path traversal | 400 before forwarding |
| GraphQL mutation, hidden named mutation, subscription | 403 before forwarding |
| SQL write, transaction escape, writable CTE/EXPLAIN, configuration/lock/sleep abuse | 403 before forwarding |
| Delegated administrator with all application grants | 403; root identity is independently required |
| Expired or revoked session loading a console asset | 401 on the next request |
| Standalone Hasura or nested DNS name | NXDOMAIN through the OS resolver |
| Valid SQL, GraphQL and metadata inspection | Allowed, with all four source names preserved |

An early SQL probe failed because PostgreSQL denied table modification after transaction control had escaped read-only mode. Treating any 4xx as proof of read-only enforcement would have missed this. The strengthened exercise now requires proxy-level 403 for those attempts, and regression tests verify that no upstream request is made. Other focused tests cover grant reduction, upstream redirects, credential stripping and assurance downgrade.

## Remote authentication and evidence limits

Remote access requires a verified Cloudflare Access assertion and OIDC authorization code flow with PKCE, state and nonce. Admin ID tokens must contain `amr: ["mfa", ...]`, the exact configured `OIDC_MFA_ACR`, recent `auth_time`, and the correct authorized party when multiple audiences are present. Requesting `acr_values` alone is insufficient: the returned signed claims are enforced, as described in [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html). Independently executed privileged operations also require a fresh, one-use approval bound to the exact action and parameters.

Configure the identity provider to require phishing-resistant passkeys or hardware security keys and map its exact assurance level into the private `OIDC_MFA_ACR` setting. `urn:mfa` is a configuration placeholder, not proof of a particular provider policy. [OWASP's MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html) describes authenticator choices and recovery considerations. Test enrollment, recovery, factor removal, stale/downgraded authentication, Access enforcement, step-up and revocation against the actual staging provider before promotion. Synthetic claim tests do not establish any of those live policies.

Local exercises do not establish deployed ingress, container-image admission, provider behavior, offsite retention or clean-host recovery. No security certification or independent penetration test is claimed.

## Dependency follow-up

The production dependency audit currently reports zero vulnerabilities. The full audit reports five high-severity development dependency entries tracing to picomatch's [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), through Vite's glob tooling. The advisory currently lists no patched version. Do not accept untrusted glob patterns or expose the development server. Keep the built admin service as the canonical endpoint, track the upstream fix, and re-run both production and full audits when upgrading. An automatic major Vite downgrade is not a verified remediation.
