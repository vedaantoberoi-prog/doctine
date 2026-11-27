output "public_ip" {
  value       = oci_core_instance.doctine.public_ip
  description = "SSH: ssh ubuntu@<this address>, from the one address allowed in ssh_source_cidr."
}
output "shape" {
  value = "${oci_core_instance.doctine.shape} ${var.ocpus} OCPU / ${var.memory_gb} GB, boot ${var.boot_volume_gb} GB"
}
output "image" {
  value = data.oci_core_images.ubuntu_arm.images[0].display_name
}
