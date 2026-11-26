# Frontend and Pages

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Every frontend is a Vite-built static site under `apps/<slug>`. It may use the shared frontend platform and generated contracts, but it must not contain a Cloudflare Worker entrypoint or Pages Functions directory.

The public `runtime-config.js` contains only public endpoints and OAuth client identifiers. It is generated for production by the shared release script. Secrets never belong in Vite variables, static assets, or Pages configuration.

Use the runtime's configured OIDC provider and `npm run frontend:production -- plan` with the app, profile, and frontend checkout. Register the exact `<origin>/auth/callback` redirect and token exchange origin for each Pages origin and alias. Configure authorization code with PKCE S256 on a public SPA client. Use an access-token audience distinct from both the admin and SPA client IDs, and keep the operator-supplied SPA client ID in `auth.frontend_client_ids` in the private runtime profile. Local synthetic tokens are restricted to local verification.

The release path is:

1. load and validate `founder-village-app.json`;
2. build the selected workspace;
3. write real public runtime/OIDC configuration for production;
4. reject symlinks, oversized files, Worker/Functions output, and missing app markers;
5. hash the exact static artifact set;
6. provision the manifest's Pages projects when requested;
7. upload the same built files to each project with `wrangler pages deploy`;
8. verify the exact Pages and custom host responses and security headers.

Keep provisioning separate from deployment so a typo cannot silently create a similarly named project. Use `npm run pages -- <operation> --app <slug>` or the manual GitHub workflow; do not add per-app shell release scripts.

For an app with approved aliases, set the same `customOrigin` or `customOrigins` on the app manifest and runtime registration. The legacy singular field accepts one HTTPS label below `foundervillage.xyz`. The array also accepts `https://founderhaus.org` and `https://foundervillage.org`. Register each callback and token origin, associate each hostname with the Pages project, and verify DNS and HTTPS on every origin. The primary app's `runtimeApiOrigin` must match the codified production profile.

For additional `pages.dev` origins, list the exact project names in `additionalPagesProjects` in both the manifest and runtime registration. Cloudflare assigns the hostname for each project. Custom domains attach to the primary project.
