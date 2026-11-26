export const cloudflareGrantNames = [
  "CF_READ_TOKEN",
  "CF_WRITE_TOKEN",
  "FV_PAGES_API_TOKEN",
  "CLOUDFLARE_PROVISION_TOKEN",
] as const;

export const hostRequired = [
  "CF_READ_TOKEN",
  "CF_WRITE_TOKEN",
  "OIDC_MFA_ACR",
] as const;

export const s3StorageBindings = [
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_REGION",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_KEY",
  "BACKUP_S3_SECRET",
  "IMMUTABLE_ENDPOINT",
  "IMMUTABLE_REGION",
  "IMMUTABLE_BUCKET",
  "IMMUTABLE_ACCESS_KEY",
  "IMMUTABLE_SECRET_KEY",
  "AUDIT_ENDPOINT",
  "AUDIT_REGION",
  "AUDIT_BUCKET",
  "AUDIT_ACCESS_KEY",
  "AUDIT_SECRET_KEY",
] as const;

export const hostOptional = [
  "VAULTWARDEN_ADMIN_TOKEN_HASH",
  "OBJECT_ENDPOINT",
  "OBJECT_REGION",
  "OBJECT_BUCKET",
  "OBJECT_ACCESS_KEY",
  "OBJECT_SECRET_KEY",
  "ALERT_WEBHOOK_URL",
  "TEAM_XAI_MODEL",
  "TEAM_XAI_API_KEY",
] as const;

export const operatorRequired = [
  "FV_HCLOUD_TOKEN",
  "FV_PAGES_API_TOKEN",
  "CLOUDFLARE_PROVISION_TOKEN",
  "OIDC_ISSUER",
  "OIDC_AUDIENCE",
  "OIDC_CLIENT_ID",
  "FV_APP_OIDC_CLIENT_ID",
  "ACCESS_ADMIN_EMAILS",
] as const;

export const runtimePolicy = [
  "ROOT_ADMIN_ACTORS",
  "ACCESS_SSH_EMAILS",
] as const;

export const distributedBindings = [
  ...operatorRequired,
  ...hostRequired,
  ...s3StorageBindings,
  ...hostOptional,
  ...runtimePolicy,
  "FV_CF_TOKEN_ISSUER",
  "FV_CLOUDFLARE_ACCOUNT_ID",
  "FV_HETZNER_CANDIDATE",
  "FV_SSH_HOST_PUBLIC_KEY",
  "FV_BOOTSTRAP_IPV4",
  "AGE_RECIPIENT",
  "TEAM_CONTENT_KEY",
  "AUDIT_HMAC_KEY",
] as const;
