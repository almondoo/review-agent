output "webhook_url" {
  description = "Public webhook URL — paste this into the GitHub App's Webhook URL field."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/webhook"
}

output "healthz_url" {
  description = "Liveness probe URL. Should return HTTP 200 with `ok` body."
  value       = "${aws_apigatewayv2_api.this.api_endpoint}/healthz"
}

output "queue_arn" {
  description = "Main job queue ARN. Useful for CloudWatch alarms on ApproximateAgeOfOldestMessage."
  value       = aws_sqs_queue.jobs.arn
}

output "dlq_arn" {
  description = "DLQ ARN. Alert on messages > 0 here — every entry is a 5-times-failed job that needs human attention."
  value       = aws_sqs_queue.dlq.arn
}

output "db_endpoint" {
  description = "Postgres endpoint (host:port). Private — only reachable from the Lambda SG."
  value       = aws_db_instance.this.endpoint
  sensitive   = true
}

output "db_secret_arn" {
  description = "Secrets Manager ARN holding the DB connection JSON. Workers fetch this at boot."
  value       = aws_secretsmanager_secret.db.arn
}

output "receiver_function_name" {
  description = "Receiver Lambda function name. Use with `aws lambda update-function-code` for hot deploys."
  value       = aws_lambda_function.receiver.function_name
}

output "worker_function_name" {
  description = "Worker Lambda function name."
  value       = aws_lambda_function.worker.function_name
}

output "vpc_id" {
  description = "VPC ID hosting the Lambdas + RDS instance. Echoes the input when one was supplied."
  value       = local.effective_vpc_id
}
