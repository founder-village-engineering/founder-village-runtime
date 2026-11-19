# Public API versioning

> **Public-repository safety:** This repository is public. Be 100% careful never to commit,
> paste, log, or otherwise expose secrets, API keys, access tokens, passwords, private keys,
> credentials, unredacted environment values, production data, or other non-public information.
> Use placeholders and approved secret stores, inspect staged changes before every commit, and
> immediately rotate anything that may have been exposed.

The TypeScript API supports explicit URL-major contracts without requiring every client to use a versioned URL. Existing root routes such as `/records` remain available and implement the contract named by `unversionedPublicApiContract`. The same contract is available explicitly below `/v1`, such as `/v1/records`.

The unversioned surface is a compatibility commitment, not a moving `latest` alias. Adding `/v2` must not silently repoint or change the behavior of existing root or `/v1` routes. A deliberate migration of the root contract requires its own compatibility review and client evidence.

## Contract rules

- Keep backward-compatible additions in the existing major version. Examples include a new optional response field, a new endpoint, or a new optional request field with an unchanged default.
- Introduce a new URL major before making a breaking change. Removing or renaming a field, tightening accepted input, changing authorization or idempotency semantics, changing a status code, or changing the meaning of an existing value is breaking.
- Keep validation, response shaping, and OpenAPI generation owned by each major contract. Shared database/domain functions may be reused, but a new major should adapt at the HTTP boundary instead of changing an old handler in place.
- Database migrations remain additive and checksummed. API version retirement never implies destructive schema cleanup.
- Application selection and version selection are separate. Every version must perform the same server-side application and tenant membership checks.

## Published discovery

`GET /api/versions` lists the supported contracts, lifecycle state, base path, and OpenAPI location. `GET /openapi.json` documents the unversioned compatibility surface. `GET /v1/openapi.json` documents the explicit v1 surface. Both compatibility and versioned API responses include the contract they implement, such as `API-Version: v1`.

When a version is deprecated, record its UTC deprecation date, optional sunset date, and successor in `packages/contracts/api-versioning.ts`. The runtime then emits standards-based [`Deprecation`](https://www.rfc-editor.org/rfc/rfc9745.html), [`Sunset`](https://www.rfc-editor.org/rfc/rfc8594.html), and `Link: rel="successor-version"` headers. Do not declare a sunset until usage has been measured, consumers have a tested replacement, and the removal has been approved.

## Adding a major version

1. Add the version and lifecycle metadata to `packages/contracts/api-versioning.ts`.
2. Add version-specific schemas and response types without changing the old contract.
3. Add a separate route registrar in `services/api/app.ts`. Reuse domain functions only where their behavior is compatible.
4. Generate that version's OpenAPI document and register it beneath its own base path.
5. Extend the compatibility tests to exercise both the old and new URLs, including authentication, application selection, tenant membership, error shapes, idempotency, and CORS.
6. Update clients deliberately. Keep the prior registrar and contract in the release until its documented lifecycle is complete.
