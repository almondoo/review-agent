# GitHub Enterprise Server (GHES) compatibility

`review-agent` is built and tested against **github.com**. GHES
compatibility is **best-effort, no commitment**: it may work today
on a recent GHES release, but no part of the test suite or release
process exercises a GHES instance.

Spec reference: §22 #11 (the deferred design question is resolved
here for v1.0).

---

## Stance: best-effort, no commitment

| Item | Decision |
|---|---|
| Will issues / PRs against `review-agent` for GHES be reviewed? | Issues are accepted and triaged. PRs are not accepted (this repo does not take external contributions — see [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)). |
| Is GHES tested in CI? | No. CI runs against `github.com` only. |
| Is there a minimum supported GHES version? | None declared. Recent GHES releases (3.13+) are likely closer to the github.com Octokit API surface; older releases drift further. |
| Will compatibility regress between releases? | Possibly. Octokit version bumps in `packages/platform-github` may surface methods that GHES has not yet implemented. We do not track this proactively. |
| Does this rule out GHES? | No. The codebase has no `github.com`-only assumptions baked into the runner; the platform adapter is the only GHES-relevant boundary. |

This is a deliberate scope choice for v1.x. Adding a "supported"
declaration would require:

1. A GHES test instance in CI (recurring infra cost — not justified
   for a personal-OSS project).
2. A pinned minimum GHES version that the team commits to honour
   across `@octokit/rest` upgrades.
3. Expanded support burden for issues that turn out to be GHES
   compatibility bugs rather than `review-agent` defects.

If a GHES-focused fork emerges, that fork is the right place to
declare a supported version range and run the corresponding CI.

---

## Known compatibility points

These are the surfaces `review-agent` exercises that should work on
recent GHES releases (verified informally — no automated coverage):

- `pulls.get`, `pulls.listFiles`, `pulls.createReview`,
  `pulls.listReviewComments` — standard PR APIs available since
  GHES 3.0.
- `issues.createComment`, `issues.listComments`,
  `issues.updateComment`, `issues.deleteComment` — standard since
  GHES 3.0.
- `git.getBlob`, `git.getTree`, `git.getCommit` — standard since
  GHES 3.0.
- Webhook delivery format (HMAC-SHA-256 over the raw body, header
  `X-Hub-Signature-256`, `X-GitHub-Delivery` UUID) — same as
  github.com.

For Server-mode deployments, the GitHub App auth flow
(`@octokit/auth-app`) requires that the GHES instance has the App
installed. App-level features (installation tokens, JWT signing)
behave identically to github.com.

## Known incompatibilities

- **github.com-specific REST endpoints**: anything we use from the
  `@octokit/rest` client that lands on github.com between GHES
  releases will 404 on older GHES until they catch up. Examples
  historically: `pulls.requestReviewers` body shape changes,
  `issues.list` filtering parameters, audit-log endpoints.
- **GraphQL schema lag**: we use REST today, not GraphQL, so this
  is moot. If a future feature requires GraphQL it will likely
  break GHES until the schema lands.
- **Rate-limit headers**: GHES exposes the same header names but the
  ceiling depends on the instance's configuration. The retry
  middleware (`@octokit/plugin-throttling`) honours whatever the
  server reports, so rate-limit handling is correct by construction.
- **`installation` event for `installation_repositories`**: GHES
  versions that pre-date this event will silently no-op the
  installation lifecycle — operators will need to manage installs
  manually.

## Operational guidance for GHES users

1. **Use the CLI mode for ad-hoc reviews** if Action / App
   provisioning is constrained on your GHES instance. Point
   `--repo` at the GHES URL pattern (the CLI does not currently
   support a custom GHES base URL — see "What's not configurable"
   below).
2. **Set the Octokit base URL** via the `GITHUB_API_URL` env var
   that GitHub Actions / Octokit honours by convention. Most of the
   `@octokit/*` packages we use respect `GITHUB_API_URL`; the
   platform adapter does not currently expose this as a config
   knob, so deployments need to set it at the process level
   before the adapter is constructed.
3. **Pin the Octokit version**: `@octokit/rest` upgrades may break
   on older GHES. If you depend on a specific GHES release, pin the
   `review-agent` version too — newer `review-agent` releases may
   bump Octokit.
4. **Monitor for 404s**: a sudden spike in 4xx from the platform
   adapter usually means GHES has not yet shipped a new endpoint.
   File an internal issue with the failing endpoint name.

## What's not configurable today

The following are hardcoded to github.com behaviour and would need
explicit code changes to fully support GHES:

- The platform adapter does not accept a `baseUrl: string` config
  knob (`packages/platform-github/src/adapter.ts`). Octokit picks
  up `GITHUB_API_URL` from the environment, so process-level env
  vars work, but per-installation override does not.
- The CLI's `--repo owner/name` parser assumes github.com URL
  shapes. GHES URLs (`https://ghes.acme.com/owner/name`) are not
  parsed.
- GHES-specific webhook subtypes (e.g. enterprise audit log events)
  are not handled.

These are intentional v1.0 omissions. If GHES support becomes a
recurring request, a `--ghes-base-url` flag plus a per-installation
override are the smallest surface that would close the gap — file
an issue if you want them.

---

## Cross-references

- [`../specs/prd.md`](../specs/prd.md) §12 / Post-v1.0 — GHES listed
  as future work; the v1.0 stance is "best-effort, no commitment".
- [`../specs/review-agent-spec.md`](../specs/review-agent-spec.md) §22 #11 — original deferred design question.
- [`../../packages/platform-github/`](../../packages/platform-github/) — the only adapter that
  would need GHES-specific changes.
