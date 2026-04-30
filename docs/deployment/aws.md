# Deploying review-agent on AWS (Lambda + SQS + RDS)

This is the narrative companion to
[`examples/aws-lambda-terraform/`](../../examples/aws-lambda-terraform/).
Read this end-to-end before your first deploy. After that, the README in
the example directory is enough for day-to-day operations.

Spec references: §15.1, §15.6.6, §18.3, §8.5, §17.1.

---

## 1. At a glance

- **Compute**: 2× Lambda (container image) — receiver + worker.
- **Queue**: SQS main + DLQ.
- **Database**: RDS Postgres 16 (or Aurora Serverless v2 with light
  edits). Single instance — no read replicas at this scale.
- **Secrets**: Secrets Manager.
- **LLM provider**: Bedrock-Anthropic by default (no external key).
- **Webhook URL**: API Gateway HTTP API (`https://<api-id>.execute-api.<region>.amazonaws.com/webhook`).
- **Cost**: ~$25–$220/mo depending on PR volume; see
  [`examples/aws-lambda-terraform/README.md`](../../examples/aws-lambda-terraform/README.md) § 1.
- **Suitable for**: solo devs through mid-sized orgs (≤ ~5 PRs/min
  sustained). For higher rates, swap the worker to Fargate / ECS — out
  of scope here.

## 2. Architecture

GitHub posts webhooks to the API Gateway endpoint. The **receiver
Lambda** verifies the HMAC signature (spec §7.1), checks the
idempotency table for duplicate `X-GitHub-Delivery` IDs, and pushes a
`JobMessage` onto SQS. The **worker Lambda** consumes one message at a
time, fetches the PR diff via the GitHub App credentials, runs the
review pipeline, and posts comments back. Postgres holds the review
state mirror, the cost ledger, and the audit log. Secrets Manager holds
the webhook secret, the App private key, optionally the Anthropic API
key, and the database connection string.

The same container image runs both Lambdas — they differ only in the
`image_config.command` entrypoint. That keeps the build pipeline simple
and the artifact small.

For the full request flow, see the diagram in the example README.

## 3. Prerequisites

| Item | Notes |
|---|---|
| Terraform ≥ 1.6 | Lower versions miss `validation` blocks used in `variables.tf`. |
| AWS CLI ≥ 2.15 | For Secrets Manager `put-secret-value`. |
| Docker | Build + push the worker image. |
| AWS account | Permissions for IAM, Lambda, RDS, API Gateway, Secrets Manager, SQS, ECR, VPC. |
| GitHub App | Created in your org's Settings → Developer settings → GitHub Apps. App ID + PEM downloaded. |
| Bedrock model access | Approved Anthropic Claude in `var.region` (request via Bedrock console → *Model access*). |
| ECR repository | `review-agent`, in the deploy region. |

If you're integrating with an existing VPC, also gather the VPC ID and
two private subnet IDs in different AZs.

## 4. Provider selection

This deployment defaults to **Bedrock-Anthropic** rather than the
external Anthropic API. The reasoning:

- **Auth**: the worker IAM role is the entire credential story —
  no API key to provision, rotate, or leak via env vars.
- **Billing**: token spend lands on the same AWS bill as the rest of
  the stack, which is the line item your finance team already monitors.
- **Latency**: Bedrock endpoints are co-located with Lambda in the same
  region. External Anthropic adds a public-internet hop.
- **Compliance**: Bedrock contractually keeps prompts / completions
  outside Anthropic's training pipelines (see your AWS rep's letter
  for current language). External Anthropic has the same posture but
  the contracting story is different per org.

Set `llm_provider = "anthropic"` and populate
`review-agent/anthropic-api-key` in Secrets Manager to opt out.

OpenAI / Azure OpenAI / Vertex are also available via the runner's
provider abstraction but not wired into this Terraform — bring your own
secret + IAM tweaks.

## 5. Step-by-step setup

### 5.1 Create the GitHub App (10 min)

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Name: `review-agent` (or any unique label). Homepage URL: anything;
   we don't display it.
3. **Webhook URL**: leave `https://example.com/placeholder` for now —
   you'll come back after `terraform apply` prints the real URL.
4. **Webhook secret**: generate with `openssl rand -hex 32`. Save it —
   you'll paste it into Secrets Manager.
5. **Permissions**:
   - Repository: Pull requests (Read + Write), Contents (Read), Issues
     (Read + Write — for PR comment commands per §10.3).
   - Subscribe to events: Pull request, Pull request review,
     Pull request review comment, Issue comment.
6. Where can this GitHub App be installed: pick "Only on this account".
7. Create. **Generate a private key** (PEM); save it.
8. Note the **App ID** — that goes into `terraform.tfvars`.

### 5.2 First Terraform apply — provision the long-lead resources

The RDS instance takes the longest (5–10 min) so apply it first:

```bash
cd examples/aws-lambda-terraform
terraform init

cat > terraform.tfvars <<EOF
name          = "review-agent"
region        = "us-east-1"
environment   = "prod"
github_app_id = "<your-app-id>"
image_uri     = "123456789012.dkr.ecr.us-east-1.amazonaws.com/review-agent:bootstrap"
db_password   = "$(openssl rand -base64 32)"
EOF

terraform apply -target=aws_db_instance.this \
                -target=aws_secretsmanager_secret.webhook \
                -target=aws_secretsmanager_secret.app_key
```

(`image_uri` is a placeholder for now — we'll rebuild + apply with the
real one in §5.4.)

### 5.3 Populate Secrets Manager (5 min)

```bash
aws secretsmanager put-secret-value \
  --secret-id review-agent/github-webhook-secret \
  --secret-string "$WEBHOOK_SECRET_FROM_§5.1.4"

aws secretsmanager put-secret-value \
  --secret-id review-agent/github-app-private-key \
  --secret-string "$(cat path/to/your-github-app.private-key.pem)"

# Only if llm_provider = "anthropic":
aws secretsmanager put-secret-value \
  --secret-id review-agent/anthropic-api-key \
  --secret-string "$ANTHROPIC_API_KEY"
```

### 5.4 Build and push the worker image (10 min)

```bash
# from the repo root:
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com

VERSION=0.2.0
docker build -t review-agent:$VERSION .
docker tag review-agent:$VERSION 123456789012.dkr.ecr.us-east-1.amazonaws.com/review-agent:$VERSION
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/review-agent:$VERSION
```

Update `image_uri` in `terraform.tfvars` to the full ECR URI you just
pushed.

### 5.5 Final Terraform apply (5 min)

```bash
terraform apply
```

Outputs:

```
webhook_url = "https://abcd1234.execute-api.us-east-1.amazonaws.com/webhook"
healthz_url = "https://abcd1234.execute-api.us-east-1.amazonaws.com/healthz"
queue_arn   = "arn:aws:sqs:us-east-1:...:review-agent-jobs"
dlq_arn     = "arn:aws:sqs:us-east-1:...:review-agent-jobs-dlq"
```

### 5.6 Wire the webhook URL back to GitHub (1 min)

Edit the GitHub App. Replace the placeholder Webhook URL with
`webhook_url`. Save.

### 5.7 Verify (5 min)

```bash
curl "$(terraform output -raw healthz_url)"
# → ok
```

Open a draft PR in any installed repository, push a commit. The
worker should post a review within ~1 minute. If nothing happens:

```bash
# Recent receiver logs (look for "verified signature" + "enqueued"):
aws logs tail /aws/lambda/review-agent-receiver --since 10m

# Recent worker logs:
aws logs tail /aws/lambda/review-agent-worker --since 10m

# Queue depth:
aws sqs get-queue-attributes --queue-url "$(terraform output -raw queue_arn | sed 's/arn:aws:sqs:[^:]*:[^:]*:/https:\/\/sqs.us-east-1.amazonaws.com\/<account>\//')" \
  --attribute-names ApproximateNumberOfMessages
```

## 6. Terraform inputs reference

The example README at
[`examples/aws-lambda-terraform/README.md`](../../examples/aws-lambda-terraform/README.md)
§ 6 has the full input table. Variables are also fully documented in
`variables.tf`.

## 7. LLM provider setup

### 7.1 Bedrock (default)

1. Bedrock console → **Model access** in `var.region`.
2. *Modify model access* → enable each Anthropic Claude variant you
   want. The console asks for a brief use-case description for the
   first model in each family.
3. Approval lands within a day. The IAM policy this module attaches
   already grants `bedrock:InvokeModel` on
   `arn:aws:bedrock:<region>::foundation-model/anthropic.*`.

### 7.2 External Anthropic

Set `llm_provider = "anthropic"`, `terraform apply`, then populate
`review-agent/anthropic-api-key` per §5.3. The worker reads the env var
`ANTHROPIC_API_KEY_SECRET_NAME` and fetches the value at boot.

### 7.3 OpenAI / Azure OpenAI / Vertex

Not wired in this Terraform. Add a Secrets Manager entry for the API
key, attach `secretsmanager:GetSecretValue` on it to the worker role,
and override `LLM_PROVIDER` + `MODEL_ID` env vars on
`aws_lambda_function.worker`. The runner picks the provider from
`.review-agent.yml` per repository, so a single deployment can serve
mixed-provider configs.

## 8. Networking

- Lambdas run **inside the VPC** so they can reach RDS over the
  Postgres security group. Egress to the public internet (GitHub API,
  Bedrock, OTLP collector) goes via the default route to an Internet
  Gateway through the public subnets — **the example does not
  provision a NAT**, which keeps cost low at the trade-off of less
  egress isolation.
- For stricter posture: provision a NAT Gateway, attach
  `endpoint_policies` for `secretsmanager`, `bedrock-runtime`, `sqs`,
  and `ecr.api`/`ecr.dkr` so the Lambdas can reach AWS APIs without
  ever touching the public internet. GitHub API calls still need IGW
  egress; route those over a NAT.
- The receiver Lambda is **not** in the VPC by default — actually, in
  this module both Lambdas are in the VPC because the worker needs DB
  reach. If receiver cold-start latency matters more than VPC isolation
  for the receiver, lift `aws_lambda_function.receiver`'s `vpc_config`
  out (it doesn't talk to RDS).

## 9. Cost control

| Lever | Where | Effect |
|---|---|---|
| Reduce `worker_memory_mb` | `terraform.tfvars` | Linearly cuts Lambda runtime cost. |
| Lower `worker_timeout_seconds` | `terraform.tfvars` | Force-fail very-large reviews earlier; cheaper failure mode. |
| Switch to Aurora Serverless v2 | `main.tf` (replace `aws_db_instance`) | Pause-when-idle for ≤ 50 PRs/day teams. |
| Cap Bedrock spend | AWS Service Quotas console | Per-model TPM ceiling protects against runaway loops. |
| `review-agent.yml` `cost.max_usd_per_pr` | per-repo config | Hard ceiling per PR review (see spec §8.5). |
| `log_retention_days` | `terraform.tfvars` | Older logs are deleted. |
| CloudWatch alarm on `review_agent_cost_usd_total` | OTel metric → CloudWatch metric stream | Daily budget alert. |

## 10. Logging & observability

- CloudWatch log groups:
  - `/aws/lambda/<name>-receiver` — webhook intake.
  - `/aws/lambda/<name>-worker` — review runs.
- OpenTelemetry export: set `otel_traces_endpoint` +
  `otel_headers` (e.g. Langfuse Cloud:
  `https://cloud.langfuse.com/api/public/otel/v1/traces` +
  `Authorization=Basic <base64(public:secret)>`). The full set of
  span names + attributes is documented in
  [`docs/architecture/observability.md`](../architecture/observability.md).
- **Body redaction is on by default.** The OTLP exporter strips
  `llm.input.messages`, `llm.output.completion`, `llm.input.prompt`,
  `tool.input.body`, and `tool.output.body` before sending. Set
  `langfuse_log_bodies = "1"` in `terraform.tfvars` to capture them
  (only do this in dev / staging — bodies contain customer source
  code).
- CloudWatch metric stream → OTLP if you want one collector to receive
  both Lambda runtime metrics and the agent's domain metrics.

Recommended alarms:

| Alarm | Condition |
|---|---|
| `<name>-jobs-dlq messages > 0` | Worker has 5×-failed something. Pages oncall. |
| `<name>-jobs queue oldest message age > 10 min` | Worker is stuck or under-provisioned. |
| `worker invocation errors > 1% over 5 min` | Recent deploy regressed. |
| `cost_usd_total > daily budget` | Per spec §8.5; cap runaway spend. |

## 11. Backup & DR

- **RDS automated backups**: 14 days for `prod`, 1 day otherwise. Daily
  snapshot is sufficient given the cost-ledger / audit-log retention
  posture.
- **Point-in-time recovery** is enabled by default (RDS feature). Use
  `aws rds restore-db-instance-to-point-in-time` for incident recovery.
- **Cross-region snapshot copy**: not provisioned by this module. If
  geographic DR matters, enable
  `aws_db_instance.this.replicate_source_db` to a read replica in a
  second region or wire `aws_db_snapshot_copy` on a schedule.
- **Secrets Manager** keeps prior secret versions for 30 days
  post-rotation; you can roll back without redeploying.
- **DLQ** retention is 14 days, so a 1-week incident response window is
  comfortable for replaying failed jobs.

**RPO / RTO**:

- RPO: 5 min (RDS continuous backups; default).
- RTO: 15 min (fresh `terraform apply` against the last good image +
  RDS restore).

## 12. Security hardening checklist

- [ ] Enable **AWS GuardDuty** account-wide. Catches anomalous Lambda
      egress (e.g. data exfiltration via outbound DNS).
- [ ] Enable **CloudTrail** organization trail. The Terraform stack
      itself touches IAM and Lambda; you want a tamper-evident log.
- [ ] Enable **AWS Config** rules:
      `lambda-function-public-access-prohibited`,
      `secretsmanager-rotation-enabled-check`,
      `rds-storage-encrypted` (already on by default in this module).
- [ ] Schedule **secret rotation** every 90 days for the webhook secret
      and GitHub App private key. Rotation procedure:
      ```bash
      # New webhook secret in GH App settings → save the new value here:
      aws secretsmanager put-secret-value --secret-id review-agent/github-webhook-secret \
        --secret-string "$NEW"
      # Lambdas refresh on next cold start, but force a refresh:
      aws lambda update-function-configuration --function-name review-agent-receiver \
        --environment "Variables={ROTATED_AT=$(date +%s),...existing-vars...}"
      ```
- [ ] **WAF** in front of API Gateway (rate-limit + bot mitigation).
      Not in this module to keep the example readable.
- [ ] **VPC Flow Logs** to S3 + Athena for forensic queries.
- [ ] **MFA-required IAM** for the user / role that runs
      `terraform apply`.

## 13. Upgrade procedure

```bash
# Build + push:
VERSION=0.2.1
docker build -t review-agent:$VERSION .
docker tag review-agent:$VERSION <ecr-uri>:$VERSION
docker push <ecr-uri>:$VERSION

# Update tfvars:
sed -i.bak "s|image_uri.*|image_uri = \"<ecr-uri>:$VERSION\"|" terraform.tfvars
terraform apply
```

Lambda updates `image_uri` in place. The receiver picks up the new
image on the next cold start (almost instant for a quiet system); the
worker picks it up on the next SQS receive. There is no in-flight job
guarantee — if the upgrade interrupts a running review, SQS will
re-deliver the message and the new code will retry it.

For full blue/green: wire Lambda **versions + aliases** + traffic shift
via CodeDeploy. Pattern:

```hcl
resource "aws_lambda_alias" "worker_live" {
  name             = "live"
  function_name    = aws_lambda_function.worker.function_name
  function_version = aws_lambda_function.worker.version
}
```

…then point the SQS event source mapping at the alias instead of the
function name and shift traffic via CodeDeploy. Out of scope for this
example.

## 14. Cleanup / teardown

```bash
terraform destroy
```

Manual residue to clean up:

- **ECR repo**: `aws ecr delete-repository --repository-name review-agent --force`.
- **GitHub App webhook URL**: clear it or uninstall the App.
- **Anthropic API key** (if used): revoke in console.anthropic.com.
- **CloudWatch log groups**: if `log_retention_days` was set after
  Terraform created them, the groups stay until retention expires.
- **Secrets Manager** keeps deleted secrets in a "scheduled deletion"
  state for 7–30 days. Force-purge via
  `aws secretsmanager delete-secret --force-delete-without-recovery`.

## 15. Troubleshooting

See [`examples/aws-lambda-terraform/README.md`](../../examples/aws-lambda-terraform/README.md) § 15 for the top-10 error
table with cause + fix.

Additional patterns specific to this narrative:

- **`terraform plan` shows changes on every run, even with no edits** —
  AWS Lambda environment variable ordering is non-deterministic in older
  provider versions. Pin `aws` provider to `~> 5.70` (already in
  `versions.tf`).
- **Worker reads from SQS but never finishes** — RDS SG missing the
  Lambda SG ingress. The example wires this in `aws_security_group.rds`;
  if you supply your own VPC with `vpc_id`, recreate the rule against
  the supplied subnets.
- **CodeCommit option** — this Terraform deploys against GitHub. To
  point the same stack at a CodeCommit repo, swap the GitHub
  webhook delivery for an EventBridge → SQS bridge per spec §7.1, and
  use `@review-agent/platform-codecommit` as the VCS adapter. State for
  CodeCommit lives **only in Postgres** (spec §12.1.1), so the DR story
  becomes critical: there is no equivalent of the GitHub
  `recover sync-state-from-hidden-comment` path. Take regular RDS
  snapshots and treat the DB as a hard dependency.

## 16. References

- Spec §15.1 — AWS Lambda + Terraform reference deploy.
- Spec §18.3 — per-cloud README outline (drives this doc's structure).
- Spec §7.1 — webhook signature verification (and CodeCommit SNS
  signature note).
- Spec §8.5 — BYOK + Bedrock setup.
- Spec §15.6.6 — container image base hygiene + Trivy scan.
- Spec §17.1 — data flow disclosure (links from this doc into the user-
  facing README).
- [AWS Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
- [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Bedrock supported models](https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html)
- [GitHub App webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
