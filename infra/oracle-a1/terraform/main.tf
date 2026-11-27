# Doctine · Oracle A1 stack (Resource Manager). Status: written and statically tested; NOT yet planned or applied.
#
# What it creates, all Always Free in the home region (nothing else):
#   1 VCN, 1 internet gateway, 1 route table, 1 security list (SSH from ONE address; nothing else inbound), 1 subnet
#   1 VM.Standard.A1.Flex instance (≤ 2 OCPU, ≤ 12 GB, 50 GB boot volume), first boot = ../cloud-init.yaml
#   optionally 1 budget + 1 alert rule (Budgets have no charge) that email the owner if any cost appears
# What it never creates: load balancers, databases, buckets, vaults, public ports other than 22, anything paid.
#
# Use: Resource Manager → Stacks → Create stack → upload dist/doctine-oracle-stack.zip → run **Plan** (creates
# nothing) → review the plan with Claude → only then, with the owner's approval, **Apply**. Remove: **Destroy**.

terraform {
  required_version = ">= 1.2.0"
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

provider "oci" {
  region = var.region
}

locals {
  name = "doctine-a1"
  tags = { "doctine-purpose" = "evaluation-and-benchmarks-no-patient-data" }
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Newest Canonical Ubuntu 24.04 image built for the A1 (aarch64) shape.
data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "doctine" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.20.0.0/16"]
  display_name   = "${local.name}-vcn"
  dns_label      = "doctinea1"
  freeform_tags  = local.tags
}

resource "oci_core_internet_gateway" "doctine" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.doctine.id
  display_name   = "${local.name}-igw"
  enabled        = true
  freeform_tags  = local.tags
}

resource "oci_core_route_table" "doctine" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.doctine.id
  display_name   = "${local.name}-routes"
  route_rules {
    network_entity_id = oci_core_internet_gateway.doctine.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
  freeform_tags = local.tags
}

# Inbound: SSH from one address only. Outbound: HTTPS to staging, package mirrors, GitHub.
resource "oci_core_security_list" "doctine" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.doctine.id
  display_name   = "${local.name}-ssh-only"
  ingress_security_rules {
    protocol    = "6"
    source      = var.ssh_source_cidr
    source_type = "CIDR_BLOCK"
    stateless   = false
    tcp_options {
      min = 22
      max = 22
    }
  }
  egress_security_rules {
    protocol         = "all"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    stateless        = false
  }
  freeform_tags = local.tags
}

resource "oci_core_subnet" "doctine" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.doctine.id
  cidr_block                 = "10.20.1.0/24"
  display_name               = "${local.name}-subnet"
  dns_label                  = "main"
  route_table_id             = oci_core_route_table.doctine.id
  security_list_ids          = [oci_core_security_list.doctine.id]
  prohibit_public_ip_on_vnic = false
  freeform_tags              = local.tags
}

resource "oci_core_instance" "doctine" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = local.name
  shape               = "VM.Standard.A1.Flex"
  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }
  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu_arm.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.doctine.id
    assign_public_ip = true
    display_name     = "${local.name}-vnic"
  }
  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(file("${path.module}/cloud-init.yaml"))
  }
  preserve_boot_volume = false
  freeform_tags        = local.tags
}

# Cost guard: Budgets are free. Amount 1, alert at 1% of it on ACTUAL spend, so the first charge of any kind emails you.
resource "oci_budget_budget" "guard" {
  count          = var.budget_alert_email == "" ? 0 : 1
  compartment_id = var.tenancy_ocid
  amount         = 1
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
  display_name   = "doctine-any-charge"
  description    = "Doctine expects to stay inside Always Free; any actual charge triggers an email."
}

resource "oci_budget_alert_rule" "guard" {
  count          = var.budget_alert_email == "" ? 0 : 1
  budget_id      = oci_budget_budget.guard[0].id
  type           = "ACTUAL"
  threshold      = 1
  threshold_type = "PERCENTAGE"
  recipients     = var.budget_alert_email
  display_name   = "doctine-first-charge"
  message        = "Oracle shows a charge on the Doctine tenancy. Check Billing → Cost analysis; nothing Doctine runs should cost money."
}
