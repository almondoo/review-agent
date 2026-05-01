output "webhook_url" {
  description = "Public webhook URL — paste this into the GitHub App's Webhook URL field."
  value       = "https://${azurerm_container_app.receiver.latest_revision_fqdn}/webhook"
}

output "healthz_url" {
  value = "https://${azurerm_container_app.receiver.latest_revision_fqdn}/healthz"
}

output "service_bus_namespace" {
  value = azurerm_servicebus_namespace.this.name
}

output "queue_name" {
  value = azurerm_servicebus_queue.jobs.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}

output "managed_identity_client_id" {
  description = "User-assigned managed identity client ID. Use to bind external workload-identity-federated workloads."
  value       = azurerm_user_assigned_identity.app.client_id
}

output "db_fqdn" {
  description = "Postgres Flexible Server FQDN. Private — only reachable from the Container Apps environment."
  value       = azurerm_postgresql_flexible_server.this.fqdn
  sensitive   = true
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.this.workspace_id
}
