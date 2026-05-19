# `/feedback` permission guard

Spec references: §7.6 (learned facts), v1.2 [#95](https://github.com/almondoo/review-agent/issues/95).

## Threat model

`/feedback accept|reject|dismiss` writes an entry into the
`review_history` table. Subsequent reviews load the most recent N
rows into the LLM system prompt as `<learned_facts>` (spec §7.6),
and `rejected_finding` rows feed the dedup middleware's
`rejectedFingerprints` set so the agent **suppresses** any future
comment with a matching fingerprint.

An attacker who can post comments on a PR but cannot push to the
repository therefore has a low-cost path to:

1. **Suppress a real finding.** Post `/feedback reject <fp_prefix>`
   on a security-critical comment; from then on the agent silently
   drops every re-occurrence of that finding.
2. **Inject misleading `<learned_facts>`** by accumulating
   `thumbs_up` rows on attacker-crafted fingerprints, slowly
   biasing future prompts toward the attacker's preferred
   patterns.

Both require **only PR-comment permission**, which is broadly
available on public repos. The guard exists to neutralise that
asymmetry.

## Decision: gate `/feedback` on write-equivalent permission

| Platform | Check |
|---|---|
| **GitHub** | `octokit.rest.repos.getCollaboratorPermissionLevel({owner, repo, username})` → `permission ∈ {'admin', 'maintain', 'write'}`. `read` and `triage` are denied. |
| **CodeCommit** | CSV allowlist in `REVIEW_AGENT_FEEDBACK_ALLOWLIST` env, matched against the SNS event's `userIdentity.principalId`. |

`'admin'`, `'maintain'`, `'write'` are GitHub's three "push-equivalent"
permission tiers — they correspond to `repos.pushedToBranch`
permission, which is what we actually want (i.e. *the user could fix
the underlying code themselves*). Bot accounts and read-only
collaborators are denied.

For CodeCommit, AWS does not expose a comparable REST call. The
"right" mechanism would be IAM `simulate-principal-policy` against
`codecommit:GitPush` on the repo ARN; that introduces a STS trust /
cross-account complexity hurdle we are deliberately deferring to a
future iteration. The CSV allowlist is the simple substitute:

- The env is **explicit opt-in** by the operator.
- It is **fail-closed** — an unset / empty allowlist denies every
  `/feedback`.
- It mirrors the existing `REVIEW_AGENT_SNS_TOPIC_ARNS`
  fail-closed pattern (see `docs/deployment/aws.md`).

Operators rotating principals (CI roles, named developers) update
the env via their normal config-management surface; there is no
runtime registration API.

## Decision: silently ignore denied commands

A naïve implementation would post a public reply like
`@alice your /feedback was ignored: read-only permission`. That
reply itself is a write back into the PR thread, and an attacker can
trivially force the bot to comment by spamming
`/feedback` lines under any throwaway account. This is the classic
**comment-forwarder DoS** pattern.

The agent therefore:

1. **Logs** the denial via structured log + the
   `review_agent_feedback_command_total{outcome: 'unauthorized'}`
   counter.
2. **Does not** reply on the PR. The denied user receives no
   feedback that their command was even recognised.
3. Returns HTTP **200** to GitHub / SNS so neither retries the
   webhook.

This matches the [spec §7.6.1 footnote](../specs/review-agent-spec.md#761-writer-v12-92-and-reader-v12-93--implemented)
"explicit signals only" and the issue body's locked design decision
("silently ignore + structured warn log").

## Decision: fail-closed when no checker is wired

The GitHub path requires the operator to inject
`checkGithubFeedbackAuthz` into `createApp` (or the equivalent
Lambda worker entrypoint). When that injection is missing — for
example in a stripped-down test deployment — **every `/feedback`
defaults to `outcome: 'unauthorized'`**. This is fail-closed: the
absence of a permission check is treated as the strictest possible
permission check.

The same principle applies to the CodeCommit env allowlist.

## Decision: do not gate on the `outcome: 'rate_limited'` counter

The writer's per-job cap (default 10 / job) exists primarily to
contain *legitimate* bursts of feedback during a noisy PR — not as
an attack mitigation. Rate-limit hits are surfaced via the metric
counter so operators can detect attacks-in-progress, but the
counter alone is **not** the defence; the authz check is.

## Decision matrix — observed outcomes

| Outcome | Authz check passed? | Worker wrote? | Effect |
|---|---|---|---|
| `recorded` | yes | yes (or pending) | Row inserted in `review_history`. Re-read next review. |
| `unauthorized` | no | n/a | Silently dropped. Counter incremented for operator monitoring. |
| `unresolved` | (passed but) | no | Fingerprint resolver returned `no_match` / `ambiguous_prefix` / `no_marker_and_no_prefix`. No row. |
| `rate_limited` | yes | dropped by writer cap | No row. Operator should investigate if this fires often on a healthy PR (cap default is 10 / job). |

## Non-decisions / future work

- **IAM `simulate-principal-policy`** for CodeCommit (replaces CSV
  allowlist with an authoritative IAM check). Tracked alongside any
  future STS-trust expansion.
- **Per-installation override** of the CSV allowlist via the DB
  (so multi-tenant deployments don't share a single env). Deferred
  until the BYOK config surface (#26) is exercised by a real
  tenant.
- **GraphQL-based comment thread reads** to confirm the parent
  comment is one of our bot comments. Currently the resolver relies
  on `review_state.commentFingerprints` as the source of truth;
  GraphQL would let us also check the resolved-vs-open state, but
  REST cannot.
