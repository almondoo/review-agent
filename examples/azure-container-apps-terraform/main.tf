data "azurerm_client_config" "current" {}

locals {
  use_azure_openai = var.llm_provider == "azure-openai"
  use_external     = var.llm_provider == "anthropic"

  manage_app_key       = var.github_app_private_key_secret_name == null
  manage_webhook       = var.github_webhook_secret_secret_name == null
  manage_anthropic_key = local.use_external && var.anthropic_api_key_secret_name == null

  app_key_secret_name   = local.manage_app_key ? "${var.name}-github-app-private-key" : var.github_app_private_key_secret_name
  webhook_secret_name   = local.manage_webhook ? "${var.name}-github-webhook-secret" : var.github_webhook_secret_secret_name
  anthropic_secret_name = local.use_external ? (local.manage_anthropic_key ? "${var.name}-anthropic-api-key" : var.anthropic_api_key_secret_name) : null

  default_tags = merge(
    {
      "review-agent.app" = var.name
      "review-agent.env" = var.environment
      "managed-by"       = "terraform"
    },
    var.tags,
  )

  worker_env = merge(
    {
      NODE_ENV                           = var.environment
      REVIEW_AGENT_NAME                  = var.name
      QUEUE_NAMESPACE                    = "${azurerm_servicebus_namespace.this.name}.servicebus.windows.net"
      QUEUE_NAME                         = azurerm_servicebus_queue.jobs.name
      GITHUB_APP_ID                      = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_SECRET      = local.app_key_secret_name
      GITHUB_WEBHOOK_SECRET_NAME         = local.webhook_secret_name
      DATABASE_URL_SECRET_NAME           = "${var.name}-database-url"
      LLM_PROVIDER                       = var.llm_provider
      LANGFUSE_LOG_BODIES                = var.langfuse_log_bodies
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = var.otel_traces_endpoint
      OTEL_EXPORTER_OTLP_HEADERS         = var.otel_headers
      KEY_VAULT_URI                      = azurerm_key_vault.this.vault_uri
    },
    local.use_azure_openai ? {
      AZURE_OPENAI_ENDPOINT   = var.azure_openai_endpoint
      AZURE_OPENAI_DEPLOYMENT = var.azure_openai_deployment
      AZURE_OPENAI_MODEL      = var.azure_openai_model
    } : {},
    local.use_external ? {
      ANTHROPIC_API_KEY_SECRET_NAME = local.anthropic_secret_name
    } : {},
  )
}

# -----------------------------------------------------------------------------
# Resource group
# -----------------------------------------------------------------------------

resource "azurerm_resource_group" "this" {
  name     = "${var.name}-rg"
  location = var.location
  tags     = local.default_tags
}

# -----------------------------------------------------------------------------
# User-assigned Managed Identity (shared by both Container Apps)
# -----------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "app" {
  name                = "${var.name}-identity"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.default_tags
}

# -----------------------------------------------------------------------------
# Service Bus namespace + main queue + DLQ is auto-managed by Service Bus
# -----------------------------------------------------------------------------

resource "azurerm_servicebus_namespace" "this" {
  name                = "${var.name}-sb-${random_id.sb_suffix.hex}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = var.service_bus_sku
  tags                = local.default_tags
}

resource "random_id" "sb_suffix" {
  byte_length = 3
}

resource "azurerm_servicebus_queue" "jobs" {
  name                                 = "${var.name}-jobs"
  namespace_id                         = azurerm_servicebus_namespace.this.id
  max_delivery_count                   = var.max_delivery_count
  lock_duration                        = var.lock_duration
  default_message_ttl                  = "P14D"
  dead_lettering_on_message_expiration = true
}

# IAM: receiver = sender, worker = receiver + KEDA scaler reads.
resource "azurerm_role_assignment" "receiver_sender" {
  scope                = azurerm_servicebus_namespace.this.id
  role_definition_name = "Azure Service Bus Data Sender"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "worker_receiver" {
  scope                = azurerm_servicebus_namespace.this.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# -----------------------------------------------------------------------------
# Postgres Flexible Server
# -----------------------------------------------------------------------------

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "${var.name}-pg-${random_id.sb_suffix.hex}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  version                       = "16"
  sku_name                      = var.db_sku_name
  storage_mb                    = var.db_storage_mb
  administrator_login           = "review_agent"
  administrator_password        = var.db_password
  zone                          = "1"
  public_network_access_enabled = false
  backup_retention_days         = var.environment == "prod" ? 14 : 7
  geo_redundant_backup_enabled  = var.environment == "prod"
  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = true
    tenant_id                     = data.azurerm_client_config.current.tenant_id
  }
  tags = local.default_tags
}

resource "azurerm_postgresql_flexible_server_database" "this" {
  name      = "review_agent"
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# -----------------------------------------------------------------------------
# Key Vault: webhook + App PEM + DB URL + optional Anthropic key
# -----------------------------------------------------------------------------

resource "azurerm_key_vault" "this" {
  name                          = "${var.name}-kv-${random_id.sb_suffix.hex}"
  resource_group_name           = azurerm_resource_group.this.name
  location                      = azurerm_resource_group.this.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.environment == "prod"
  soft_delete_retention_days    = 30
  public_network_access_enabled = false
  tags                          = local.default_tags
}

# Grant the deploying principal write access (so Terraform can seed
# the DB URL secret); the worker / receiver identities get read-only.
resource "azurerm_role_assignment" "kv_admin_self" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

resource "azurerm_role_assignment" "kv_user_app" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_key_vault_secret" "webhook" {
  count        = local.manage_webhook ? 1 : 0
  name         = local.webhook_secret_name
  key_vault_id = azurerm_key_vault.this.id
  value        = "REPLACE_AFTER_APPLY"
  tags         = local.default_tags

  depends_on = [azurerm_role_assignment.kv_admin_self]

  lifecycle {
    ignore_changes = [value]
  }
}

resource "azurerm_key_vault_secret" "app_key" {
  count        = local.manage_app_key ? 1 : 0
  name         = local.app_key_secret_name
  key_vault_id = azurerm_key_vault.this.id
  value        = "REPLACE_AFTER_APPLY"
  tags         = local.default_tags

  depends_on = [azurerm_role_assignment.kv_admin_self]

  lifecycle {
    ignore_changes = [value]
  }
}

resource "azurerm_key_vault_secret" "anthropic" {
  count        = local.manage_anthropic_key ? 1 : 0
  name         = local.anthropic_secret_name
  key_vault_id = azurerm_key_vault.this.id
  value        = "REPLACE_AFTER_APPLY"
  tags         = local.default_tags

  depends_on = [azurerm_role_assignment.kv_admin_self]

  lifecycle {
    ignore_changes = [value]
  }
}

resource "azurerm_key_vault_secret" "db" {
  name         = "${var.name}-database-url"
  key_vault_id = azurerm_key_vault.this.id
  value        = "postgres://${azurerm_postgresql_flexible_server.this.administrator_login}:${var.db_password}@${azurerm_postgresql_flexible_server.this.fqdn}:5432/${azurerm_postgresql_flexible_server_database.this.name}?sslmode=require"
  tags         = local.default_tags

  depends_on = [azurerm_role_assignment.kv_admin_self]
}

# -----------------------------------------------------------------------------
# Container Apps environment + the two Container Apps
# -----------------------------------------------------------------------------

resource "azurerm_log_analytics_workspace" "this" {
  name                = "${var.name}-logs"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.default_tags
}

resource "azurerm_container_app_environment" "this" {
  name                       = "${var.name}-env"
  resource_group_name        = azurerm_resource_group.this.name
  location                   = azurerm_resource_group.this.location
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.default_tags
}

resource "azurerm_container_app" "receiver" {
  name                         = "${var.name}-receiver"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.default_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"
    traffic_weight {
      percentage      = 100
      latest_revision = true
    }
  }

  template {
    min_replicas = 1
    max_replicas = var.receiver_max_replicas

    container {
      name    = "receiver"
      image   = var.image_uri
      cpu     = 0.5
      memory  = "1.0Gi"
      command = ["node", "/app/packages/server/dist/serverless.js"]

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

resource "azurerm_container_app" "worker" {
  name                         = "${var.name}-worker"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = azurerm_resource_group.this.name
  revision_mode                = "Single"
  tags                         = local.default_tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  template {
    min_replicas = 0
    max_replicas = var.worker_max_replicas

    container {
      name    = "worker"
      image   = var.image_uri
      cpu     = var.worker_cpu
      memory  = var.worker_memory
      command = ["node", "/app/packages/server/dist/serverless.js"]

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }

    custom_scale_rule {
      name             = "service-bus-queue"
      custom_rule_type = "azure-servicebus"
      metadata = {
        queueName    = azurerm_servicebus_queue.jobs.name
        namespace    = azurerm_servicebus_namespace.this.name
        messageCount = "1"
      }
      authentication {
        secret_name       = "service-bus-auth"
        trigger_parameter = "connection"
      }
    }
  }
}
