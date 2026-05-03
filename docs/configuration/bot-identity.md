# Bot identity per distribution mode

`review-agent` posts review comments under whichever GitHub actor the
auth method exposes. The actor is **not** a config knob — GitHub
determines it from the credentials your distribution mode uses, and
the value matters for audit-trail readability and downstream tooling
that filters by author.

This page documents the mapping operators should expect, the
recommended setup per mode, and the audit-trail trade-offs.

Spec reference: §22 #5 (the deferred design question is resolved here
for v1.0). The fingerprint dedup in
`packages/runner/src/middleware/dedup.ts` is identity-agnostic — the
hidden state comment + per-finding fingerprint suppress repeats
regardless of actor — so identity is *purely* an audit / readability
concern, not a correctness one.

---

## Mapping table

| Distribution mode | Default actor | Override path | Audit-trail story |
|---|---|---|---|
| GitHub Action (`uses: almondoo/review-agent@vX`) | `github-actions[bot]` | None — use the App or CLI mode if you need a distinct identity. | One actor across every Action; mixed with other workflows in `gh api repos/.../actions/runs`. |
| Server mode (GitHub App) | `<your-app-name>[bot]` | Rename the App in **Settings → Developer settings → GitHub Apps → \<app\>**; the actor changes on the next install. | One actor per installation, distinct from `github-actions[bot]`. **Recommended for multi-repo / multi-tenant audit trails.** |
| CLI mode (`review-agent review --post`) | The PAT owner's user account (e.g. `alice`) | Use a separate human or service account if you don't want comments attributed to a real person. | Mixed with the operator's own commits; not auditor-friendly. |

### Action mode

```yaml
# .github/workflows/review.yml
- uses: almondoo/review-agent@v0
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}   # actor: github-actions[bot]
```

The `secrets.GITHUB_TOKEN` is provisioned by GitHub Actions and is
always issued to the `github-actions[bot]` actor. There is **no
override** within Action mode itself — substituting a PAT or App
token via `with: github-token:` would change the actor, but at the
cost of widening the secret surface and breaking the scope of the
default workflow token (`pull-requests: write` only).

If you need a dedicated `<review-agent>[bot]` actor in an Action
context, install the GitHub App version (Server mode) and disable
the Action workflow.

### Server mode (GitHub App)

```ts
// packages/server bootstraps the Hono receiver with a GitHub App
// installation token. The actor is the App's own user account.
import { createGithubVCS } from '@review-agent/platform-github';
const vcs = createGithubVCS({
  appAuth: { appId, privateKey, installationId },
});
```

Name the App something audit-friendly — e.g. `acme-review` →
posts as `acme-review[bot]`. Operators can search PR timelines for
that login to find every review-agent comment across the org.

### CLI mode

```bash
GITHUB_TOKEN=ghp_... review-agent review \
  --repo acme/api --pr 42 --post
```

Comments are attributed to the PAT owner's account. This is
intentional for the CLI's primary use case (interactive operator
review), but it means audit logs cannot distinguish "human reviewed"
from "agent reviewed via CLI". For audit-trail uniformity at scale,
use Server mode instead.

---

## Audit-trail recommendation

For multi-repo / multi-tenant deployments, **Server mode (GitHub
App) is the recommended primary distribution mode** because:

1. The App actor is distinct (one login per installation) and never
   collides with workflow runs by other actions.
2. Filtering audit logs by App actor isolates `review-agent` activity
   without false positives from other Actions.
3. Renaming the App propagates the new actor automatically without
   re-permissioning.

Action mode is acceptable for **single-repo trial use** or for orgs
that don't run a Server deployment yet — the `github-actions[bot]`
attribution is enough to find comments via
`gh pr view <PR> --json comments` and grep, but is harder to
correlate at org scale.

CLI mode is **not recommended** for any audit-significant flow —
use it only for one-off reviews where attribution to a human user
is the *intended* behaviour.

---

## Why no `identity:` config knob?

Two reasons we did not add a `coordination.identity:` (or similar)
key to `.review-agent.yml`:

1. **GitHub already determines actor per auth method.** A config
   knob would create a second source of truth that could drift
   from what the GitHub API returns. Operators inspecting the PR
   timeline would see the actual actor, not the configured one.
2. **The dedup story doesn't need it.** Per-finding fingerprints
   (`fingerprint(path, line, ruleId, suggestionType)`) suppress
   duplicate comments regardless of actor. Coordination *across*
   bots is handled by `coordination.other_bots` — see
   [`./coordination.md`](./coordination.md).

If your audit pipeline genuinely needs a synthetic identity, the
right place to insert one is at the secret-store layer (issue an App
token bound to a renamed App), not at the agent layer.

---

## Cross-references

- [`./coordination.md`](./coordination.md) — multi-bot coordination
  policy (`coordination.other_bots`).
- [`../security/audit-log.md`](../security/audit-log.md) — server-side
  audit log (HMAC chain, recovery), where the actor is recorded for
  every event.
- [SECURITY.md](../../SECURITY.md) — overall threat model.
- [`packages/action/README.md`](../../packages/action/README.md) — Action mode entry point.
- [`packages/server/README.md`](../../packages/server/README.md) — Server mode (Hono webhook) entry point.
- [`packages/cli/`](../../packages/cli/) — CLI mode entry point (no README; see `--help`).
