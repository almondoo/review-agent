# Multi-tenant per-installation authorization

**Status**: interim guard accepted (landed 2026-06-04); full per-principal authz
pending multi-tenant GA. Issue [#132](https://github.com/almondoo/review-agent/issues/132).

## Context

The current deployment model is **operator-single-tenant**: one organization runs
its own review-agent instance and is trusted for all GitHub App installations it
manages. Authentication is a single shared static bearer token
(`REVIEW_AGENT_DASHBOARD_TOKEN`), validated by `bearerTokenAuth` in
`packages/server/src/api/middleware/auth.ts`. After that check passes, the Hono
context carries **zero caller identity** — there is no `users`, `memberships`, or
caller-to-installation binding table in the schema.

Relevant spec references:

- **§1.2** — no auth aggregation/login (the agent is read-only on source; no user
  sessions).
- **§8.2.4 open question (b)** — per-installation ownership validation deferred to
  multi-tenant GA.
- **§22 open question #17** — per-principal credential type not yet decided.
- **§16.1** — RLS (`withTenant` / `set_config app.current_tenant`) is
  defense-in-depth at the DB layer, not an authz control at the API layer. It
  bounds queries to the declared `installationId` but does not verify the caller
  _owns_ that installation.

## The accepted gap (precise)

Six `/api` endpoints accept an `installationId` from **untrusted request input**
and then either mint a GitHub installation token or perform a DB write bounded to
that ID. In the single-tenant model the sole operator owns all installations, so
cross-installation access is not a threat. In a multi-tenant deployment this would
be a classic **IDOR** (Insecure Direct Object Reference).

Guarded endpoints:

| Method | Path | Risk |
|--------|------|------|
| `GET` | `/api/github/installations/:installationId/repos` | mints GitHub installation token |
| `POST` | `/api/repos/bulk` | DB write via `withTenant` |
| `GET` | `/api/integrations/llm-keys` | DB read via `withTenant` |
| `POST` | `/api/integrations/llm-keys` | DB write via `withTenant` |
| `POST` | `/api/integrations/llm-keys/rotate` | DB write via `withTenant` |
| `DELETE` | `/api/integrations/llm-keys` | DB write via `withTenant` |

**Excluded routes** (protected by independent mechanisms, not in scope):

- `GET /github/setup` and `GET /github/install-redirect`
  (`packages/server/src/github-setup.ts`): mounted _outside_ the `/api`
  bearer-token guard; `installationId` arrives from GitHub's OAuth redirect and is
  bound to a CSRF state cookie — not arbitrary caller input.
- `/webhook` and `/webhook/codecommit`: `installationId` is extracted from an
  HMAC-verified payload (GitHub webhook signature / SNS signature). The HMAC
  verification happens _before_ any tenant-scoped operation.

## Interim decision: `REVIEW_AGENT_MULTI_TENANT` flag (this change)

A **fail-closed boolean flag** `REVIEW_AGENT_MULTI_TENANT` (env var, default
`false`) is parsed at API-creation time in `packages/server/src/api/index.ts`.
Only the exact string `'true'` (case-insensitive, trimmed) sets it; anything else
including unset resolves to `false`.

The flag is threaded through `ApiDeps.multiTenant` into `createGithubReposRouter`
and `createLlmKeysRouter`, where a `multiTenantGuard` Hono middleware is mounted
as the **first middleware** on `app.use('*', ...)` in each router. This guarantees
the check runs before validation, token minting, or DB writes.

Behavior matrix:

| `REVIEW_AGENT_MULTI_TENANT` | Effect |
|-----------------------------|--------|
| `false` (default) | No-op. All six routes behave exactly as today. Single-operator deployment unchanged. |
| `true` | All six routes return **HTTP 501** with `{ "error": "per_installation_authz_not_implemented: ..." }` before any side effect. |

### Why 501 and not 403 or 404

503 is misconfiguration; 401/403 imply "you are not authorized to _this_ resource
on _this_ request" — which is the semantics of the final GA check. 501 ("Not
Implemented") signals that the feature exists but the _authorization logic_ for it
is not yet implemented in this deployment mode. This preserves 403/404 for the real
per-caller denial when GA lands, and avoids misleading the frontend or a security
scanner into thinking an authorization decision was made.

### Why this is not the final fix

The flag+guard prevents accidental multi-tenant exposure but does not provide real
per-caller authorization. Flipping `REVIEW_AGENT_MULTI_TENANT=true` disables
affected routes entirely — it is a kill-switch, not an authz check. The GA design
below is the real fix.

### Alignment with §16.1 fail-closed philosophy

§16.1 states that RLS is defense-in-depth and that controls should be fail-closed.
The `REVIEW_AGENT_MULTI_TENANT=true` path is structurally fail-closed: the absence
of a per-principal authz implementation → 501, not a silent pass-through.

## GA design (do NOT implement now — tracked in issue #132)

The following maps to issue #132 acceptance criteria #1–#3.

### (a) Per-principal credential — OPEN DECISION (spec §22)

The single shared static `REVIEW_AGENT_DASHBOARD_TOKEN` must be replaced (or
augmented) with a per-principal credential for `/api`.

**Option 1 — Per-user JWT / session (OIDC-style)**

Each dashboard user authenticates via an OIDC provider (GitHub, Google, etc.) and
receives a short-lived JWT. The JWT `sub` claim becomes the principal ID.

- Pros: standard, stateless token verification, no long-lived secrets per user.
- Cons: requires an OIDC provider and callback flow; adds significant new surface
  area (token issuance, refresh, revocation).

**Option 2 — Per-principal API key**

Each principal is provisioned a unique API key (e.g. `ragt_<uuid>`). Keys are
stored hashed in a new `operator_principals` table.

- Pros: simple to implement; no external IdP dependency; fits the existing
  single-static-token mental model.
- Cons: long-lived secret; requires a key-management UI / rotation workflow.

Neither option is chosen here. The decision is deferred per spec §22.

### (b) Schema sketch

Two new tables (no migration in this change):

```sql
-- One row per principal allowed to access the dashboard API.
CREATE TABLE operator_principals (
  id          TEXT PRIMARY KEY,        -- e.g. UUID
  credential  TEXT NOT NULL,           -- hashed API key OR OIDC sub
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Maps a principal to the installations it may access and with what role.
CREATE TABLE installation_memberships (
  principal_id    TEXT NOT NULL REFERENCES operator_principals(id),
  installation_id BIGINT NOT NULL REFERENCES github_installations(installation_id),
  role            TEXT NOT NULL DEFAULT 'viewer', -- 'viewer' | 'admin'
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, installation_id)
);
```

RLS remains unchanged as defense-in-depth: `withTenant` continues to set
`app.current_tenant` to the declared `installationId`.

### (c) Authorization middleware

A new middleware (replaces the interim 501 guard) runs for the six endpoints before
`getInstallationToken` / `withTenant`:

1. **Extract caller identity** from the incoming credential (JWT or API key lookup).
2. **Resolve caller's installations**: `SELECT installation_id FROM installation_memberships WHERE principal_id = $caller`.
3. **Assert** `requestedInstallationId ∈ callerInstallations`.
4. If assertion fails → return **403** (or **404** to hide installation existence —
   decision deferred; the tradeoff is debuggability vs. enumeration resistance).
5. If assertion passes → call `next()`.

This check runs **before** any `getInstallationToken` call or `withTenant` DB
write, exactly mirroring the interim guard's position.

When GA lands, the `REVIEW_AGENT_MULTI_TENANT` flag and its 501 guard are removed
and replaced by this middleware.
