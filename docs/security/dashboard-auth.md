# Dashboard authentication & RBAC

The dashboard and its `/api` surface support **per-user authentication with
role-based access control (RBAC)**. This replaces — but stays
backward-compatible with — the single shared bearer token used by earlier
versions.

Related: [`multi-tenant-authz.md`](./multi-tenant-authz.md) (the per-installation
IDOR hardening this builds on), [`byok.md`](./byok.md),
[`audit-log.md`](./audit-log.md), [`sso.md`](./sso.md) (OIDC single sign-on).

---

## Auth modes

Selected with `REVIEW_AGENT_AUTH_MODE`:

| Mode | Behaviour | When |
|---|---|---|
| `legacy` (**default**) | Single shared bearer token (`REVIEW_AGENT_DASHBOARD_TOKEN`). No per-user identity. Identical to pre-#161 behaviour. | Existing single-operator deployments. Nothing changes on upgrade. |
| `session` | Per-user login only. The shared token is **rejected**. | Fully migrated, multi-user deployments. |
| `both` | Accepts either a per-user session JWT **or** the shared token. | Migration window — run both side by side while you create users and switch clients over. |

Because the default is `legacy`, **upgrading does not silently break existing
deployments**. Per-user auth is strictly opt-in.

---

## Roles

Three roles, stored per-(principal, installation) in `installation_memberships`:

| Role | Can do |
|---|---|
| `viewer` | Read-only: dashboard overview, repo list/detail/reviews/metrics, view prompts, list configured BYOK providers, list installation repos. |
| `editor` | viewer **+** edit repo system prompts / config (`PUT /api/repos/:id/prompt`). |
| `admin` | editor **+** add/enable/delete repos, bulk-add repos, manage BYOK LLM keys (create/rotate/delete). |

Roles are hierarchical (`admin ⊇ editor ⊇ viewer`). **User management itself is
CLI-only** in this release (see below); there is no dashboard endpoint that
creates principals, which keeps that surface off the network.

### Authorization model

- Authorization derives from the **server-verified** caller→installation
  binding (`installation_memberships`), never from a request-supplied ID. A
  request may *name* an `installationId`, but it is only used as a lookup key;
  access is granted solely by the caller's membership row.
- Caller has **no membership** for the requested installation → `404`
  (enumeration-resistant; you cannot tell whether the installation exists).
- Caller has a membership but **insufficient role** → `403`.
- A `viewer` in installation A **cannot** reach installation B's resources.
- Repos with a `NULL` installation_id (legacy / unassigned) are visible to any
  authenticated user (viewer) and mutable by callers whose highest role is
  `admin`/`editor` as appropriate.

---

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `REVIEW_AGENT_AUTH_MODE` | no | `legacy` | `legacy` \| `session` \| `both`. Invalid values fail startup. |
| `REVIEW_AGENT_SESSION_SECRET` | **yes when `session`/`both`** | — | HS256 signing key, **≥ 32 chars**. Startup **fails closed** if missing/short in a non-legacy mode. Keep it secret; rotating it invalidates all existing sessions. |
| `REVIEW_AGENT_SESSION_TTL_SECONDS` | no | `43200` (12h) | Absolute JWT lifetime. There is no refresh token; users re-login on expiry. |
| `REVIEW_AGENT_DASHBOARD_TOKEN` | for `legacy`/`both` | — | The shared bearer token. Ignored in `session` mode. |
| `REVIEW_AGENT_MULTI_TENANT` | no | `false` | Legacy interim IDOR interlock (#132). In `legacy` mode with no per-user principal, `true` still fail-closes the installation-scoped endpoints with `501`. Superseded by real authz once a principal is present. |

The CLI reads `DATABASE_URL` (or `REVIEW_AGENT_DATABASE_URL`) for user
management.

---

## Migration path (backward-compatible)

Existing deployments keep working with **no changes** (default `legacy`). To
adopt per-user auth:

1. **Apply DB migrations.** Migration `0011_dashboard_auth` adds
   `operator_principals`, `installation_memberships`, and `audit_log.actor`.
   Run your normal migration step (see your deployment doc under
   [`docs/deployment/`](../deployment/)).

2. **Set a session secret.**
   ```sh
   export REVIEW_AGENT_SESSION_SECRET="$(openssl rand -base64 48)"   # ≥ 32 chars
   # optional: export REVIEW_AGENT_SESSION_TTL_SECONDS=43200
   ```

3. **Create users (CLI).** Each user needs a principal and at least one
   installation membership:
   ```sh
   review-agent user create --username alice --role admin \
     --installation 12345678 --generate
   # prints a generated password once — store it now, it is not recoverable
   ```

4. **Enable hybrid mode** so existing shared-token clients keep working while
   users move over:
   ```sh
   export REVIEW_AGENT_AUTH_MODE=both
   ```
   Restart the server. The shared token and per-user logins now both work.

5. **Have users log in** at `/login`. Confirm the dashboard works and roles
   gate the UI as expected.

6. **Cut over.** Once everyone uses per-user login:
   ```sh
   export REVIEW_AGENT_AUTH_MODE=session
   ```
   Remove `REVIEW_AGENT_DASHBOARD_TOKEN` and the build-time
   `VITE_REVIEW_AGENT_DASHBOARD_TOKEN` from the web bundle. The shared token is
   now rejected everywhere.

To roll back at any step, set `REVIEW_AGENT_AUTH_MODE` back to `both` or
`legacy`.

---

## CLI user management

```
review-agent user create   --username <u> [--role viewer|editor|admin] [--installation <id>] [--password <p> | --generate]
review-agent user list
review-agent user set-password --username <u> [--password <p> | --generate]
review-agent user delete   --username <u>
review-agent user grant    --username <u> --installation <id> --role viewer|editor|admin
review-agent user revoke   --username <u> --installation <id>
```

- `user create` makes a principal and, if `--installation` + `--role` are given,
  a membership in one step.
- `user grant` / `user revoke` manage memberships afterward. The installation
  must already exist in `github_installations` (FK enforced).
- `user set-password` bumps the principal's `token_version`, which
  **immediately invalidates all of that user's existing sessions**.
- Plain-text passwords are never stored or logged. `--generate` prints the
  generated password to stdout exactly once.

---

## API endpoints

| Endpoint | Auth | Response |
|---|---|---|
| `POST /api/auth/login` | none (unauthenticated) | `{ token, expiresIn }`. `401` on bad credentials. `404` in `legacy` mode. |
| `GET /api/auth/me` | session | session: `{ authenticated:true, legacy:false, principal:{ id, username }, memberships:[{ installationId, role }] }`; shared-token: `{ authenticated:true, legacy:true }`. `401` if unauthenticated. |
| `POST /api/auth/logout` | session | `204`. Sessions are stateless JWTs, so logout is client-side token disposal. For server-side revocation, use `user set-password` (bumps `token_version`). |

The web client stores the session token in `localStorage` and sends it as
`Authorization: Bearer <token>`. On any `401` it clears the token and redirects
to `/login`.

---

## Audit

Admin-tier actions (BYOK key create/rotate/delete, repo add/remove, etc.) are
recorded in `audit_log` with `actor` set to the authenticated principal's id. In
`legacy`/shared-token paths `actor` is null. The audit HMAC chain is
backward-compatible: rows written before this change (and any null-actor rows)
canonicalize identically to before, so existing chains continue to verify.

---

## Security notes & known limitations

- **Token storage.** The session JWT lives in `localStorage`, so it is readable
  by any script running on the dashboard origin. Mitigate with a strict CSP, a
  reverse proxy, and the short default TTL. Treat the dashboard origin as
  trusted.
- **Login rate-limiting is not built in.** Put the dashboard behind a WAF /
  reverse proxy with rate limiting, or a network ACL, to slow credential
  stuffing. (Tracked as a follow-up.)
- **Password hashing** uses `scrypt` (`node:crypto`) with a self-describing
  stored format, so cost parameters can be raised later without breaking
  existing hashes.
- **Session secret rotation** invalidates every active session (all JWTs fail
  verification). Plan a re-login window when rotating.
- **Repo list isolation for `NULL`-installation repos.** Legacy repos with no
  installation association are visible to all authenticated users; assign them
  to an installation (via the GitHub App onboarding / `repos/bulk`) to bring
  them under per-installation isolation.
