variable "name" {
  type        = string
  description = "Dedicated connector/connection name; must not reuse the MCO resource name."
  validation {
    condition     = can(regex("^gmail-example-provider-mfa-[a-z0-9-]+$", var.name))
    error_message = "Use a dedicated gmail-example-provider-mfa- name."
  }
}

variable "resource_group_id" {
  type = string
}

variable "location" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
