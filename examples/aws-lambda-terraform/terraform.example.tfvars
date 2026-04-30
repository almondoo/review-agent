# Copy to terraform.tfvars and fill in. terraform.tfvars is gitignored.

# --- required ---------------------------------------------------------------

github_app_id = "1234567"
image_uri     = "123456789012.dkr.ecr.us-east-1.amazonaws.com/review-agent:0.2.0"
db_password   = "REPLACE_ME_WITH_OUTPUT_OF_openssl_rand_-base64_32"

# --- common overrides -------------------------------------------------------

# name        = "review-agent"
# region      = "us-east-1"
# environment = "prod"

# --- LLM provider -----------------------------------------------------------

# llm_provider     = "bedrock"   # or "anthropic"
# bedrock_model_id = "anthropic.claude-sonnet-4-6-v1:0"

# When llm_provider = "anthropic" and you have an existing Secrets
# Manager secret, point at it here. Otherwise leave null and this
# module will create the secret (you populate the value out-of-band).
# anthropic_api_key_secret_name = "my-org/review-agent/anthropic-key"

# --- VPC --------------------------------------------------------------------

# vpc_id             = "vpc-0abc123"
# private_subnet_ids = ["subnet-0aaa", "subnet-0bbb"]

# --- Sizing -----------------------------------------------------------------

# db_instance_class      = "db.t4g.micro"
# worker_memory_mb       = 2048
# worker_timeout_seconds = 600

# --- Observability ----------------------------------------------------------

# otel_traces_endpoint = "https://cloud.langfuse.com/api/public/otel/v1/traces"
# otel_headers         = "Authorization=Basic <base64(public:secret)>"
# langfuse_log_bodies  = "0"  # "1" only for trusted dev/staging environments
