terraform {
  backend "local" {}
  required_version = ">= 1.11, < 2"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "= 5.29.0" }
  }
}

variable "account_id" { type = string }
variable "zone_ids" { type = map(string) }

output "bindings" {
  sensitive = true
  value     = { for name, token in cloudflare_account_token.runtime : name => token.value }
}
