mock_provider "cloudflare" {}
variables {
  permission_groups = [
    { name = "Zone Read", id = "01", scopes = ["com.cloudflare.api.account.zone"] },
    { name = "DNS Read", id = "02", scopes = ["com.cloudflare.api.account.zone"] },
    { name = "DNS Write", id = "03", scopes = ["com.cloudflare.api.account.zone"] },
    { name = "Pages Write", id = "04", scopes = ["com.cloudflare.api.account"] },
    { name = "Cloudflare Tunnel Write", id = "05", scopes = ["com.cloudflare.api.account"] },
    { name = "Access: Apps and Policies Write", id = "06", scopes = ["com.cloudflare.api.account"] },
    { name = "Access: Service Tokens Write", id = "07", scopes = ["com.cloudflare.api.account"] },
    { name = "Access: Organizations Read", id = "08", scopes = ["com.cloudflare.api.account"] },
  ]
  account_id   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  zone_ids     = { "foundervillage.org" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "founderhaus.org" = "cccccccccccccccccccccccccccccccc" }
}
run "scoped_cloudflare_grants" {
  command = plan
  assert {
    condition = (
      length(cloudflare_account_token.runtime) == 4 &&
      length(keys(jsondecode(cloudflare_account_token.runtime["CF_WRITE_TOKEN"].policies[0].resources))) == 1 &&
      length(keys(jsondecode(cloudflare_account_token.runtime["FV_PAGES_API_TOKEN"].policies[0].resources))) == 2 &&
      alltrue([for p in flatten([for t in cloudflare_account_token.runtime : t.policies]) : alltrue([for g in p.permission_groups : g.id != null])])
    )
    error_message = "Role or zone scope mismatch."
  }
}
