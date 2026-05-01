# Copy to terraform.tfvars and fill in. terraform.tfvars is gitignored.

subscription_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
location        = "eastus"
github_app_id   = "1234567"
image_uri       = "<acr-name>.azurecr.io/review-agent:0.3.0"
db_password     = "REPLACE_WITH_openssl_rand_-base64_32"

# llm_provider             = "azure-openai"
# azure_openai_endpoint    = "https://my-aoai.openai.azure.com"
# azure_openai_deployment  = "prod-large"
# azure_openai_model       = "gpt-4o"
# db_sku_name              = "B_Standard_B1ms"
# environment              = "prod"
