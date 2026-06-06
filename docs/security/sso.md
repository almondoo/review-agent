# SSO (OIDC) for the dashboard

The dashboard supports **OpenID Connect (OIDC) single sign-on** as an
alternative to username/password login. SSO requires `AUTH_MODE=session` or
`AUTH_MODE=both` (see [`dashboard-auth.md`](./dashboard-auth.md)).

> SAML support is tracked as a future follow-up. Only OIDC is available today.

---

## How it works

1. The user clicks **Sign in with SSO** on the login page.
2. The browser performs a full-page navigation to `GET /api/auth/oidc/authorize`,
   which redirects to the configured IdP.
3. After the user authenticates at the IdP, the browser is redirected to
   `GET /api/auth/oidc/callback`.
4. On success the server issues a session JWT (same shape as password login)
   and performs a `302` redirect to `<dashboardOrigin>/#token=<urlencoded JWT>`.
5. The SPA reads `location.hash`, stores the token via `localStorage`, strips
   the hash from browser history (so the token is not visible in the URL after
   navigation), and calls `GET /api/auth/me` — identical to the password-login
   path from this point on.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `REVIEW_AGENT_OIDC_ISSUER` | **yes** | OIDC issuer URL. Must expose a `/.well-known/openid-configuration` discovery document. Example: `https://accounts.google.com` |
| `REVIEW_AGENT_OIDC_CLIENT_ID` | **yes** | OAuth 2.0 client ID registered with the IdP. |
| `REVIEW_AGENT_OIDC_CLIENT_SECRET` | yes (or KMS variant) | OAuth 2.0 client secret, plain-text. Use `REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED` instead when AWS KMS envelope encryption is configured. |
| `REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED` | yes (KMS) | Base64-encoded KMS-encrypted ciphertext of the client secret. The server decrypts it on startup using the IAM role's KMS permissions. |
| `REVIEW_AGENT_OIDC_REDIRECT_URI` | **yes** | Must match exactly what is registered with the IdP. Example: `https://dashboard.example.com/api/auth/oidc/callback` |
| `REVIEW_AGENT_DASHBOARD_ORIGIN` | **yes** | The SPA's public origin. The server uses this to build the post-callback redirect: `<origin>/#token=...`. Example: `https://dashboard.example.com` |
| `REVIEW_AGENT_AUTH_MODE` | **yes** | Must be `session` or `both`. OIDC is disabled when `AUTH_MODE=legacy`. |
| `REVIEW_AGENT_SESSION_SECRET` | **yes** | HS256 key for session JWTs (≥ 32 chars). Shared with password-login sessions. |

The OIDC scope requested is `openid profile email`. The server extracts the
`sub` claim as the OIDC subject identifier and the `email` claim (if present)
for JIT provisioning display.

---

## IdP configuration

Register a **web application / confidential client** with your IdP:

- **Redirect URI**: `<REVIEW_AGENT_OIDC_REDIRECT_URI>` — must match exactly.
- **Grant type**: Authorization Code.
- **Token endpoint auth method**: `client_secret_post` (or `client_secret_basic`
  — the server negotiates from the discovery document).

Tested IdPs: Google Workspace, Okta, Microsoft Entra ID (Azure AD), Auth0,
Keycloak. Any OIDC-compliant provider with a discovery endpoint should work.

---

## User provisioning (JIT)

OIDC login uses **just-in-time provisioning**: the server creates a principal
row in `operator_principals` on first login, keyed by the OIDC `sub` claim.

**A freshly provisioned SSO user has no installation memberships and therefore
no access to any resources.** An admin must explicitly grant access using the
CLI after the user's first login:

```sh
# List principals to find the new user's username (set to the OIDC subject by default)
review-agent user list

# Grant the user a role on a specific installation
review-agent user grant --username <sub-or-username> \
  --installation <installationId> \
  --role viewer   # viewer | editor | admin
```

This is intentional: SSO provisioning does not imply any authorization. Access
must be explicitly granted.

---

## Client secret handling

**Plain-text (default):**

```sh
export REVIEW_AGENT_OIDC_CLIENT_SECRET="your-client-secret"
```

**AWS KMS envelope encryption:**

When `REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED` is set, the server decrypts
the ciphertext using the KMS key associated with the IAM execution role at
startup. The plain-text secret is never written to disk or environment after
decryption.

```sh
# Encrypt with KMS
CIPHER=$(aws kms encrypt \
  --key-id alias/review-agent \
  --plaintext "your-client-secret" \
  --query CiphertextBlob \
  --output text)
export REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED="$CIPHER"
```

Set one of `REVIEW_AGENT_OIDC_CLIENT_SECRET` or
`REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED` — not both. The KMS variant takes
precedence when both are present.

---

## Relationship to password login

SSO and password login produce identical session JWTs and use the same
`operator_principals` table. You can run both simultaneously (`AUTH_MODE=both`).
A user can have both a password and an OIDC identity if the `sub` claim matches
the same principal row.

---

## Security notes

- The `#token=...` fragment is stripped from the URL immediately on SPA load
  and is never sent to any server (fragments are not included in HTTP requests).
  It is, however, briefly visible in `window.location.hash` on the browser
  session and in the browser's in-memory history. Treat the dashboard origin
  as trusted.
- The `REVIEW_AGENT_DASHBOARD_ORIGIN` value must be a trusted, HTTPS origin in
  production. HTTP origins allow token interception via network.
- The OIDC state parameter is validated server-side to prevent CSRF on the
  authorization callback.
- Rate-limiting for the OIDC endpoints follows the same guidance as password
  login: put the dashboard behind a WAF or reverse proxy.
