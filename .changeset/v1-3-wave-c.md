---
'@review-agent/core': minor
'@review-agent/platform-github': minor
'@review-agent/server': minor
'@review-agent/web': minor
'@review-agent/db': minor
---

v1.3 wave C — GitHub App dashboard onboarding (9 issues, shipped on `develop`).

For the canonical state of this wave see [`docs/roadmap.md`](../docs/roadmap.md). Issue links and operator-runtime backlog live there; this file is intentionally a short release note.

**GitHub App onboarding (#122 epic)**:

- #123 — `github_installations` table + `repos.installation_id` FK + three Drizzle migrations (0006 create table, 0007 add column, 0008 RLS count policy). RLS-isolated per tenant; `installation_id` is nullable for backward-compatible manually-registered repos.
- #124 — `listInstallationRepos` (paginated GitHub REST) + App-level JWT mint (`createAppAuthClient`) exported from `@review-agent/platform-github`.
- #125 — `GET /github/install-redirect` + `GET /github/setup` OAuth callback (CSRF state-cookie verification, App JWT installation lookup, redirect to dashboard or pending-approval page). Mounted outside bearer-token guard (spec §8.2.2). Adds `@review-agent/platform-github` workspace dep to server.
- #126 — Webhook handler extended to persist `installation.created / deleted / suspend / unsuspend` events into `github_installations` via `withTenant` transaction. DB dep is optional; existing tests without DB continue to pass.
- #127 — `GET /api/github/installations/:installationId/repos` (list accessible repos, annotated with `registered` flag) + `POST /api/github/repos/bulk` (multi-repo registration, 200/207 with per-repo breakdown). `AppAuthClient` wired as optional dep into `createApi`.
- #128 — `GET /api/integrations` now reads real `github_installations` count from DB and surfaces `GITHUB_APP_SLUG` as `appSlug` in the response.
- #129 — Web API hooks (`useInstallationRepos`, `useBulkCreateRepos`), extended `types.ts` (`InstallationRepo`, `BulkCreateRepoBody`, etc.), mocks, and i18n keys for the onboarding pages (en + ja).
- #130 — Integrations page: "Connect GitHub" button linking to `/github/install-redirect`; contextual error banners for `setup-cancelled / pending-admin-approval / unexpected-error` query-param states. `GithubSetupPage` (`/integrations/github`) for pending-approval confirmation.
- #131 — `GithubReposPage` (`/integrations/github/repos`): filterable checkbox list, bulk-register call with 200/207 toast feedback. `LayoutFullWidth` shell component. Route registration in `app.tsx`.

**Migration notes** (full procedure: operator runbook):

- Three new migrations: `0006_github_installations.sql`, `0007_repos_installation_id.sql`, `0008_github_installations_count_policy.sql`. Forward-compatible — v1.2 code continues to run after the migration is applied (new column is nullable; existing repos keep `installation_id = NULL`).
- New optional `createApp` deps (`githubAppSlug`, `dashboardOrigin`, `github.appAuthClient`) — all back-compat defaults; v1.2 callers compile unchanged.
- New env vars: `GITHUB_APP_SLUG`, `REVIEW_AGENT_DASHBOARD_ORIGIN`.

**Active follow-on issues** (post-v1.3 wave C, see `docs/roadmap.md` for the full table):

- Operator runtime (real GitHub App + DB required): #132 (end-to-end install smoke test), #133 (webhook delivery audit).
