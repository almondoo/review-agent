# Copy to terraform.tfvars and fill in. terraform.tfvars is gitignored.

project_id    = "my-gcp-project"
region        = "us-central1"
github_app_id = "1234567"
image_uri     = "us-central1-docker.pkg.dev/<project>/review-agent/review-agent:0.3.0"
db_password   = "REPLACE_WITH_openssl_rand_-base64_32"

# llm_provider = "vertex"   # or "google" or "anthropic"
# vertex_model = "claude-sonnet-4-6@anthropic"
# db_tier      = "db-f1-micro"
# environment  = "prod"
