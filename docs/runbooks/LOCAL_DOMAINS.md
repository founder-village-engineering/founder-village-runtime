# Local Founder Village domains

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

`.fv` is a workstation-local convention. The runtime does not register it publicly or request public certificates. `config/local-domains.json` is the route registry:

| URL | Loopback upstream |
| --- | --- |
| `https://api.fv` | `http://127.0.0.1:43801` |
| `https://api-dev.fv` | `http://127.0.0.1:43801` |
| `https://admin.fv` | `http://127.0.0.1:43802` |
| `https://monitor.fv` | `http://127.0.0.1:43804` |
| `https://workers.fv` | `http://127.0.0.1:43805` |

`api-dev.fv` is an alias of the current local API and shares its data and credentials. The hostname suffix does not create a separate environment. Hasura stays private on loopback port 43803. Root administrators access its console through the Hasura page inside `https://admin.fv`; both former standalone Hasura names receive `NXDOMAIN` and have no proxy routes or certificates.

Every name is exactly one label under `.fv`. Use `api-dev.fv` for a development alias. The same rule applies to public names under the configured Cloudflare zone: `api-dev.example.com`, never `api.dev.example.com`. Config validation, local route rendering and the public DNS adapter enforce this even when a nested name is explicitly allowlisted. Application selection still requires server-side membership checks.

## Setup and operation

On macOS, with Docker running:

```sh
bin/fv local-edge plan    # show the exact routes and host changes
bin/fv local-edge setup   # start edge, install scoped DNS, trust local CA
npm start -- local       # start application services and keep them in the foreground
bin/fv local-edge doctor
```

Setup shows macOS administrator authentication for installing `/etc/resolver/fv` and flushing DNS caches. It separately trusts the public Founder Village CA in the current user's login keychain through the standard Keychain trust command. It refuses to replace an unmanaged resolver or a changed CA. No Archlife secrets, certificates, volumes or configuration are copied or changed.

CoreDNS listens on `127.0.0.1:43853` over UDP and TCP. The macOS split resolver sends only `.fv` queries there; ordinary network DNS remains unchanged. Valid one-label names resolve to IPv6 loopback `::1`; nested names receive `NXDOMAIN`. A dedicated Caddy listener publishes `[::1]:443` and forwards registered names to the existing IPv4 loopback services through Docker Desktop's host gateway. Only registered routes receive certificates and HTTPS proxy handling; unregistered names fail TLS validation. This coexists with an IPv4 listener on port 443 and binds no external interface.

Caddy issues an exact-hostname certificate for each registered route through this runtime's own local authority. Exact names avoid client restrictions on wildcards directly below private top-level domains. Its private keys remain in the `fv-local_local_edge_data` volume. Only the public root is exported to `.state/local/edge/root.crt`; generated configuration lives beside it. These local keys are separate from production identities and recovery artifacts. Normal shutdown never removes volumes or rotates this authority.

Sign in with `bin/fv admin-login --open`. The local CLI issues a five-minute, single-use credential for the configured enabled root administrator. An unauthenticated browser cannot obtain it. The console accepts its canonical HTTPS origin and the explicit direct-loopback diagnostic origin. HTTPS login sets Secure, host-only, SameSite=Strict cookies; the session cookie is HttpOnly. CSRF, current administrator grants and root-only Hasura checks apply to each request, including assets. Synthetic login requires an explicit test-process flag that normal launch commands never propagate. See [administrator security exercises](ADMIN_SECURITY.md).

`local-edge up` starts the edge without changing the host resolver/trust. `local-edge doctor` verifies OS DNS and certificate validation for every registered route; it reports upstream status separately. A TLS/DNS success with HTTP 502 means the application process is stopped, not healthy. macOS current-user trust is checked separately from the explicit CA used by the Rust TLS probe.

Automatic host installation and the Docker Desktop loopback proxy integration currently support macOS. Other operating systems require their own per-zone resolver, trust-store and loopback-upstream integration; the ordinary data stack and direct HTTP integration fixtures remain separate.

## Shutdown and troubleshooting

Ctrl-C stops only the application processes owned by `npm start -- local`. Data and edge containers remain available. Stop these independently when needed:

```sh
bin/fv down               # data/application Compose services; keep volumes
bin/fv local-edge down    # local DNS/TLS containers; keep CA volumes
```

For DNS and proxy diagnostics:

```sh
dig @127.0.0.1 -p 43853 api.fv AAAA
dig @127.0.0.1 -p 43853 dev.api.fv AAAA +tcp  # must report NXDOMAIN
docker compose -p fv-local -f .state/local/edge/compose.json logs --tail 30
```

DNS records alone do not establish OS resolution, certificate trust, application readiness, authenticated browser behavior or provider deployment. Verify each layer. Never disable certificate verification to make a local check pass.
