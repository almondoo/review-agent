data "google_project" "current" {
  project_id = var.project_id
}

locals {
  use_vertex   = var.llm_provider == "vertex"
  use_google   = var.llm_provider == "google"
  use_external = var.llm_provider == "anthropic"

  manage_app_key       = var.github_app_private_key_secret_id == null
  manage_webhook       = var.github_webhook_secret_secret_id == null
  manage_anthropic_key = local.use_external && var.anthropic_api_key_secret_id == null

  app_key_secret_id   = local.manage_app_key ? "${var.name}-github-app-private-key" : var.github_app_private_key_secret_id
  webhook_secret_id   = local.manage_webhook ? "${var.name}-github-webhook-secret" : var.github_webhook_secret_secret_id
  anthropic_secret_id = local.use_external ? (local.manage_anthropic_key ? "${var.name}-anthropic-api-key" : var.anthropic_api_key_secret_id) : null

  worker_env = merge(
    {
      NODE_ENV                           = var.environment
      REVIEW_AGENT_NAME                  = var.name
      QUEUE_TOPIC                        = "${var.name}-jobs"
      QUEUE_SUBSCRIPTION                 = "${var.name}-jobs-sub"
      GITHUB_APP_ID                      = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_SECRET      = local.app_key_secret_id
      GITHUB_WEBHOOK_SECRET_NAME         = local.webhook_secret_id
      DATABASE_URL_SECRET_NAME           = google_secret_manager_secret.db.secret_id
      LLM_PROVIDER                       = var.llm_provider
      LANGFUSE_LOG_BODIES                = var.langfuse_log_bodies
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = var.otel_traces_endpoint
      OTEL_EXPORTER_OTLP_HEADERS         = var.otel_headers
    },
    local.use_vertex ? {
      CLAUDE_CODE_USE_VERTEX      = "1"
      ANTHROPIC_VERTEX_PROJECT_ID = var.project_id
      CLOUD_ML_REGION             = var.region
      VERTEX_MODEL_ID             = var.vertex_model
    } : {},
    local.use_google ? {
      GOOGLE_MODEL_ID = var.google_model
    } : {},
    local.use_external ? {
      ANTHROPIC_API_KEY_SECRET_NAME = local.anthropic_secret_id
    } : {},
  )
}

# -----------------------------------------------------------------------------
# APIs
# -----------------------------------------------------------------------------

resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "aiplatform.googleapis.com",
    "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# -----------------------------------------------------------------------------
# Service Accounts
# -----------------------------------------------------------------------------

resource "google_service_account" "receiver" {
  account_id   = "${var.name}-receiver"
  display_name = "review-agent webhook receiver"
}

resource "google_service_account" "worker" {
  account_id   = "${var.name}-worker"
  display_name = "review-agent worker"
}

resource "google_service_account" "pubsub_invoker" {
  account_id   = "${var.name}-pubsub-invoker"
  display_name = "review-agent Pub/Sub push subscription invoker"
}

# -----------------------------------------------------------------------------
# Pub/Sub: main topic + DLQ topic + push subscription
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "jobs" {
  name                       = "${var.name}-jobs"
  message_retention_duration = "604800s" # 7 days
}

resource "google_pubsub_topic" "dlq" {
  name                       = "${var.name}-jobs-dlq"
  message_retention_duration = "1209600s" # 14 days
}

resource "google_pubsub_subscription" "jobs" {
  name  = "${var.name}-jobs-sub"
  topic = google_pubsub_topic.jobs.name

  ack_deadline_seconds       = var.ack_deadline_seconds
  message_retention_duration = "345600s" # 4 days

  push_config {
    push_endpoint = google_cloud_run_v2_service.worker.uri

    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
      audience              = google_cloud_run_v2_service.worker.uri
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  depends_on = [google_project_service.required]
}

# -----------------------------------------------------------------------------
# Cloud SQL (Postgres 16)
# -----------------------------------------------------------------------------

resource "google_sql_database_instance" "this" {
  name             = "${var.name}-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = var.environment == "prod" ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    disk_size         = 20

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.environment == "prod"
      backup_retention_settings {
        retained_backups = var.environment == "prod" ? 14 : 1
      }
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = "projects/${var.project_id}/global/networks/default"
    }
  }

  deletion_protection = var.environment == "prod"
}

resource "google_sql_database" "this" {
  name     = "review_agent"
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "this" {
  name     = "review_agent"
  instance = google_sql_database_instance.this.name
  password = var.db_password
}

# -----------------------------------------------------------------------------
# Secret Manager: webhook + App key + DB URL + optional Anthropic key
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret" "webhook" {
  count     = local.manage_webhook ? 1 : 0
  secret_id = local.webhook_secret_id
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "app_key" {
  count     = local.manage_app_key ? 1 : 0
  secret_id = local.app_key_secret_id
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "anthropic_key" {
  count     = local.manage_anthropic_key ? 1 : 0
  secret_id = local.anthropic_secret_id
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "db" {
  secret_id = "${var.name}-database-url"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db" {
  secret      = google_secret_manager_secret.db.id
  secret_data = "postgres://${google_sql_user.this.name}:${var.db_password}@/${google_sql_database.this.name}?host=/cloudsql/${google_sql_database_instance.this.connection_name}"
}

# IAM: each secret gets read access for the matching SA only.
resource "google_secret_manager_secret_iam_member" "webhook_to_receiver" {
  secret_id = local.manage_webhook ? google_secret_manager_secret.webhook[0].secret_id : local.webhook_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.receiver.email}"
}

resource "google_secret_manager_secret_iam_member" "app_key_to_worker" {
  secret_id = local.manage_app_key ? google_secret_manager_secret.app_key[0].secret_id : local.app_key_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "db_to_worker" {
  secret_id = google_secret_manager_secret.db.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "anthropic_to_worker" {
  count     = local.use_external ? 1 : 0
  secret_id = local.manage_anthropic_key ? google_secret_manager_secret.anthropic_key[0].secret_id : local.anthropic_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

# -----------------------------------------------------------------------------
# Cloud SQL access for the worker
# -----------------------------------------------------------------------------

resource "google_project_iam_member" "worker_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# Vertex AI access — only when llm_provider='vertex'.
resource "google_project_iam_member" "worker_vertex" {
  count   = local.use_vertex ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# Pub/Sub publish for the receiver.
resource "google_pubsub_topic_iam_member" "receiver_publish" {
  topic  = google_pubsub_topic.jobs.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.receiver.email}"
}

# Pub/Sub invoker SA can call the worker Cloud Run service.
resource "google_cloud_run_v2_service_iam_member" "worker_pubsub_invoker" {
  name     = google_cloud_run_v2_service.worker.name
  location = google_cloud_run_v2_service.worker.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_invoker.email}"
}

# Public webhook ingress: receiver is invokable by anyone (signature
# is verified inside).
resource "google_cloud_run_v2_service_iam_member" "receiver_public" {
  name     = google_cloud_run_v2_service.receiver.name
  location = google_cloud_run_v2_service.receiver.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# -----------------------------------------------------------------------------
# Cloud Run services: receiver + worker
# -----------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "receiver" {
  name     = "${var.name}-receiver"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account                  = google_service_account.receiver.email
    max_instance_request_concurrency = 80
    scaling {
      max_instance_count = var.receiver_max_instances
    }

    containers {
      image   = var.image_uri
      command = ["node"]
      args    = ["/app/packages/server/dist/serverless.js"]

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "worker" {
  name     = "${var.name}-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account                  = google_service_account.worker.email
    max_instance_request_concurrency = 1
    timeout                          = "${var.ack_deadline_seconds}s"

    scaling {
      max_instance_count = var.worker_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.this.connection_name]
      }
    }

    containers {
      image   = var.image_uri
      command = ["node"]
      args    = ["/app/packages/server/dist/serverless.js"]

      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
        cpu_idle = false # always-warm CPU during request lifetime
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      dynamic "env" {
        for_each = local.worker_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [google_project_service.required, google_sql_database.this]
}
