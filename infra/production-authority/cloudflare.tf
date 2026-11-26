variable "permission_groups" {
  type = list(object({ name = string, id = string, scopes = set(string) }))
}
locals {
  targets = {
    runtimeZone = { "com.cloudflare.api.account.zone.${var.zone_ids["foundervillage.org"]}" = "*" }
    bothZones   = { for id in values(var.zone_ids) : "com.cloudflare.api.account.zone.${id}" => "*" }
    account     = { "com.cloudflare.api.account.${var.account_id}" = "*" }
  }
  policy = jsondecode(file("${path.module}/grants.json"))
}
resource "cloudflare_account_token" "runtime" {
  for_each   = local.policy
  account_id = var.account_id
  name       = "founder-village-production-${lower(replace(each.key, "_", "-"))}"
  policies = [for policy in each.value : {
    effect    = "allow"
    resources = jsonencode(local.targets[policy.target])
    permission_groups = [for name in policy.groups : {
      id = one([for group in var.permission_groups : group.id
      if group.name == name && contains(group.scopes, policy.target == "account" ? "com.cloudflare.api.account" : "com.cloudflare.api.account.zone")])
    }]
  }]
  lifecycle {
    prevent_destroy = true
    precondition {
      condition = alltrue(flatten([for policy in each.value : [
        for name in policy.groups : length([for group in var.permission_groups : group.id
        if group.name == name && contains(group.scopes, policy.target == "account" ? "com.cloudflare.api.account" : "com.cloudflare.api.account.zone")]) == 1
      ]]))
      error_message = "The issuer must be able to delegate each required permission on its exact account or zone scope."
    }
  }
}
