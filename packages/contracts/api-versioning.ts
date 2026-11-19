type PublicApiVersionIdentity = Readonly<{
  id: `v${number}`;
  semanticVersion: `${number}.${number}.${number}`;
  basePath: `/${string}`;
  openApiPath: `/${string}`;
}>;

export type PublicApiVersion = PublicApiVersionIdentity &
  (
    | Readonly<{
        status: "stable";
        deprecatedAt?: never;
        sunsetAt?: never;
        successor?: never;
      }>
    | Readonly<{
        status: "deprecated";
        deprecatedAt: string;
        sunsetAt?: string;
        successor?: `v${number}`;
      }>
  );

const v1: PublicApiVersion = Object.freeze({
  id: "v1",
  semanticVersion: "1.0.0",
  basePath: "/v1",
  openApiPath: "/v1/openapi.json",
  status: "stable",
});

/**
 * Public URL-major contracts that the runtime still serves. Adding a version
 * here does not register routes by itself; each version must have an explicit
 * route registrar in services/api/app.ts.
 */
export const publicApiVersions: readonly PublicApiVersion[] = Object.freeze([
  v1,
]);

/** The contract implemented by the legacy, unversioned URLs. */
export const unversionedPublicApiContract = v1;
