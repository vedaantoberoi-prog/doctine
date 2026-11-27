# Doctine · Oracle A1 stack, inputs. Resource Manager fills tenancy_ocid, compartment_ocid and region itself.
# Nothing secret goes here: the SSH value is a PUBLIC key, and no AI, database or evaluation token is ever a variable
# (Terraform state would keep it). The evaluation token is typed on the VM afterwards (infra/oracle-a1/README.md).

variable "tenancy_ocid" { type = string }
variable "compartment_ocid" { type = string }
variable "region" { type = string }

variable "ssh_public_key" {
  type        = string
  description = "The contents of your SSH PUBLIC key (.pub file). Never the private key."
  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+", var.ssh_public_key)) && !can(regex("PRIVATE KEY", var.ssh_public_key))
    error_message = "Paste a public key line (ssh-ed25519 AAAA...). A private key is refused."
  }
}

variable "ssh_source_cidr" {
  type        = string
  description = "The only address allowed to reach SSH, as a /32 (your own public IP), e.g. 203.0.113.7/32."
  validation {
    condition     = can(cidrhost(var.ssh_source_cidr, 0)) && endswith(var.ssh_source_cidr, "/32")
    error_message = "Use a single address ending in /32. 0.0.0.0/0 (the whole internet) is refused."
  }
}

# Always Free A1 is 1,500 OCPU-hours and 9,000 GB-hours a month for the whole tenancy, i.e. 2 OCPU
# and 12 GB running all month (Oracle "Always Free Resources", page updated 12 Jun 2026). The checks below refuse more.
variable "ocpus" {
  type    = number
  default = 2
  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 2
    error_message = "Always Free A1 allows at most 2 OCPU in total for the tenancy."
  }
}
variable "memory_gb" {
  type    = number
  default = 12
  validation {
    condition     = var.memory_gb >= 6 && var.memory_gb <= 12
    error_message = "Always Free A1 allows at most 12 GB in total for the tenancy."
  }
}
variable "boot_volume_gb" {
  type        = number
  default     = 50
  description = "Counts toward the 200 GB Always Free block storage (boot + block volumes) in the home region."
  validation {
    condition     = var.boot_volume_gb >= 50 && var.boot_volume_gb <= 100
    error_message = "Use 50-100 GB so the boot volume stays well inside the 200 GB Always Free total."
  }
}

variable "budget_alert_email" {
  type        = string
  default     = ""
  description = "If set, a budget of 1 (in the account's currency) emails this address as soon as ANY charge appears."
}
