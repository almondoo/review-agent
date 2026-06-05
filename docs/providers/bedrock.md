# AWS Bedrock provider setup

`provider.type: bedrock` runs Anthropic Claude models on AWS Bedrock. Auth is
via the **standard AWS credential provider chain** — the same chain used by the
AWS CLI and AWS SDKs.

Use this provider when:
- Your infrastructure is on AWS and you want private VPC endpoints.
- Your security policy requires all data to stay within your AWS account.
- You want to use Claude via your existing AWS billing relationship.

---

## Credentials

The driver uses the AWS SDK's standard credential provider chain. No dedicated
env var is required; the driver reads whichever credential source the chain
resolves first:

| Source | When it applies |
|---|---|
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`) | Explicit credentials in environment |
| `AWS_PROFILE` | Named profile from `~/.aws/credentials` |
| IAM Role for EC2 / ECS task role / Lambda execution role | Running on AWS compute |
| IRSA (IAM Roles for Service Accounts) | Running on EKS |
| AssumeRoleWithWebIdentity (Workload Identity) | Any OIDC-compatible environment |

**Required IAM permissions** for the execution role / user:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream"
  ],
  "Resource": "arn:aws:bedrock:<region>::foundation-model/anthropic.claude-*"
}
```

---

## Model access

Bedrock requires you to **request access** to Anthropic models before use:

1. In the [AWS Console](https://console.aws.amazon.com/bedrock), go to
   **Bedrock → Model access**.
2. Click **Manage model access**.
3. Select the Anthropic Claude models you need and submit the request.
   Approval is typically instant for on-demand access.

---

## Configuration

```yaml
# .review-agent.yml
provider:
  type: bedrock
  model: anthropic.claude-sonnet-4-6-v1:0   # required
  region: us-east-1                          # required
  fallback_models:
    - anthropic.claude-haiku-4-5-v1:0
```

### Region

`region` is **required**. The driver raises a clear error at startup if it is
missing. Set it to the AWS region where you have enabled Bedrock model access.

Common regions with Anthropic model support:
- `us-east-1` (N. Virginia)
- `us-west-2` (Oregon)
- `eu-west-1` (Ireland)
- `ap-southeast-1` (Singapore)

Check the
[Bedrock model availability page](https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html)
for the current region matrix per model.

### Supported models

| Model ID | Input $/MTok | Output $/MTok | Prompt caching |
|---|---|---|---|
| `anthropic.claude-sonnet-4-6-v1:0` | $3.00 | $15.00 | Yes |
| `anthropic.claude-sonnet-4-5-v1:0` | $3.00 | $15.00 | Yes |
| `anthropic.claude-haiku-4-5-v1:0` | $0.80 | $4.00 | Yes |

Prices from `packages/llm/src/pricing.ts`. Verify at
[aws.amazon.com/bedrock/pricing](https://aws.amazon.com/bedrock/pricing).

Note: Bedrock pricing includes the Anthropic markup. On-demand pricing
varies by region; cross-region inference may incur additional charges.

---

## Prompt caching

Anthropic models on Bedrock support prompt caching. Set
`anthropic_cache_control: true` (the default) to enable. Cache hit/miss counts
appear in the run metrics.

---

## Caveats

- **Model ID format**: Bedrock uses the `anthropic.` prefix and a `:0` (or
  `:1`) revision suffix (e.g. `anthropic.claude-sonnet-4-6-v1:0`). The bare
  Anthropic model ID (`claude-sonnet-4-6`) will fail on Bedrock.
- **Cross-region inference**: if you enable cross-region inference in Bedrock
  (for higher throughput), the model ID prefix changes (e.g.
  `us.anthropic.claude-sonnet-4-6-v1:0`). Update `provider.model` accordingly.
- **VPC endpoint**: for private networking, configure a Bedrock VPC endpoint
  in your VPC. The AWS SDK respects the standard VPC endpoint resolution.
- **Data residency**: AWS does not use customer data submitted to Bedrock for
  model training. Data is stored in the selected region.

---

## Local development

Use a named AWS profile or set env vars:

```bash
export AWS_REGION=us-east-1
export AWS_PROFILE=my-profile   # with Bedrock permissions
```

Or with explicit keys (development only — do not commit):

```bash
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
```

---

## See also

- [parity-matrix.md](./parity-matrix.md) — cross-provider comparison.
- [aws.md](../deployment/aws.md) — full AWS deployment guide (Lambda + SQS + RDS).
- [config-reference.md — `provider`](../configuration/config-reference.md#provider).
