# Frontend and Pages

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

Every frontend is a Vite-built static site under `apps/<slug>`. It may use the shared frontend platform and generated contracts, but it must not contain a Cloudflare Worker entrypoint or Pages Functions directory.

The public `runtime-config.js` contains only public endpoints and OAuth client identifiers. It is generated for production by the shared release script. Secrets never belong in Vite variables, static assets, or Pages configuration.

Use the runtime's configured OIDC provider. Register the exact `<productionOrigin>/auth/callback` redirect URI for the public SPA client, permit the exact Pages origin at the token endpoint, and issue access tokens for the backend's configured API audience. Do not infer provider settings from a local synthetic token, and do not treat an administrator ID-token client as interchangeable with the API bearer audience.

The release path is:

1. load and validate `founder-village-app.json`;
2. build the selected workspace;
3. write real public runtime/OIDC configuration for production;
4. reject symlinks, oversized files, Worker/Functions output, and missing app markers;
5. hash the exact static artifact set;
6. explicitly provision the Pages project when requested;
7. deploy with `wrangler pages deploy`;
8. verify the canonical `https://<project>.pages.dev` response and security headers.

Keep provisioning separate from deployment so a typo cannot silently create a similarly named project. Use `npm run pages -- <operation> --app <slug>` or the manual GitHub workflow; do not add per-app shell release scripts.

For an app with an approved alias, set the identical optional `customOrigin` on the app manifest and runtime registration. It must be one HTTPS label below `foundervillage.xyz`. Register its exact callback and token origin, associate it with the Pages project, and verify the authoritative DNS CNAME. The shared release verifier checks both origins when an alias is present.
