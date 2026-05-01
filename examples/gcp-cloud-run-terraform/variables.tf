variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "name" {
  description = "Base name applied to every resource. Lowercase, alphanumeric + dashes."
  type        = string
  default     = "review-agent"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,30}$", var.name))
    error_message = "name must be lowercase alphanumeric / dashes, start with a letter, and be ≤ 31 chars."
  }
}

variable "region" {
  description = "GCP region for Cloud Run + Pub/Sub + Cloud SQL. Vertex Anthropic is available in us-central1, us-east5, europe-west4 in 2026."
  type        = string
  default     = "us-central1"
}

variable "environment" {
  type    = string
  default = "prod"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "labels" {
  type    = map(string)
  default = {}
}

# ---------- LLM provider ----------------------------------------------------

variable "llm_provider" {
  description = "vertex (Anthropic Claude on Vertex AI — recommended for GCP) | google (Gemini direct) | anthropic (external Anthropic API key)"
  type        = string
  default     = "vertex"

  validation {
    condition     = contains(["vertex", "google", "anthropic"], var.llm_provider)
    error_message = "llm_provider must be one of: vertex, google, anthropic."
  }
}

variable "vertex_model" {
  description = "Vertex AI model ID. Used only when llm_provider='vertex'. Anthropic IDs on Vertex use the @anthropic suffix."
  type        = string
  default     = "claude-sonnet-4-6@anthropic"
}

variable "google_model" {
  description = "Google AI Studio model ID. Used only when llm_provider='google'."
  type        = string
  default     = "gemini-2.0-pro"
}

variable "anthropic_api_key_secret_id" {
  description = "Existing Secret Manager secret ID holding an external Anthropic API key (only when llm_provider='anthropic'). Set null to let this module create the secret; populate the value out-of-band."
  type        = string
  default     = null
}

variable "github_app_id" {
  type = string
}

variable "github_app_private_key_secret_id" {
  description = "Existing Secret Manager secret ID for the GitHub App PEM. Set null to let this module manage it."
  type        = string
  default     = null
}

variable "github_webhook_secret_secret_id" {
  description = "Existing Secret Manager secret ID for the webhook HMAC. Set null to let this module manage it."
  type        = string
  default     = null
}

# ---------- Container image -------------------------------------------------

variable "image_uri" {
  description = "Artifact Registry image URI. Both services run the same image; the entrypoint is selected by command override."
  type        = string
}

# ---------- Cloud SQL Postgres ---------------------------------------------

variable "db_tier" {
  description = "Cloud SQL machine tier. db-perf-optimized-N-2 is the smallest Enterprise Plus tier; db-f1-micro is the cheapest dev tier."
  type        = string
  default     = "db-f1-micro"
}

variable "db_password" {
  description = "Password for the application Postgres user. Generate with `openssl rand -base64 32`. Stored in Secret Manager."
  type        = string
  sensitive   = true
}

# ---------- Cloud Run runtime sizing ---------------------------------------

variable "worker_cpu" {
  type    = string
  default = "2"
}

variable "worker_memory" {
  type    = string
  default = "2Gi"
}

variable "worker_max_instances" {
  type    = number
  default = 10
}

variable "receiver_max_instances" {
  type    = number
  default = 5
}

# ---------- Pub/Sub --------------------------------------------------------

variable "ack_deadline_seconds" {
  description = "Pub/Sub subscription ack deadline. Cloud Run worker must finish in this window or extend via ModifyAckDeadline."
  type        = number
  default     = 600
}

variable "max_delivery_attempts" {
  type    = number
  default = 5
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
