/**
 * OIDC helpers for the Authorization Code + PKCE flow (Phase B, issue #137).
 *
 * All external I/O (discovery fetch, JWKS) is injectable for testing.
 * No process.env reads here — callers (resolveOidcConfig) handle env resolution.
 *
 * Security notes:
 *   - Only RS256 / ES256 algorithms accepted for id_token verification.
 *   - issuer, audience (clientId), nonce, and exp are all validated.
 *   - client_secret is never logged.
 *   - PKCE uses S256 (SHA-256 code challenge) — plain is not supported.
 */
import { createHash, randomBytes } from 'node:crypto';
import { decryptWithDataKey, type KmsClient } from '@review-agent/core';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved OIDC configuration passed to endpoint handlers. */
export type OidcConfig = {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

/** PKCE pair. verifier is kept in the cookie; challenge is sent to the IdP. */
export type PkcePair = {
  readonly verifier: string;
  readonly challenge: string;
};

/** Discovered OIDC provider endpoints. */
export type OidcDiscovery = {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
};

/** Claims extracted from a verified id_token. */
export type OidcClaims = {
  readonly sub: string;
  readonly preferredUsername?: string | undefined;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const discoverySchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
});

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
});

const idTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  preferred_username: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  nonce: z.string().optional(),
  iss: z.string().optional(),
  aud: z.unknown().optional(),
  exp: z.number().optional(),
});

// ---------------------------------------------------------------------------
// resolveOidcConfig
// ---------------------------------------------------------------------------

/**
 * Options for resolveOidcConfig. Injected so tests can control KMS path.
 */
export type ResolveOidcConfigOpts = {
  /**
   * KMS client to decrypt an envelope-encrypted client secret.
   * When absent or when REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED is unset,
   * the plaintext REVIEW_AGENT_OIDC_CLIENT_SECRET env var is used.
   */
  readonly kmsClient?: KmsClient;
  /**
   * KMS key ID / ARN for envelope decryption.
   * Required when kmsClient is provided and the encrypted secret is set.
   */
  readonly kmsKeyId?: string;
};

/**
 * Build OidcConfig from env vars. Returns null when OIDC is disabled:
 *   - REVIEW_AGENT_OIDC_ISSUER or REVIEW_AGENT_OIDC_CLIENT_ID not set, or
 *   - AUTH_MODE is 'legacy' (OIDC requires session JWTs).
 *
 * client_secret resolution order:
 *   1. kmsClient + REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED (envelope decrypt)
 *   2. REVIEW_AGENT_OIDC_CLIENT_SECRET env var (plaintext fallback)
 *
 * Never throws due to missing optional fields — callers gate on null return.
 *
 * @param env - snapshot of process.env (or test override)
 * @param opts - DI hooks for KMS
 */
export async function resolveOidcConfig(
  env: Record<string, string | undefined>,
  opts: ResolveOidcConfigOpts = {},
): Promise<OidcConfig | null> {
  const issuer = env.REVIEW_AGENT_OIDC_ISSUER;
  const clientId = env.REVIEW_AGENT_OIDC_CLIENT_ID;
  const redirectUri = env.REVIEW_AGENT_OIDC_REDIRECT_URI;
  const authMode = env.REVIEW_AGENT_AUTH_MODE ?? 'legacy';

  // OIDC requires session JWTs (issued after callback). Not supported in legacy mode.
  if (authMode === 'legacy') return null;

  if (!issuer || !clientId) return null;

  const resolvedRedirectUri = redirectUri ?? '';

  // Resolve client secret — KMS envelope path preferred when available.
  let clientSecret: string | undefined;

  const encryptedSecretB64 = env.REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED;
  if (opts.kmsClient !== undefined && opts.kmsKeyId !== undefined && encryptedSecretB64) {
    try {
      const encryptedBuf = Buffer.from(encryptedSecretB64, 'base64');
      // The encrypted payload format follows the BYOK envelope used elsewhere:
      // [wrapped_key_len:2][wrapped_key][iv:12][tag:16][ciphertext]
      // Extract components per the envelope schema.
      const wrappedKeyLen = encryptedBuf.readUInt16BE(0);
      const wrappedKey = encryptedBuf.subarray(2, 2 + wrappedKeyLen);
      const ivStart = 2 + wrappedKeyLen;
      const iv = encryptedBuf.subarray(ivStart, ivStart + 12);
      const authTag = encryptedBuf.subarray(ivStart + 12, ivStart + 12 + 16);
      const ciphertext = encryptedBuf.subarray(ivStart + 12 + 16);

      const dataKey = await opts.kmsClient.decryptDataKey(wrappedKey, opts.kmsKeyId);
      clientSecret = decryptWithDataKey({ ciphertext, iv, authTag }, dataKey);
    } catch (err) {
      // KMS decryption failure is fatal — do not fall back silently.
      process.stderr.write(
        `[review-agent] ERROR: OIDC client secret KMS decryption failed: ${String(err)}\n`,
      );
      return null;
    }
  } else {
    clientSecret = env.REVIEW_AGENT_OIDC_CLIENT_SECRET;
  }

  if (!clientSecret) return null;

  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri: resolvedRedirectUri,
  };
}

// ---------------------------------------------------------------------------
// discoverOidc
// ---------------------------------------------------------------------------

/**
 * Fetch the OIDC provider's discovery document.
 *
 * @param issuer - The OIDC issuer URL (without trailing slash).
 * @param opts   - DI: supply a custom fetchFn for tests.
 */
export async function discoverOidc(
  issuer: string,
  opts: { readonly fetchFn?: typeof fetch } = {},
): Promise<OidcDiscovery> {
  /* v8 ignore next */
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${issuer}/.well-known/openid-configuration`;

  let data: unknown;
  try {
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(`discovery HTTP ${String(res.status)}`);
    }
    data = await res.json();
  } catch (err) {
    throw new Error(`OIDC discovery failed for ${issuer}: ${String(err)}`);
  }

  const parsed = discoverySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`OIDC discovery document missing required fields: ${parsed.error.message}`);
  }

  return {
    authorizationEndpoint: parsed.data.authorization_endpoint,
    tokenEndpoint: parsed.data.token_endpoint,
    jwksUri: parsed.data.jwks_uri,
  };
}

// ---------------------------------------------------------------------------
// createPkce
// ---------------------------------------------------------------------------

/**
 * Generate a PKCE S256 pair.
 *
 * verifier: 64 random bytes → base64url (URL-safe, no padding)
 * challenge: SHA-256(verifier) → base64url (no padding)
 */
export function createPkce(): PkcePair {
  const verifierBytes = randomBytes(64);
  const verifier = verifierBytes.toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// verifyOidcIdToken
// ---------------------------------------------------------------------------

/**
 * Verify an OIDC id_token and extract claims.
 *
 * @param idToken      - The raw JWT string from the token endpoint.
 * @param opts.issuer  - Expected issuer (must match `iss` claim).
 * @param opts.clientId - Expected audience (must match `aud` claim).
 * @param opts.jwks    - JWKS resolver. In prod: createRemoteJWKSet(url).
 *                       In tests: createLocalJWKSet(keySet).
 * @param opts.expectedNonce - Nonce stored in the user's cookie; must match `nonce` claim.
 *
 * Returns OidcClaims on success, null on any validation failure (never throws).
 */
export async function verifyOidcIdToken(
  idToken: string,
  opts: {
    readonly issuer: string;
    readonly clientId: string;
    // biome-ignore lint/suspicious/noExplicitAny: jose JWKS resolver accepts any shape
    readonly jwks: any;
    readonly expectedNonce: string;
  },
): Promise<OidcClaims | null> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(idToken, opts.jwks, {
      algorithms: ['RS256', 'ES256'],
      issuer: opts.issuer,
      audience: opts.clientId,
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    return null;
  }

  const parsed = idTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  // nonce validation — must match exactly.
  if (parsed.data.nonce !== opts.expectedNonce) {
    return null;
  }

  return {
    sub: parsed.data.sub,
    ...(parsed.data.preferred_username !== undefined
      ? { preferredUsername: parsed.data.preferred_username }
      : {}),
    ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
  };
}

// ---------------------------------------------------------------------------
// exchangeCode
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens at the IdP token endpoint.
 *
 * Never logs the client_secret or returned tokens.
 *
 * @returns The raw id_token string.
 * @throws  When the HTTP response is not OK or id_token is missing.
 */
export async function exchangeCode(opts: {
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly fetchFn?: typeof fetch;
}): Promise<string> {
  /* v8 ignore next */
  const fetchFn = opts.fetchFn ?? fetch;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });

  // client_secret sent as form field (confidential client). Never logged.
  body.set('client_secret', opts.clientSecret);

  let data: unknown;
  try {
    const res = await fetchFn(opts.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      // Do NOT include response body — may contain sensitive fields.
      throw new Error(`token endpoint HTTP ${String(res.status)}`);
    }
    data = await res.json();
  } catch (err) {
    throw new Error(`OIDC token exchange failed: ${String(err)}`);
  }

  const parsed = tokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('OIDC token response missing id_token');
  }

  return parsed.data.id_token;
}

// Re-export jose helpers so callers can build their jwks without a direct jose dep.
export { createRemoteJWKSet, createLocalJWKSet };
