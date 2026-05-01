# Helm chart — review-agent on Kubernetes

Cloud-agnostic Helm 3 chart for self-hosting `review-agent` on a
Kubernetes cluster. Bundles a receiver Deployment + a KEDA-scaled
worker Deployment + ConfigMap + ServiceAccount + optional Ingress
+ optional ServiceMonitor.

Spec references: §15.5, §13.2, §15.6.3, §15.6.6.

---

## What you get

- **Receiver**: 2 replicas by default, listening on port 8080. The
  receiver verifies the GitHub webhook HMAC, idempotency-checks the
  delivery, and pushes onto your queue (SQS / Pub/Sub / Service Bus).
- **Worker**: scaled by KEDA against the queue depth. Defaults are
  min=0 / max=10; the trigger metadata differs per cloud.
- **ConfigMap** + **Secret reference** wire env into both pods. The
  Secret is operator-managed (Sealed Secrets, external-secrets, or
  plain `kubectl create secret`) — the chart never bakes plaintext
  into values.
- **ServiceAccount** with cloud-specific annotations for IRSA /
  Workload Identity / Azure AD Workload Identity.
- **ServiceMonitor** (optional): exports the §13.2 metrics from
  `/metrics` on the receiver pod for Prometheus Operator clusters.
- **Hardened pod**: non-root, read-only rootfs, all caps dropped,
  RuntimeDefault seccomp profile.

## Prerequisites

- Kubernetes ≥ 1.27.
- [KEDA](https://keda.sh/) installed in the cluster (`helm install
  keda kedacore/keda -n keda --create-namespace`).
- A queue (SQS / Pub/Sub / Service Bus) provisioned out-of-band —
  the cloud-specific Terraform examples (`examples/aws-lambda-terraform/`
  etc.) provision the same shape if you want a starting point.
- A Postgres reachable from the cluster (RDS / Cloud SQL / Azure
  Database for PostgreSQL, or self-hosted).
- A Secret in the target namespace named per `secrets.existingSecret`
  (default: `review-agent-secrets`) carrying:
  - `ANTHROPIC_API_KEY`
  - `GITHUB_APP_PRIVATE_KEY_PEM`
  - `GITHUB_WEBHOOK_SECRET`
  - `OTEL_EXPORTER_OTLP_HEADERS` *(optional)*

For multi-tenant deployments, swap `ANTHROPIC_API_KEY` for the
KMS-encrypted BYOK store from `docs/security/byok.md` — the chart's
worker reads either path identically.

## Install

Pick the cloud overlay that matches your queue and combine with the
defaults:

```bash
# AWS / SQS:
helm install review-agent ./examples/helm/review-agent \
  -f ./examples/helm/review-agent/values-aws.yaml \
  --set config.QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<account>/review-agent-jobs \
  --set config.DATABASE_URL=postgres://review_agent:****@db.cluster.local:5432/review_agent \
  --set config.GITHUB_APP_ID=1234567 \
  --namespace review-agent --create-namespace

# GCP / Pub/Sub:
helm install review-agent ./examples/helm/review-agent \
  -f ./examples/helm/review-agent/values-gcp.yaml \
  --set config.QUEUE_URL=projects/<project>/subscriptions/review-agent-jobs \
  ...

# Azure / Service Bus:
helm install review-agent ./examples/helm/review-agent \
  -f ./examples/helm/review-agent/values-azure.yaml \
  --set config.QUEUE_URL=sb://<ns>.servicebus.windows.net/review-agent-jobs \
  ...
```

Edit the corresponding `values-<cloud>.yaml` to point the
ServiceAccount annotation and KEDA trigger at your real resources
before installing — the placeholders (`<account>`, `<region>`, etc.)
are commented intentionally.

## Validate the chart locally

```bash
helm lint examples/helm/review-agent

# AWS sample render:
helm template review-agent examples/helm/review-agent \
  -f examples/helm/review-agent/values-aws.yaml > /tmp/review-agent.yaml

# Apply via kustomize / argo / fluxcd as you prefer.
```

`helm template` should emit the seven manifests:

- ConfigMap
- ServiceAccount
- Receiver Deployment + Service (+ optional Ingress)
- Worker Deployment + ScaledObject
- ServiceMonitor (when enabled)

## Container image trust

`ghcr.io/almondoo/review-agent:vX.Y.Z` is signed with cosign keyless
OIDC (spec §15.6.3). Install
[Sigstore Policy Controller](https://docs.sigstore.dev/policy-controller/overview)
in the cluster and pin a `ClusterImagePolicy` matching the image
identity:

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: review-agent-image
spec:
  images:
    - glob: ghcr.io/almondoo/review-agent:*
  authorities:
    - keyless:
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subjectRegExp: ^https://github\.com/almondoo/review-agent/\.github/workflows/release\.yml@refs/tags/.*$
```

The chart does not install this policy — that's a cluster-level
operator decision. Document it in your runbook.

## Secrets — Sealed Secrets vs external-secrets

Both work; pick the one your cluster already runs.

**Sealed Secrets**:

```bash
kubectl create secret generic review-agent-secrets \
  --from-literal=ANTHROPIC_API_KEY=... \
  --from-literal=GITHUB_APP_PRIVATE_KEY_PEM="$(cat app.pem)" \
  --from-literal=GITHUB_WEBHOOK_SECRET=... \
  --dry-run=client -o yaml | kubeseal -o yaml > review-agent-sealed.yaml
kubectl apply -n review-agent -f review-agent-sealed.yaml
```

**external-secrets** (e.g., AWS Secrets Manager):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: review-agent-secrets
  namespace: review-agent
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-sm, kind: ClusterSecretStore }
  target: { name: review-agent-secrets }
  data:
    - secretKey: ANTHROPIC_API_KEY
      remoteRef: { key: review-agent/anthropic-api-key }
    - secretKey: GITHUB_APP_PRIVATE_KEY_PEM
      remoteRef: { key: review-agent/github-app-private-key }
    - secretKey: GITHUB_WEBHOOK_SECRET
      remoteRef: { key: review-agent/github-webhook-secret }
```

## Upgrading

```bash
helm upgrade review-agent ./examples/helm/review-agent \
  -f ./examples/helm/review-agent/values-aws.yaml \
  --reuse-values \
  --set image.tag=v0.4.0
```

The receiver is rolling-updated through its Deployment; the worker
is replaced as KEDA scales it. In-flight jobs survive because the
queue's visibility timeout exceeds a single review's runtime, so a
crash redelivers to a fresh pod.

## Uninstall

```bash
helm uninstall review-agent -n review-agent
kubectl delete namespace review-agent
```

The Secret survives `helm uninstall` since it's operator-managed —
delete it explicitly if you want a clean slate.

## Per-cloud notes

| Cloud | KEDA trigger | Auth path |
|---|---|---|
| AWS | `aws-sqs-queue` | IRSA via `eks.amazonaws.com/role-arn` |
| GCP | `gcp-pubsub` | Workload Identity via `iam.gke.io/gcp-service-account` |
| Azure | `azure-servicebus` | AAD Workload Identity via `azure.workload.identity/client-id` |

The `values-<cloud>.yaml` overlays document the exact annotations
each cloud needs; run `helm template ... -f values-<cloud>.yaml` to
confirm they render correctly before a real install.
