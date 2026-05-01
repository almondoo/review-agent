output "webhook_url" {
  description = "Public webhook URL — paste this into the GitHub App's Webhook URL field."
  value       = "${google_cloud_run_v2_service.receiver.uri}/webhook"
}

output "healthz_url" {
  value = "${google_cloud_run_v2_service.receiver.uri}/healthz"
}

output "worker_url" {
  description = "Internal worker Cloud Run URL. Pub/Sub push subscription targets this."
  value       = google_cloud_run_v2_service.worker.uri
}

output "topic_name" {
  value = google_pubsub_topic.jobs.name
}

output "dlq_name" {
  description = "DLQ topic. Alarm on subscription backlog > 0 here."
  value       = google_pubsub_topic.dlq.name
}

output "db_connection_name" {
  description = "Cloud SQL connection name (project:region:instance). Used by Cloud Run's `cloudsql_instance` mount."
  value       = google_sql_database_instance.this.connection_name
}

output "receiver_sa" {
  value = google_service_account.receiver.email
}

output "worker_sa" {
  value = google_service_account.worker.email
}
