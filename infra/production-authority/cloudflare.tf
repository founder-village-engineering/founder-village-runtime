variable "permission_groups" {
  type = list(object({ name = string, id = string, scopes = set(string) }))
}
locals {
  runtime_zone = { "com.cloudflare.api.account.zone.${var.zone_ids["foundervillage.org"]}" = "*" }
  pages_zones  = { for z in values(var.zone_ids) : "com.cloudflare.api.account.zone.${z}" => "*" }
  account      = { "com.cloudflare.api.account.${var.account_id}" = "*" }
  # Permission names are the API names returned by the account-scoped catalog.
  policy = {
    CF_READ_TOKEN = [
      { scope = "zone", resources = local.runtime_zone, groups = ["Zone Read", "DNS Read"] }
    ]
    CF_WRITE_TOKEN = [
      { scope = "zone", resources = local.runtime_zone, groups = ["Zone Read", "DNS Write"] }
    ]
    FV_PAGES_API_TOKEN = [
      { scope = "zone", resources = local.pages_zones, groups = ["Zone Read", "DNS Write"] },
      { scope = "account", resources = local.account, groups = ["Pages Write"] }
    ]
    CLOUDFLARE_PROVISION_TOKEN = [
      { scope = "account", resources = local.account, groups = ["Cloudflare Tunnel Write", "Access: Apps and Policies Write", "Access: Service Tokens Write", "Access: Organizations Read"] }
    ]
  }
}
resource "cloudflare_account_token" "runtime" {
  for_each   = local.policy
  account_id = var.account_id
  name       = "founder-village-production-${lower(replace(each.key, "_", "-"))}"
  policies = [for policy in each.value : {
    effect    = "allow"
    resources = jsonencode(policy.resources)
    permission_groups = [for name in policy.groups : {
      id = one([for group in var.permission_groups : group.id
      if group.name == name && contains(group.scopes, policy.scope == "zone" ? "com.cloudflare.api.account.zone" : "com.cloudflare.api.account")])
    }]
  }]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = alltrue(flatten([for policy in each.value : [
        for name in policy.groups : length([for group in var.permission_groups : group.id
        if group.name == name && contains(group.scopes, policy.scope == "zone" ? "com.cloudflare.api.account.zone" : "com.cloudflare.api.account")]) == 1
      ]]))
      error_message = "The issuer must be able to delegate each required permission on its exact account or zone scope."
    }
  }
}
