variable "name" {
  description = "Base name applied to every resource (must match `^[a-z][a-z0-9-]{0,30}$`)."
  type        = string
  default     = "review-agent"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,30}$", var.name))
    error_message = "name must be lowercase alphanumeric / dashes, start with a letter, and be ≤ 31 chars."
  }
}

variable "region" {
  description = "AWS region for all resources. Bedrock-Anthropic availability varies by region; us-east-1 / us-west-2 / eu-central-1 are the safest choices in 2026."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment label (dev / staging / prod). Tagged onto every resource and used as a CloudWatch dimension."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "tags" {
  description = "Additional tags merged into the provider default tag set."
  type        = map(string)
  default     = {}
}

# ---------- LLM provider ----------------------------------------------------

variable "llm_provider" {
  description = "Which LLM provider the worker should call. `bedrock` is the AWS-native default — no Anthropic API key needed; the worker IAM role gets bedrock:InvokeModel. `anthropic` uses an Anthropic API key from Secrets Manager."
  type        = string
  default     = "bedrock"

  validation {
    condition     = contains(["bedrock", "anthropic"], var.llm_provider)
    error_message = "llm_provider must be either 'bedrock' or 'anthropic'."
  }
}

variable "bedrock_model_id" {
  description = "Bedrock foundation-model ID for the worker. Only used when llm_provider='bedrock'. Update when AWS publishes new Anthropic model IDs."
  type        = string
  default     = "anthropic.claude-sonnet-4-6-v1:0"
}

variable "anthropic_api_key_secret_name" {
  description = "Name (not ARN) of an existing Secrets Manager secret holding the Anthropic API key. Only used when llm_provider='anthropic'. Set to null to let this module create + manage the secret (you must populate the value out-of-band)."
  type        = string
  default     = null
}

variable "github_app_id" {
  description = "Numeric GitHub App ID (Settings → Developer settings → GitHub Apps → your app). Stored in plain Lambda env."
  type        = string
}

variable "github_app_private_key_secret_name" {
  description = "Name of an existing Secrets Manager secret holding the GitHub App PEM private key. Set to null to let this module create + manage the secret (populate value out-of-band)."
  type        = string
  default     = null
}

variable "github_webhook_secret_secret_name" {
  description = "Name of an existing Secrets Manager secret holding the GitHub webhook HMAC secret. Set to null to let this module create + manage the secret."
  type        = string
  default     = null
}

# ---------- Container image -------------------------------------------------

variable "image_uri" {
  description = "ECR image URI for the worker / receiver Lambda containers (e.g. `123456789012.dkr.ecr.us-east-1.amazonaws.com/review-agent:vX.Y.Z`). Both functions run the same image; the entrypoint is selected by command override."
  type        = string
}

# ---------- RDS Postgres ----------------------------------------------------

variable "db_instance_class" {
  description = "RDS Postgres instance class. db.t4g.micro is fine for solo / tiny org usage; bump to db.t4g.medium or larger for >50 PRs/day."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  description = "Allocated GP3 storage for the RDS instance (GB)."
  type        = number
  default     = 20
}

variable "db_password" {
  description = "Password for the application Postgres user. Stored in Secrets Manager. Generate with `openssl rand -base64 32`. Never commit this; pass via TF_VAR_db_password or `-var-file` outside source control."
  type        = string
  sensitive   = true
}

variable "vpc_id" {
  description = "VPC to place RDS + Lambdas in. Leave null to provision a minimal default VPC + private subnets via this module."
  type        = string
  default     = null
}

variable "private_subnet_ids" {
  description = "Private subnets for RDS + Lambda. Required when vpc_id is set; ignored otherwise."
  type        = list(string)
  default     = []
}

# ---------- SQS / Lambda runtime ------------------------------------------

variable "worker_memory_mb" {
  description = "Worker Lambda memory in MB. 1024 is the minimum for reasonable Node.js cold-start latency at 2026 prices."
  type        = number
  default     = 2048
}

variable "worker_timeout_seconds" {
  description = "Worker Lambda timeout (seconds). Lambda max is 900s. PRs that exceed are returned as a 'too large' graceful summary (spec §15.1 note)."
  type        = number
  default     = 600
}

variable "receiver_memory_mb" {
  description = "Receiver Lambda memory (MB). Webhook intake is light; 512 is plenty."
  type        = number
  default     = 512
}

variable "receiver_timeout_seconds" {
  description = "Receiver Lambda timeout (seconds). The handler does signature verify + idempotency check + SQS enqueue, so the upper bound is tens of seconds."
  type        = number
  default     = 30
}

variable "queue_visibility_timeout_seconds" {
  description = "SQS visibility timeout. Must be ≥ worker_timeout_seconds + buffer; AWS recommends 6× the consumer's processing time."
  type        = number
  default     = 900
}

variable "queue_max_receive_count" {
  description = "Max delivery attempts before a message is moved to the DLQ."
  type        = number
  default     = 5
}

# ---------- Logging ---------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log group retention. 30 days satisfies most compliance baselines; raise for SOC 2 type II or HIPAA."
  type        = number
  default     = 30
}

# ---------- Observability ---------------------------------------------------

variable "otel_traces_endpoint" {
  description = "OTLP HTTP traces endpoint (e.g. `https://cloud.langfuse.com/api/public/otel/v1/traces`). Leave empty to skip telemetry; the worker still emits metrics to CloudWatch."
  type        = string
  default     = ""
}

variable "otel_headers" {
  description = "OTLP exporter headers, in `key1=val1,key2=val2` form. For Langfuse Cloud: `Authorization=Basic <base64(public:secret)>`."
  type        = string
  default     = ""
  sensitive   = true
}

variable "langfuse_log_bodies" {
  description = "When set to '1' the worker keeps prompt / completion / tool body attributes on exported spans. Default is '0' (redacted) — only enable in trusted environments where leaking source code into your trace backend is acceptable (spec §13.1)."
  type        = string
  default     = "0"
}
