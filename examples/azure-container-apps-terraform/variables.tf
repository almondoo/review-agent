variable "subscription_id" {
  description = "Azure subscription ID."
  type        = string
}

variable "name" {
  description = "Base name applied to every resource. Lowercase, alphanumeric + dashes, ≤ 24 chars (Storage / Service Bus naming limit)."
  type        = string
  default     = "review-agent"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,23}$", var.name))
    error_message = "name must be lowercase alphanumeric / dashes, start with a letter, and be ≤ 24 chars."
  }
}

variable "location" {
  description = "Azure region. Azure OpenAI availability varies — eastus / westeurope / japaneast in 2026."
  type        = string
  default     = "eastus"
}

variable "environment" {
  type    = string
  default = "prod"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}

# ---------- LLM provider ----------------------------------------------------

variable "llm_provider" {
  description = "azure-openai (recommended for Azure deployments) | anthropic (external Anthropic API key)"
  type        = string
  default     = "azure-openai"

  validation {
    condition     = contains(["azure-openai", "anthropic"], var.llm_provider)
    error_message = "llm_provider must be either 'azure-openai' or 'anthropic'."
  }
}

variable "azure_openai_endpoint" {
  description = "Azure OpenAI resource endpoint. Required when llm_provider='azure-openai'. Example: https://my-aoai.openai.azure.com"
  type        = string
  default     = ""
}

variable "azure_openai_deployment" {
  description = "Azure OpenAI deployment name (operator-defined). Required when llm_provider='azure-openai'."
  type        = string
  default     = ""
}

variable "azure_openai_model" {
  description = "Underlying OpenAI model id behind the deployment (used for pricing lookup)."
  type        = string
  default     = "gpt-4o"
}

variable "github_app_id" {
  type = string
}

variable "github_app_private_key_secret_name" {
  description = "Existing Key Vault secret name for the GitHub App PEM. Set null to let this module create the secret."
  type        = string
  default     = null
}

variable "github_webhook_secret_secret_name" {
  description = "Existing Key Vault secret name for the webhook HMAC. Set null to let this module create the secret."
  type        = string
  default     = null
}

variable "anthropic_api_key_secret_name" {
  description = "Existing Key Vault secret name for an external Anthropic API key (only when llm_provider='anthropic'). Set null to let this module create the secret."
  type        = string
  default     = null
}

# ---------- Container image -------------------------------------------------

variable "image_uri" {
  description = "Azure Container Registry image URI (or any registry the Container Apps environment can pull from)."
  type        = string
}

# ---------- Postgres Flexible Server ---------------------------------------

variable "db_sku_name" {
  description = "Postgres Flexible Server SKU. B_Standard_B1ms is the cheapest dev tier; GP_Standard_D2s_v3 for prod."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "db_storage_mb" {
  type    = number
  default = 32768
}

variable "db_password" {
  description = "Password for the application Postgres user. Stored in Key Vault."
  type        = string
  sensitive   = true
}

# ---------- Container Apps runtime sizing ---------------------------------

variable "worker_cpu" {
  type    = number
  default = 1.0
}

variable "worker_memory" {
  type    = string
  default = "2.0Gi"
}

variable "worker_max_replicas" {
  type    = number
  default = 20
}

variable "receiver_max_replicas" {
  type    = number
  default = 10
}

# ---------- Service Bus -----------------------------------------------------

variable "service_bus_sku" {
  type    = string
  default = "Standard"
  validation {
    condition     = contains(["Standard", "Premium"], var.service_bus_sku)
    error_message = "service_bus_sku must be either 'Standard' or 'Premium'."
  }
}

variable "max_delivery_count" {
  type    = number
  default = 5
}

variable "lock_duration" {
  description = "Service Bus message lock duration. ISO 8601 duration. Default 5 minutes."
  type        = string
  default     = "PT5M"
}

# ---------- Observability --------------------------------------------------

variable "otel_traces_endpoint" {
  type    = string
  default = ""
}

variable "otel_headers" {
  type      = string
  default   = ""
  sensitive = true
}

variable "langfuse_log_bodies" {
  type    = string
  default = "0"
}
