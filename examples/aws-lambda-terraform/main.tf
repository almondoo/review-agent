data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  use_bedrock = var.llm_provider == "bedrock"

  # When the operator did not name an existing secret, this module
  # creates one and they populate the value out-of-band (aws secretsmanager
  # put-secret-value ...). The Lambda functions only ever do a Get.
  manage_app_key   = var.github_app_private_key_secret_name == null
  manage_webhook   = var.github_webhook_secret_secret_name == null
  manage_anthropic = !local.use_bedrock && var.anthropic_api_key_secret_name == null

  app_key_secret_name   = local.manage_app_key ? "${var.name}/github-app-private-key" : var.github_app_private_key_secret_name
  webhook_secret_name   = local.manage_webhook ? "${var.name}/github-webhook-secret" : var.github_webhook_secret_secret_name
  anthropic_secret_name = local.use_bedrock ? null : (local.manage_anthropic ? "${var.name}/anthropic-api-key" : var.anthropic_api_key_secret_name)

  worker_env = merge(
    {
      NODE_ENV                      = var.environment
      REVIEW_AGENT_NAME             = var.name
      DATABASE_URL_SECRET_ARN       = aws_secretsmanager_secret.db.arn
      QUEUE_URL                     = aws_sqs_queue.jobs.url
      GITHUB_APP_ID                 = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_SECRET = local.app_key_secret_name
      GITHUB_WEBHOOK_SECRET_NAME    = local.webhook_secret_name
      LLM_PROVIDER                  = var.llm_provider
      LANGFUSE_LOG_BODIES           = var.langfuse_log_bodies
    },
    local.use_bedrock
    ? {
      CLAUDE_CODE_USE_BEDROCK = "1"
      AWS_REGION              = local.region
      BEDROCK_MODEL_ID        = var.bedrock_model_id
    }
    : {
      ANTHROPIC_API_KEY_SECRET_NAME = local.anthropic_secret_name
    },
    var.otel_traces_endpoint == "" ? {} : {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = var.otel_traces_endpoint
      OTEL_EXPORTER_OTLP_HEADERS         = var.otel_headers
    },
  )
}

# -----------------------------------------------------------------------------
# VPC (created only when the operator did not supply one)
# -----------------------------------------------------------------------------

resource "aws_vpc" "this" {
  count                = var.vpc_id == null ? 1 : 0
  cidr_block           = "10.30.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_subnet" "private" {
  count             = var.vpc_id == null ? 2 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet(aws_vpc.this[0].cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available[0].names[count.index]
  tags              = { Name = "${var.name}-private-${count.index}" }
}

data "aws_availability_zones" "available" {
  count = var.vpc_id == null ? 1 : 0
  state = "available"
}

locals {
  effective_vpc_id     = var.vpc_id == null ? aws_vpc.this[0].id : var.vpc_id
  effective_subnet_ids = var.vpc_id == null ? aws_subnet.private[*].id : var.private_subnet_ids
}

resource "aws_security_group" "lambda" {
  name        = "${var.name}-lambda"
  description = "Egress for review-agent Lambdas (DB, AWS APIs, OTel, GitHub)."
  vpc_id      = local.effective_vpc_id

  egress {
    description = "All egress (Lambdas reach DB / AWS / GitHub / OTel collector)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds"
  description = "Postgres ingress restricted to the worker / receiver Lambda SG."
  vpc_id      = local.effective_vpc_id

  ingress {
    description     = "Postgres from Lambdas"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }
}

# -----------------------------------------------------------------------------
# Secrets — webhook secret, GitHub App private key, optional Anthropic key
# -----------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "webhook" {
  count = local.manage_webhook ? 1 : 0
  name  = local.webhook_secret_name
}

resource "aws_secretsmanager_secret" "app_key" {
  count = local.manage_app_key ? 1 : 0
  name  = local.app_key_secret_name
}

resource "aws_secretsmanager_secret" "anthropic" {
  count = local.manage_anthropic ? 1 : 0
  name  = local.anthropic_secret_name
}

resource "aws_secretsmanager_secret" "db" {
  name = "${var.name}/database-url"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    user     = aws_db_instance.this.username
    password = var.db_password
    dbname   = aws_db_instance.this.db_name
    url      = "postgres://${aws_db_instance.this.username}:${var.db_password}@${aws_db_instance.this.endpoint}/${aws_db_instance.this.db_name}?sslmode=require"
  })
}

# -----------------------------------------------------------------------------
# RDS Postgres
# -----------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = local.effective_subnet_ids
}

resource "aws_db_instance" "this" {
  identifier                   = "${var.name}-db"
  engine                       = "postgres"
  engine_version               = "16.4"
  instance_class               = var.db_instance_class
  allocated_storage            = var.db_allocated_storage_gb
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "review_agent"
  username                     = "review_agent"
  password                     = var.db_password
  db_subnet_group_name         = aws_db_subnet_group.this.name
  vpc_security_group_ids       = [aws_security_group.rds.id]
  publicly_accessible          = false
  skip_final_snapshot          = var.environment != "prod"
  backup_retention_period      = var.environment == "prod" ? 14 : 1
  deletion_protection          = var.environment == "prod"
  apply_immediately            = var.environment != "prod"
  performance_insights_enabled = true
}

# -----------------------------------------------------------------------------
# SQS — main queue + DLQ
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = var.queue_visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })
}

# -----------------------------------------------------------------------------
# IAM — receiver + worker roles
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "receiver" {
  name               = "${var.name}-receiver"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "worker" {
  name               = "${var.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "receiver_basic" {
  role       = aws_iam_role.receiver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "worker_basic" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "receiver_vpc" {
  role       = aws_iam_role.receiver.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "worker_vpc" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Receiver: read webhook secret + send to SQS. Nothing else.
data "aws_iam_policy_document" "receiver" {
  statement {
    sid     = "ReadWebhookSecret"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.manage_webhook
      ? aws_secretsmanager_secret.webhook[0].arn
      : "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${local.webhook_secret_name}-*",
    ]
  }
  statement {
    sid       = "SendJob"
    actions   = ["sqs:SendMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "receiver" {
  role   = aws_iam_role.receiver.id
  policy = data.aws_iam_policy_document.receiver.json
}

# Worker: SQS consume + read all secrets it needs + Bedrock invoke (when applicable).
data "aws_iam_policy_document" "worker" {
  statement {
    sid     = "ReadSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = compact([
      aws_secretsmanager_secret.db.arn,
      local.manage_app_key
      ? aws_secretsmanager_secret.app_key[0].arn
      : "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${local.app_key_secret_name}-*",
      local.use_bedrock
      ? null
      : (local.manage_anthropic
        ? aws_secretsmanager_secret.anthropic[0].arn
      : "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${local.anthropic_secret_name}-*"),
    ])
  }
  statement {
    sid = "ConsumeJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.jobs.arn]
  }

  dynamic "statement" {
    for_each = local.use_bedrock ? [1] : []
    content {
      sid     = "InvokeBedrockAnthropic"
      actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
      resources = [
        "arn:aws:bedrock:${local.region}::foundation-model/anthropic.*",
      ]
    }
  }
}

resource "aws_iam_role_policy" "worker" {
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

# -----------------------------------------------------------------------------
# Lambdas — both run the same container image, different entrypoints.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "receiver" {
  name              = "/aws/lambda/${var.name}-receiver"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${var.name}-worker"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "receiver" {
  function_name = "${var.name}-receiver"
  role          = aws_iam_role.receiver.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = var.receiver_timeout_seconds
  memory_size   = var.receiver_memory_mb

  image_config {
    command = ["packages/server/dist/serverless.js"]
  }

  vpc_config {
    subnet_ids         = local.effective_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.worker_env
  }

  depends_on = [aws_cloudwatch_log_group.receiver]
}

resource "aws_lambda_function" "worker" {
  function_name = "${var.name}-worker"
  role          = aws_iam_role.worker.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  timeout       = var.worker_timeout_seconds
  memory_size   = var.worker_memory_mb

  image_config {
    command = ["packages/server/dist/lambda-worker.js"]
  }

  vpc_config {
    subnet_ids         = local.effective_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.worker_env
  }

  depends_on = [aws_cloudwatch_log_group.worker]
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn = aws_sqs_queue.jobs.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 1
  enabled          = true

  scaling_config {
    maximum_concurrency = 10
  }
}

# -----------------------------------------------------------------------------
# API Gateway HTTP API → receiver Lambda
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name}-webhook"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "receiver" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.receiver.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.receiver.id}"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /healthz"
  target    = "integrations/${aws_apigatewayv2_integration.receiver.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.receiver.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
