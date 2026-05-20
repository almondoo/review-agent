---
'@review-agent/server': minor
'@review-agent/runner': minor
---

#95 — CodeCommit `/feedback` comment command + GitHub fallback path.

Adds an explicit `/feedback accept|reject|dismiss` comment command as the
CodeCommit substitute for GitHub's reaction-based feedback signals (CodeCommit
has no reaction API). The command is also recognised on GitHub as a fallback
for users who prefer typed commands.

Provisional implementation that ships only the `<fp_prefix>` resolution path
because #96 (HTML-marker embedding in posted PR comments) is not yet landed.
The marker-extraction helper (`extractFingerprintMarker`) is implemented and
unit-tested today so the day #96 lands its `composeStateComment` change,
fingerprint resolution starts flowing through the marker path with zero
further changes here.

- `packages/server/src/utils/parse-command.ts` — new `parseFeedbackCommand`.
- `packages/server/src/utils/feedback-authz.ts` — GitHub `getCollaboratorPermissionLevel` guard + CodeCommit `REVIEW_AGENT_FEEDBACK_ALLOWLIST` env (fail-closed).
- `packages/runner/src/feedback-fingerprint-resolver.ts` — marker / prefix / no-marker-and-no-prefix routing.
- `packages/server/src/metrics.ts` — `review_agent_feedback_command_total{platform, kind, outcome}` counter, outcome ∈ `{recorded, unauthorized, unresolved, rate_limited}`.
- `packages/server/src/handlers/webhook.ts` + `codecommit-webhook.ts` — recognise `/feedback`, apply authz, surface `WebhookResult.kind: 'feedback_command'` for the worker to act on.
- `docs/architecture/feedback-loop.md` — "CodeCommit path" + "Command syntax" + "Permission guard" sections.
- `docs/security/feedback-command-authz.md` — DoS / poisoning threat model + decisions.

Denied commands are silently ignored (no public reply) per the spec's
"explicit signals only" framing — surfacing rejection comments would create a
comment-forwarder DoS vector. All four outcomes (`recorded` / `unauthorized` /
`unresolved` / `rate_limited`) are exposed via the OTel counter for operator
monitoring.
