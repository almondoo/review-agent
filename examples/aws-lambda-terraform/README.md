# AWS Lambda + Terraform — review-agent reference deployment

Terraform module that provisions a complete review-agent stack on AWS:
API Gateway HTTP API → receiver Lambda → SQS → worker Lambda → Anthropic
(via Bedrock by default) + RDS Postgres + Secrets Manager + CloudWatch.

For the matching narrative + walk-through, see
[`docs/deployment/aws.md`](../../docs/deployment/aws.md). This README is
the operator-facing companion to that doc.

---

## 1. At a glance

- **Services**: API Gateway HTTP API, 2× Lambda (container image), SQS
  + DLQ, RDS Postgres 16, Secrets Manager, CloudWatch Logs, IAM, ECR
  (you supply), Bedrock (default LLM provider).
- **Monthly cost (us-east-1, 2026 list prices)**:
  - **Low** (≤ 50 PRs/month, ~5 min review each): ~$25/mo
    (RDS db.t4g.micro $13 + Lambda free tier covers receiver + worker
    runtime ≈ $5 + Bedrock token cost ~$5 + secrets/logs ~$2).
  - **Typical** (200 PRs/month): ~$60/mo (Bedrock $30, RDS $13, Lambda
    $10, NAT-less VPC traffic $5, misc $2).
  - **High** (1,000 PRs/month, db.t4g.medium): ~$220/mo (Bedrock $150,
    RDS $50, Lambda $15, misc $5).
- **SLA**: depends on Bedrock quota in your account. Lambda + SQS are
  ≥ 99.9% on AWS posted SLAs. Lambda 15-min ceiling — see §1.13.
- **Scale**: small team to mid-sized org (≤ ~5 PRs/min sustained). For
  enterprise rates beyond Lambda's 1k concurrency default, switch the
  worker to Fargate (out of scope here).

## 2. Architecture diagram

```
┌─────────────┐    HTTPS     ┌──────────────────────┐
│  GitHub     │ ───────────► │ API Gateway HTTP API │
│  webhook    │              │  POST /webhook       │
└─────────────┘              └─────────┬────────────┘
                                       │ AWS_PROXY
                                       ▼
                             ┌─────────────────────┐
                             │ receiver Lambda      │
                             │  - HMAC verify §7.1  │
                             │  - idempotency check │
                             │  - SendMessage       │
                             └─────────┬────────────┘
                                       ▼
                             ┌──────────────────────┐
              alarm ◄── ApproximateAgeOfOldestMessage
                             │ SQS jobs queue       │──► DLQ (alarm on > 0)
                             └─────────┬────────────┘
                                       ▼ (event source mapping)
                             ┌──────────────────────┐
                             │ worker Lambda         │──► Bedrock InvokeModel
                             │  - clone (sparse)     │     (or external Anthropic)
                             │  - runner + middleware│
                             │  - post comments      │──► GitHub API
                             │  - upsert review_state│──► RDS Postgres
                             └──────────────────────┘
                                       │
                                       ▼
                             ┌──────────────────────┐
                             │ Secrets Manager      │  ◄── webhook secret
                             │ - github-app-key     │      app private key
                             │ - anthropic-api-key  │      (only when not Bedrock)
                             │ - database-url       │
                             └──────────────────────┘
```

## 3. Prerequisites

- Terraform ≥ 1.6, AWS CLI ≥ 2.15, Docker (for image build).
- AWS account with permission to create IAM, Lambda, RDS, API Gateway,
  Secrets Manager, SQS, ECR, VPC. The `AdministratorAccess` policy
  covers it; for production, scope down per the spec §15.6.5.
- A GitHub App created in the org / personal account that will install
  the agent (`Settings → Developer settings → GitHub Apps → New GitHub
  App`). Note the App ID and download the PEM.
- Anthropic model access in **Bedrock** (default path) — request access
  from the Bedrock console under *Model access*. Approval takes ≤ 1 day
  for Anthropic Claude in us-east-1 / us-west-2 / eu-central-1 in 2026.
- An ECR repository for the worker image. Suggested name:
  `<account>.dkr.ecr.<region>.amazonaws.com/review-agent`.

## 4. Provider selection

This module defaults to **Bedrock-Anthropic** because:

- No external API key to manage / rotate.
- IAM role on the Lambda is the entire auth story.
- Token costs land on the same AWS bill as the rest of the stack.

Switch to the external Anthropic API by setting
`llm_provider = "anthropic"`. You'll need to populate the
`anthropic-api-key` Secrets Manager value out-of-band (see §3 of
`docs/deployment/aws.md`).

## 5. Step-by-step setup

| # | Action | Time |
|---|---|---|
| 1 | Create the GitHub App + download PEM. | 10 min |
| 2 | `terraform init && terraform apply -target=...VPC + DB` (~RDS provision). | 15 min |
| 3 | Build + push the worker image to ECR. | 10 min |
| 4 | `terraform apply` again (creates Lambdas + API + secrets). | 5 min |
| 5 | Populate Secrets Manager values (webhook secret, App PEM, optional Anthropic key). | 5 min |
| 6 | Paste the `webhook_url` output into the GitHub App's webhook URL. | 1 min |
| 7 | Open a test PR; confirm the worker posts a review. | 5 min |

Detailed shell commands live in `docs/deployment/aws.md` § *Step-by-step
setup*.

## 6. Terraform quickstart

```bash
cd examples/aws-lambda-terraform
terraform init

cat > terraform.tfvars <<EOF
name               = "review-agent"
region             = "us-east-1"
environment        = "prod"

# GitHub App
github_app_id      = "1234567"

# Container
image_uri          = "123456789012.dkr.ecr.us-east-1.amazonaws.com/review-agent:0.2.0"

# DB password — generate with: openssl rand -base64 32
db_password        = "<paste-generated-secret-here>"

# Defaults that you can override:
# llm_provider     = "bedrock"      # or "anthropic"
# bedrock_model_id = "anthropic.claude-sonnet-4-6-v1:0"
# db_instance_class = "db.t4g.micro"
# log_retention_days = 30
EOF

terraform plan
terraform apply
```

Inputs are documented in `variables.tf` (each has a description). The
most-likely-tweaked subset:

| Variable | Default | When to change |
|---|---|---|
| `region` | `us-east-1` | Bedrock model region; pick the one closest to your team. |
| `llm_provider` | `bedrock` | Set to `anthropic` to use an external API key. |
| `bedrock_model_id` | `anthropic.claude-sonnet-4-6-v1:0` | When AWS publishes a newer Anthropic model ID. |
| `db_instance_class` | `db.t4g.micro` | Bump to `db.t4g.medium` once you regularly see > 50 PRs/day. |
| `worker_memory_mb` | `2048` | Lower to `1024` for cost; higher for faster cold starts. |
| `vpc_id` | `null` | Set when integrating with an existing VPC. |
| `otel_traces_endpoint` | `""` | Point at Langfuse / Honeycomb / Tempo OTLP HTTP endpoint. |

## 7. LLM provider setup (Bedrock)

1. Open **Bedrock console → Model access** in `var.region`.
2. Click *Modify model access* → check Anthropic Claude variants you
   need. Submit the use-case form.
3. Approval lands within a day. The IAM policy this module attaches
   (`bedrock:InvokeModel` on
   `arn:aws:bedrock:<region>::foundation-model/anthropic.*`) is wired up
   already; no further action needed.

For external Anthropic instead:

```bash
aws secretsmanager put-secret-value \
  --secret-id review-agent/anthropic-api-key \
  --secret-string "$ANTHROPIC_API_KEY"
```

## 8. Networking

- The Lambdas run inside the VPC this module provisions (or the one you
  pass in via `vpc_id`). Egress is unrestricted (`0.0.0.0/0`) so they
  can reach api.github.com, the Bedrock endpoint, and your OTel
  collector. Tighten via NAT + endpoint policies if your security
  posture requires it (see `docs/deployment/aws.md` § *Hardening*).
- RDS sits in private subnets, only ingestible from the Lambda security
  group on TCP/5432.
- API Gateway is public; only `POST /webhook` and `GET /healthz`
  routes exist. The receiver still does HMAC verification before doing
  any work.

## 9. Cost control

- **Set a CloudWatch alarm** on `review_agent_cost_usd_total` (the
  worker emits this; see `docs/architecture/observability.md`) for the
  daily ceiling you want.
- **Bedrock has on-demand pricing** with no hard cap — request a
  spending alert in AWS Cost Explorer. Anthropic on-demand limits are
  configured per AWS account.
- **RDS** is the static line item; switch to Aurora Serverless v2 (not
  in this module — see comments in `main.tf`) for ≤ 50 PRs/day so the
  database can pause.
- **Lambda** is per-execution; the worker dominates. Lower
  `worker_memory_mb` and `worker_timeout_seconds` if you observe most
  reviews finish well under the timeout.

## 10. Logging & observability

- Both functions log to `/aws/lambda/<name>-receiver` and
  `/aws/lambda/<name>-worker` with the retention configured by
  `var.log_retention_days`.
- Set `otel_traces_endpoint` + `otel_headers` to forward spans to
  Langfuse / Honeycomb / Tempo. Body redaction is on by default
  (`langfuse_log_bodies = "0"`); flip to `"1"` only for deliberate
  debugging in trusted environments.
- Worker metrics land on the OpenTelemetry meter exported via the same
  OTLP pipeline. Recommended dashboards / alerts are listed in
  `docs/architecture/observability.md`.

## 11. Backup & DR

- RDS automated backups: 14 days for `environment = "prod"`, 1 day
  otherwise. Enable cross-region snapshot copy from the AWS console for
  geographic DR.
- Secrets Manager versioning is on by default; previous versions stay
  for 30 days post-rotation.
- DLQ has 14-day message retention so a 1-week incident response window
  is comfortable.

## 12. Security hardening checklist

- [ ] Enable AWS GuardDuty in the account (catches suspect Lambda
      egress patterns).
- [ ] Enable RDS Performance Insights with KMS-encrypted key (already
      on by default in this module).
- [ ] Rotate the GitHub webhook secret + App private key on a 90-day
      schedule (`docs/deployment/aws.md` § *Rotation*).
- [ ] Restrict API Gateway with a WAF (out of scope here).
- [ ] Enable VPC Flow Logs to S3 + Athena for forensic queries.
- [ ] Require IAM users to have MFA before assuming the deploy role
      that ran `terraform apply`.

## 13. Upgrade procedure

1. Build + push a new image: `docker build -t <ecr-uri>:vX.Y.Z .`
2. Update `image_uri` in `terraform.tfvars`.
3. `terraform apply` — Terraform updates each Lambda's `image_uri` in
   place; AWS rolls the new container without downtime.
4. (Optional) Use Lambda **versions + aliases** for blue/green: not
   wired in this module to keep the example readable. Pattern is in
   `docs/deployment/aws.md` § *Upgrades*.

## 14. Cleanup / teardown

```bash
terraform destroy
```

Then manually:

- Delete the ECR repo (`aws ecr delete-repository --repository-name review-agent --force`).
- Remove the GitHub App's webhook URL or uninstall the App entirely.
- Revoke the Anthropic API key in console.anthropic.com (if used).
- Revoke any IAM access keys that were used to provision.

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `terraform apply` fails on `aws_db_instance` `Insufficient capacity` | RDS instance class not available in the AZ | Pick another AZ via `db_subnet_group` subnets, or change `db_instance_class`. |
| Receiver returns 401 for every webhook | webhook secret mismatch | `aws secretsmanager put-secret-value --secret-id review-agent/github-webhook-secret --secret-string '<actual>'`; redeploy via `terraform taint`+`apply`. |
| Worker logs `Bedrock model access denied` | Model access not approved or wrong `region` | Approve under Bedrock console → Model access in the same region as `var.region`. |
| Worker logs `password authentication failed` for Postgres | `db_password` mismatch between Terraform var and Secrets Manager value | Re-run `terraform apply` so the `aws_secretsmanager_secret_version.db` resource refreshes. |
| Messages pile up in `<name>-jobs-dlq` | Worker 5× failures on same payload | Inspect `aws sqs receive-message --queue-url ${dlq_arn}` then delete after fixing root cause. |
| Lambda cold start > 5s | Container image > 1.5 GB | Re-run `pnpm prune --prod` in the Dockerfile's runtime stage; consider Lambda SnapStart (Node 24 GA in late 2026). |
| `bedrock:InvokeModel ThrottlingException` | Bedrock account quota | Request quota increase via AWS Service Quotas console. |
| `secretsmanager:GetSecretValue` denied at runtime | Secret name mismatch between TF var and the actual secret name | Either set `*_secret_name` variables to the existing secret, or let TF manage it (default). |
| API Gateway 502 on `/webhook` | Receiver Lambda image entrypoint wrong | The receiver's `image_config.command` must point at `packages/server/dist/serverless.js`. Confirm the Dockerfile output path. |
| `terraform destroy` hangs on RDS | `deletion_protection = true` for `environment = "prod"` | `aws rds modify-db-instance --db-instance-identifier review-agent-db --no-deletion-protection`, then re-run. |

## 16. References

- [`docs/deployment/aws.md`](../../docs/deployment/aws.md) — narrative version of this README.
- [`docs/architecture/observability.md`](../../docs/architecture/observability.md) — OTel + body-redaction defaults.
- Spec §15.1 — AWS Lambda + Terraform reference deploy.
- Spec §18.3 — per-cloud README outline (this README's source of truth).
- Spec §8.5 — BYOK + Bedrock setup.
- Spec §15.6.6 — container image base hygiene + Trivy scan in release CI.
- AWS docs: [Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html),
  [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html),
  [Bedrock Anthropic models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html).
