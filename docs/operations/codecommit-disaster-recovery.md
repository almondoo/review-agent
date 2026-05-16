# CodeCommit disaster recovery — Postgres-canonical state

CodeCommit installations of `review-agent` cannot recover review state
from the platform itself. Unlike GitHub — where the hidden
`<!-- review-agent-state: ... -->` marker on the summary comment is the
canonical store — CodeCommit's HTML escaping mangles those markers, so
the adapter writes state to Postgres **only** (spec §5.2.1, §12.1.1;
`packages/platform-codecommit/src/adapter.ts:229-234`).

That means: **if Postgres is lost, the platform side has no canonical
copy.** This runbook is the operator-facing procedure to (a) plan for
that loss with sufficient backups, and (b) recover the agent into a
working state after a disaster.

If you operate GitHub installations only, see §8.6.6 in
[`/SECURITY.md`](../../SECURITY.md) — `review-agent recover sync-state`
covers GitHub's recovery path automatically.

---

## 1. Recovery objectives (RPO / RTO targets)

Pick a tier per installation; document in your operations handbook
alongside the rest of your DB DR plan.

| Tier | Workload                              | RPO  | RTO  | Backup strategy                                                                                                                                                                               |
|------|---------------------------------------|------|------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| A    | Multi-tenant, paying customers        | ≤ 5 min | ≤ 1 h | RDS / Aurora point-in-time recovery (PITR) with 35-day retention; cross-region read replica.                                                                                                  |
| B    | Single-tenant, internal team          | ≤ 1 h | ≤ 4 h | Daily automated snapshot + 7-day PITR retention.                                                                                                                                              |
| C    | Demo / non-prod                       | ≤ 24 h | ≤ 24 h | Daily logical dump (`pg_dump`) to versioned object storage.                                                                                                                                  |

**These numbers are not policy commitments from this project** — they
are the planning baseline. Tier-A users typically need to commit to
tighter numbers in their own SLAs.

The three tables that matter for recovery are:

| Table          | Why it matters on CodeCommit                                                                                                                                                                                                                                                                                                                                                       |
|----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `review_state` | Sole source of truth for incremental-review memory (spec §12.1.1). Loss → every open PR's next review is full-cost, and previously-posted comments will be re-emitted unless dedup catches them by fingerprint (it usually will, but the re-review is paid for in full).                                                                                                          |
| `audit_log`    | HMAC-chained, immutable evidence trail (spec §17, `packages/db/src/audit-log.ts`). Loss breaks the chain — the verifier (`review-agent recover audit-verify`) will report "BREAK at row N" until the chain restarts from a fresh genesis row.                                                                                                                                       |
| `cost_ledger`  | Per-LLM-call spend by installation (spec §13.4). Loss removes the basis for cost-cap enforcement reconciliation and operator billing dashboards.                                                                                                                                                                                                                                   |

Back up all three. Cost-ledger snapshots are particularly valuable for
recovery because they let you reconstruct the model / token / dollar
attribution for the affected window without re-running the LLM.

---

## 2. `recover sync-state` does NOT apply to CodeCommit

On GitHub:

```bash
review-agent recover sync-state --repo owner/name --installation 123
```

walks every open PR, reads the hidden state comment, and rehydrates the
`review_state` row from the canonical comment payload.

On CodeCommit this command **does not exist** and there is no equivalent.
Why:

1. CodeCommit's `PostCommentForPullRequest` HTML-escapes the comment
   body. The `<!-- ... -->` wrapper that GitHub renders as an HTML
   comment is escaped to literal `&lt;!-- ... --&gt;` text on
   CodeCommit, so the marker does not survive the round-trip.
2. The adapter therefore writes a **plain-Markdown** summary comment
   without the marker (spec §12.1.1, `adapter.ts` `postSummary`). There
   is no canonical state to reconstruct from.
3. `getStateComment()` returns `null` and `upsertStateComment()` is a
   no-op (`adapter.ts:229-234`). The runner detects this and routes
   read/write to Postgres via `createReviewStateMirror` in
   `@review-agent/db`.

Practical consequence: **after a Postgres loss on a CodeCommit
installation, you have lost the platform-side incremental-review
memory.** Plan accordingly (Tier-A users: take this seriously when
choosing PITR retention).

---

## 3. Recovery procedure

### Step 0 — Triage (before touching anything)

1. Confirm the loss is real: connect with the migrations role and
   `SELECT COUNT(*) FROM review_state;`. A clean `0` against an
   installation you know has open reviews is the signal.
2. Identify the affected installations. If multi-tenant, scope
   subsequent work to one installation at a time.
3. Decide whether to restore from backup (preferred when RPO is
   acceptable) or to accept a full re-review (faster, costs the next
   PR's full LLM spend).

### Step 1 — Restore Postgres from the most recent backup

The exact commands depend on your DB hosting. Examples:

```bash
# AWS RDS — point-in-time restore to a new instance.
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier review-agent-db \
  --target-db-instance-identifier review-agent-db-restored \
  --restore-time "$(date -u -v-1h +%FT%TZ)"

# Aurora — PITR likewise:
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier review-agent-aurora \
  --db-cluster-identifier review-agent-aurora-restored \
  --restore-to-time "$(date -u -v-1h +%FT%TZ)"

# Self-host (docker / k8s) — restore from logical dump.
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pg_restore --no-owner --dbname "$DATABASE_URL" /backups/review-agent.YYYY-MM-DD.dump
```

After the restore completes, point the worker at the restored DB:

```bash
# Lambda: bump the env-var to force a cold start that re-reads the
# DATABASE_URL secret.
aws lambda update-function-configuration \
  --function-name review-agent-worker \
  --environment "Variables={ROTATED_AT=$(date +%s)}"
```

### Step 2 — Verify the audit-log chain

Run the HMAC chain verifier against the restored DB:

```bash
review-agent recover audit-verify
#  → "OK: 1234 rows verified" if the chain is intact.
#  → "BREAK at row N (prev_hash mismatch)" if a partial restore landed.
```

If the chain breaks, you have three options:

1. **Restore from an older backup that pre-dates the break.** Loses the
   most recent events but keeps the chain intact.
2. **Reset the chain.** Mark the break point in your operations log,
   then truncate `audit_log` and let the next run write a new genesis
   row. SOC2 evidence for the lost window becomes whatever you can
   reconstruct from CloudTrail + LLM-provider dashboards.
3. **Continue with a known break.** Acceptable only for non-prod /
   Tier-C.

### Step 3 — Re-import historical audit-log snapshots (optional)

If you keep periodic `audit_log` snapshots (e.g. a daily dump to
object storage), you can re-import them to fill gaps left by the
restore. The snapshots **must** include `prev_hash` and `row_hash`
columns so the chain replays bit-for-bit.

```bash
# Example: snapshots stored as compressed COPY-format text in S3.
aws s3 cp s3://your-bucket/audit-log/2026-05-10.copy.gz - \
  | gunzip - \
  | psql "$DATABASE_URL" -c "COPY audit_log FROM STDIN"

# Re-verify.
review-agent recover audit-verify
```

If the snapshot is from before the most recent restore point, expect
the verifier to report a duplicate-row error rather than a chain
break — `(row_hash)` is the primary key on `audit_log`. Resolve by
deduplicating against the live table before COPY.

### Step 4 — Manual re-review of open PRs

Even with a perfect restore, the gap between the restore point and
"now" is unreviewed. Walk every open CodeCommit PR in the affected
installation:

```bash
# List open PRs (uses the IAM role on the worker host).
aws codecommit list-pull-requests \
  --repository-names <repo> \
  --pull-request-status OPEN

# For each open PR, re-trigger a full review by clearing the
# Postgres state row (forces "no prior review" -> full diff path).
psql "$DATABASE_URL" <<SQL
DELETE FROM review_state
 WHERE repository_arn = 'arn:aws:codecommit:<region>:<account>:<repo>'
   AND pr_id = '<pr-id>';
SQL

# Then post the @review-agent review command on the PR, or call the
# CLI directly (issue #75 — the --platform codecommit flag):
review-agent review --pr <pr-id> --platform codecommit --repo <repo>
```

Each re-review costs the full LLM spend for that PR. There is no
incremental shortcut — that's the price of the Postgres-canonical
posture. Document the cost overhead in your post-incident report so
the operator can decide whether tighter RPO is worth the backup
infrastructure cost next time.

**Caveat on fingerprint dedup**: the runner's dedup middleware
(`packages/runner/src/middleware/dedup.ts`) suppresses comments whose
fingerprint matches one already posted on the PR. After a state-loss
re-review, the dedup pass will hit *existing* CodeCommit comments
(`vcs.getExistingComments`) and skip re-posting findings that were
already there. The cost spend is still incurred for the LLM call — the
saving is only on visible duplicate comments.

### Step 5 — Resume normal operation

Restart the worker pool, monitor the cost-ledger for the expected
spike from the manual re-reviews, and close out the incident.

```bash
# Sanity check: review_state rows should now reflect the manual
# re-reviews.
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) AS reviewed
    FROM review_state
   WHERE installation_id = <id>;
"
```

---

## 4. Operational checklist

Pre-incident (do this before you need it):

- [ ] Postgres backups configured with RPO ≤ your tier's target.
- [ ] PITR retention long enough to cover the alert→restore lag of
      your on-call rotation.
- [ ] Cross-region replica or off-site snapshot copy if your
      regulatory regime requires geographic separation.
- [ ] `review-agent recover audit-verify` runs as a periodic cron
      against the live DB so chain breaks are detected within 24 h.
- [ ] This runbook is on the on-call shared drive (not only in the
      repo), so the on-call engineer can read it without a working
      worker.

Post-incident:

- [ ] Document RPO actually achieved vs. target.
- [ ] Record total spend on the manual re-review pass against the
      affected installation(s).
- [ ] If chain was broken, note the break window in the operations
      log.
- [ ] If SOC2 / ISO evidence retention is in scope, file the
      restore + verify artifacts (CloudTrail entries, `audit-verify`
      output, the snapshot identifier) with your evidence custodian.

---

## 5. See also

- [`/SECURITY.md`](../../SECURITY.md) §8.6.6 — `recover sync-state`
  procedure for GitHub (does **not** apply to CodeCommit).
- [`docs/deployment/aws.md`](../deployment/aws.md) — CodeCommit
  deployment notes; links here for the DR story.
- [`docs/operations/retention.md`](./retention.md) — retention
  policy + export CLI (`audit_log` / `cost_ledger`).
- Spec §5.2.1 — CodeCommit out-of-scope items (cloneRepo,
  getStateComment / upsertStateComment).
- Spec §12.1.1 — Postgres-canonical state contract for CodeCommit.
- Spec §22.1 — consolidated CodeCommit posture.
- [`packages/platform-codecommit/README.md`](../../packages/platform-codecommit/README.md) §
  "Disaster recovery" — adapter-side summary.
