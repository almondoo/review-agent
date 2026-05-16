# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
privately via [GitHub Security Advisories](https://github.com/almondoo/review-agent/security/advisories/new).

Do **not** report security issues through public channels (forks, discussions,
or social media) until they have been addressed. As this is a personal
project, response times are best-effort but you can expect an initial
acknowledgement within a reasonable timeframe.

**Escalation contact**: the project maintainer ([@almondoo](https://github.com/almondoo)).
For multi-tenant operators running their own deployment, *you* are the
escalation contact for your installation; this project doesn't operate
a hosted instance.

---

## Threat model

`review-agent` runs untrusted code (the diff being reviewed) through an LLM
that has tool access. We treat the following as untrusted input at all times:

- PR title, body, commit messages, branch name, author display name
- File contents within the diff
- Anything the agent reads via `read_file` / `glob` / `grep`
- Skill content embedded in user-controlled paths

Adversaries can attempt:

1. **Prompt injection** in any of the above to make the agent leak the
   system prompt, exfiltrate secrets, post arbitrary comments, or skip
   the review entirely.
2. **Path traversal** to read files outside the changed paths
   (e.g. `.env`, `.git/config`, `node_modules` lockfiles with tokens).
3. **Symlink attacks** to pivot from a sandboxed clone to host paths.
4. **Cost exhaustion** by inflating diff size, agent loop depth, or tool
   calls.
5. **Secret leakage** in agent reasoning, tool output, or final comments.

## Built-in mitigations

| Threat | Mitigation | Spec ref |
|---|---|---|
| Prompt injection | Untrusted-content wrapper in system prompt; injection-guard middleware; user content never executed as instructions | §6.4, §11 |
| Path traversal | Denylist (`.env*`, `.git/`, `node_modules/`); resolve-and-verify against partial+sparse clone root; symlink refusal | §11.2 |
| Symlinks | `read_file` rejects symlinks; tool calls rooted at the clone dir | §11.2 |
| Cost exhaustion | Per-PR `cost-cap-usd` hard cap; cost-guard middleware short-circuits the loop; tool-call budget per turn | §6.2, §11.1 |
| Secret leakage | Two-stage in-process scan via `quickScanContent` (`packages/runner/src/gitleaks.ts`): diff pre-scan before the LLM call, output post-scan before posting. Aborts on a high-confidence rule hit or >3 findings (`SecretLeakAbortedError`); non-aborting findings get `applyRedactions`. See [`docs/security/threat-model-review-2026-05.md`](./docs/security/threat-model-review-2026-05.md) rows T-2 / I-2 for the implementation contract and tests. | §11.3 |
| Container escape | Non-root `agent` user; `REVIEW_AGENT_SANDBOXED=1`; minimal alpine base; no host mounts in the default Action | §15.1 |
| Bot author abuse | `ignore_authors` defaults skip `dependabot[bot]` / `renovate[bot]` / `github-actions[bot]` | §10 |
| Cross-tenant data leak | Postgres RLS `tenant_isolation` policy on every tenant-scoped table; fails closed when GUC unset | §16.1 |
| Provider-key compromise scope | Per-installation BYOK with KMS envelope encryption (AES-256-GCM data key wrapped under per-installation CMK) | §8.5 |

## Operational guidance

- **Scope `GITHUB_TOKEN`**: the workflow only needs `pull-requests: write` and
  `contents: read`. Don't grant `actions: write` or repo admin.
- **Pin the Action by tag**: use `almondoo/review-agent@v0.1.0` in production,
  not `@main`.
- **Use repository secrets, not env vars**: `ANTHROPIC_API_KEY` must come
  from `secrets.*`, never from PR-controlled inputs.
- **Set a cost cap**: `cost-cap-usd` is a hard ceiling, not a target.
  Default is `1.0`; lower for high-PR-volume repos.
- **Self-host runners cautiously**: the default GitHub-hosted runner is the
  recommended sandbox boundary. Self-hosted runners must enforce ephemeral
  VMs.

### Blocking merges on critical findings

Starting in v1.1, the GitHub adapter switches the underlying
`pulls.createReview` event from `COMMENT` to `REQUEST_CHANGES` when
the review contains a finding at or above the configured severity
threshold (`.review-agent.yml` → `reviews.request_changes_on`,
default `critical`). To turn this into a hard merge block:

1. Set the threshold in `.review-agent.yml`:

   ```yaml
   reviews:
     request_changes_on: critical   # or: major | never (default: critical)
   ```

2. In your GitHub repo settings, configure a branch-protection rule
   on the target branch (typically `main`):

   - **Settings → Branches → Branch protection rules → Add rule**.
   - **Branch name pattern**: `main` (or your release branch).
   - Enable **Require a pull request before merging**.
   - Under **Require a pull request before merging**, enable
     **Require approvals** (set the count to your team norm).
   - Enable **Dismiss stale pull request approvals when new commits
     are pushed**. This is what makes the bot's `REQUEST_CHANGES`
     stick across the next push instead of being silently superseded.
   - Enable **Require review from Code Owners** only if your repo
     uses `CODEOWNERS`; otherwise skip.

   `REQUEST_CHANGES` from review-agent will then count as an
   outstanding "changes requested" review, and merging is blocked
   until either the next bot run posts `COMMENT` (no critical
   findings on the new diff) or a human reviewer dismisses the
   bot's review.

3. **Caveat on threshold choice**: `request_changes_on: critical`
   is conservative and tuned to avoid blocking on hunches. Setting
   the threshold to `major` will block on a much wider class of
   findings, including some that depend on context the model
   cannot fully see (missing-await, off-by-one). On busy repos,
   start at `critical` for one milestone before tightening.

4. **Caveat on bypass**: branch-protection rules can be bypassed by
   repo admins with the **Allow administrators to bypass** option.
   For OSS repos that require an external audit trail, **disable**
   that option so the bot's `REQUEST_CHANGES` applies uniformly.

CodeCommit has no equivalent merge-blocking review state on the
comment API. Operators wanting the same behavior on CodeCommit must
wire it via approval rules in CodeCommit itself; the adapter
intentionally drops `event` on that platform.

## Pre-release security review

`review-agent` undergoes a structured **internal STRIDE
walkthrough** before each major release in lieu of a paid
third-party audit. Procedure and the option-(a)-vs-(b)
trade-off (including the 2026-05-15 amendment that accepts a
multi-AI-agent review as form (ii) for the personal-OSS scope):
[`docs/security/audit.md`](./docs/security/audit.md). Findings
log and Sign-off table:
[`docs/security/threat-model-review-2026-05.md`](./docs/security/threat-model-review-2026-05.md).

**Adopters should treat this project as having had** a structured
internal STRIDE walkthrough + a multi-AI-agent independent review,
NOT a paid third-party audit. If your environment requires the
latter, **commission your own engagement** covering at least the
categories in
[`docs/security/threat-model-review-2026-05.md`](./docs/security/threat-model-review-2026-05.md).

## Out of scope

- Attacks against the GitHub Actions runner platform itself.
- LLM provider availability and pricing changes.
- Bugs in user-supplied skills or `path_instructions`.

If in doubt, file a Security Advisory rather than guessing scope.

---

## Incident response runbooks

These runbooks are operator-facing playbooks for compromise scenarios in a
self-hosted multi-tenant deployment. v0.3 shipped them as documentation;
automation hooks remain a v1.x follow-up.

Each runbook follows the same shape:

- **Trigger**: the signal that should kick off this runbook.
- **Immediate action**: the minimum sequence of steps to revoke the
  attacker's access.
- **Verify**: the check that proves the action took effect.
- **Follow-up**: audit / forensic / customer-comms steps that can wait
  ≤ 24 hours.

Quarterly drill: the on-call team walks through §8.6.4 against a sandbox
deployment. See [`docs/security/oncall.md`](./docs/security/oncall.md)
for the full SLO/SLA table and tabletop format.

### §8.6.1 — Compromised LLM provider API key

**MTTR target: < 15 min.** Trigger: spike in `review_agent_cost_usd_total`
without a matching PR-volume spike, or an out-of-band Anthropic / OpenAI
billing alert.

```bash
# 1. Revoke the key in the provider console.
#    Anthropic: console.anthropic.com → Settings → API Keys → Revoke.
#    OpenAI:    platform.openai.com   → API keys → Revoke.

# 2. Generate a replacement.

# 3. Update the secret store. Examples below; pick whichever applies.
aws secretsmanager put-secret-value \
  --secret-id review-agent/anthropic-api-key \
  --secret-string "$NEW_KEY"
# or, for per-installation BYOK:
review-agent recover rotate-byok --installation 123 --provider anthropic --secret "$NEW_KEY"

# 4. Restart workers so they re-read the secret.
aws lambda update-function-configuration \
  --function-name review-agent-worker \
  --environment "Variables={ROTATED_AT=$(date +%s)}"
```

**Verify**: `review_agent_cost_usd_total` returns to the baseline within
10 minutes. The provider's usage dashboard shows the revoked key with
zero requests after the rotation timestamp.

**Follow-up**:

- Pull Langfuse traces (or the provider's own usage console) for the
  past 7 days. Look for prompts that aren't tied to known PR jobs.
- File a Security Advisory if customer data was leaked.

### §8.6.2 — Compromised GitHub App private key

**MTTR target: < 30 min.** Trigger: API calls from outside known worker
IPs in audit-log entries; an unexpected commit / comment authored by
the App account.

```bash
# 1. Revoke at GitHub. Requires App owner access.
#    Settings → Developer settings → GitHub Apps → <app> → Generate a private key.
#    Then DELETE the compromised key from the same page.

# 2. Update secret store with the new PEM.
aws secretsmanager put-secret-value \
  --secret-id review-agent/github-app-private-key \
  --secret-string "$(cat new-app.private-key.pem)"

# 3. Force token-cache invalidation: the cached installation tokens
#    were minted with the old App key.
psql "$DATABASE_URL" -c "TRUNCATE installation_tokens;"

# 4. Restart workers.
aws lambda update-function-configuration \
  --function-name review-agent-worker \
  --environment "Variables={ROTATED_AT=$(date +%s)}"
```

**Verify**: `audit_log` entries with `event = 'app_token_minted'` after
the rotation timestamp all have `prev_hash` chained correctly. The
GitHub App settings page shows the new key fingerprint.

**Follow-up**:

- Audit the App's recent activity feed for commits / comments / merges
  posted by the App account. Anything attributable to the attacker
  goes into the customer-comms ticket.
- If GitHub two-key overlap is configured (§8.7), rotate the second
  key on the next maintenance window.

### §8.6.3 — Compromised webhook secret

**MTTR target: < 15 min.** Trigger: receiver Lambda accepts deliveries
from unknown source IPs; replay of old `X-GitHub-Delivery` IDs.

```bash
# 1. Rotate at GitHub.
#    Settings → Developer settings → GitHub Apps → <app> →
#    Webhook secret → "Change secret".
WEBHOOK_SECRET=$(openssl rand -hex 32)
# Paste $WEBHOOK_SECRET into the GH App settings.

# 2. Update secret store.
aws secretsmanager put-secret-value \
  --secret-id review-agent/github-webhook-secret \
  --secret-string "$WEBHOOK_SECRET"

# 3. Restart workers.
aws lambda update-function-configuration \
  --function-name review-agent-receiver \
  --environment "Variables={ROTATED_AT=$(date +%s)}"

# 4. Drop the idempotency table so the attacker cannot replay an old
#    delivery_id signed with the compromised secret.
psql "$DATABASE_URL" -c "TRUNCATE webhook_deliveries;"
```

**Verify**: Send a test webhook from the GitHub App's "Recent
Deliveries" tab; confirm the receiver returns 200 and the worker logs
the new `delivery_id`.

**Follow-up**:

- Audit `audit_log` for events tied to webhook deliveries received in
  the past 7 days. Any review run on a non-existent PR head SHA is a
  clear injection signal.

### §8.6.4 — Rogue installation (multi-tenant)

Trigger: an installation is identified as malicious (cost exhaustion,
secret-leak attempts, prompt-injection patterns repeating across PRs).
Goal: hard-revoke without deleting forensic evidence.

```sql
-- Connect as a Postgres role that bypasses RLS (the migrations
-- superuser, not the application role). Open one transaction so the
-- DELETEs are atomic.
BEGIN;
SET LOCAL app.current_tenant = '<installation_id>';
DELETE FROM review_state;
DELETE FROM cost_ledger;
DELETE FROM installation_tokens;
DELETE FROM installation_secrets;
COMMIT;

-- audit_log is NOT deleted — it's the forensic record. RLS lets the
-- offender's rows stay readable to admin queries.
```

```bash
# Then disable the installation at the GitHub App admin settings:
#   Settings → Developer settings → GitHub Apps → <app> → Advanced →
#   "Suspend installation".
# Then delete the installation's KMS CMK (rotates all encrypted at
# rest):
aws kms schedule-key-deletion --key-id "$INSTALLATION_CMK_ARN" --pending-window-in-days 7
```

**Verify**:

```sql
-- Should return 0 rows for every tenant-scoped table.
SELECT COUNT(*) FROM review_state    WHERE installation_id = <id>;
SELECT COUNT(*) FROM cost_ledger     WHERE installation_id = <id>;
SELECT COUNT(*) FROM installation_tokens WHERE installation_id = <id>;
SELECT COUNT(*) FROM installation_secrets WHERE installation_id = <id>;

-- Should still show the historical events for forensic review.
SELECT COUNT(*) FROM audit_log WHERE installation_id = <id>;
```

**Follow-up**:

- File a customer-comms ticket if the rogue installation belongs to a
  paying customer. Reference the audit-log rows in the ticket.
- Add the installation's GitHub account to the App's banned-installer
  list (manual; GitHub does not have an API for this).

### §8.6.5 — Database compromise (audit log integrity check)

Trigger: pgaudit / CloudTrail flags an unexpected DDL statement; a
backup restore reveals row drift. Goal: confirm or rule out tampering.

```bash
# 1. Verify the audit-log HMAC chain. Breaks indicate tampering.
review-agent recover audit-verify
#   → emits "OK: 1234 rows verified" or "BREAK at row N (prev_hash mismatch)"

# 2. Identify scope from CloudTrail.
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=review-agent-db \
  --start-time "$(date -u -v-7d +%FT%TZ)" \
  --max-results 100

# 3. Rotate every secret stored in Postgres.
psql "$DATABASE_URL" -c "TRUNCATE installation_tokens;"
review-agent recover rotate-byok --all                      # rotates every BYOK secret

# 4. If integrity is compromised, restore from a KMS-encrypted snapshot
#    older than the suspected breach window.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier review-agent-db \
  --target-db-instance-identifier review-agent-db-restored \
  --restore-time "$(date -u -v-1d +%FT%TZ)"
```

**Verify**: re-run the audit-chain verification on the restored DB.
Expect "OK" with the row count matching the snapshot's metadata.

**Follow-up**:

- Notify all affected installations within 72 hours per most data
  protection regulations.
- Open a Security Advisory describing the indicators of compromise.
- Run §8.6.4 against any installation that touched the compromised
  data window.

### §8.6.6 — Disaster recovery for state (Postgres lost, GitHub intact)

Trigger: Postgres data loss with valid GitHub state-comments still in
the PRs. Goal: rebuild `review_state` so the next webhook does an
incremental review, not a full re-run from scratch.

```bash
# Single-repo recovery:
review-agent recover sync-state \
  --repo owner/name \
  --installation 123

# What it does:
#   1. Lists every open PR in the repo via the GitHub App's installation
#      token.
#   2. For each PR, fetches the hidden state comment (the
#      `<!-- review-agent-state: ... -->` marker).
#   3. Parses + validates the JSON payload.
#   4. Upserts the matching `review_state` row.
#
# Idempotent: rerun safely. The hidden comment is canonical (§12.1.1);
# any drift from the live DB is reconciled to the comment value.
```

**Verify**:

```sql
-- After recover sync-state, every open PR with a posted review should
-- have a matching review_state row.
SELECT COUNT(*) AS recovered FROM review_state WHERE installation_id = 123;
```

**Follow-up**:

- For multi-repo installations, rerun the command per repo. Multi-repo
  iteration is a v0.4 follow-up.
- **CodeCommit installations cannot recover state.** They use
  Postgres-only state per §12.1.1 — the next webhook on every PR is a
  full re-review. Document this in the customer comms.

---

## On-call playbook

For SLOs, escalation paths, and the quarterly tabletop drill format,
see [`docs/security/oncall.md`](./docs/security/oncall.md).
