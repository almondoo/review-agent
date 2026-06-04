/**
 * JWT helpers for session authentication.
 *
 * Uses `jose` (HS256 only). Algorithm is fixed — `alg confusion` and `none`
 * attacks are rejected by passing `algorithms: ['HS256']` to `jwtVerify`.
 *
 * No I/O beyond the jose library; suitable for use in server middleware.
 */
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

/** Claims embedded in the JWT beyond standard JOSE fields. */
export type SessionPayload = {
  readonly principalId: string;
  readonly username: string;
  readonly tokenVersion: number;
};

/** Internal Zod schema validates the JWT payload after signature check. */
const sessionClaimsSchema = z.object({
  sub: z.string().min(1),
  username: z.string().min(1),
  tv: z.number().int().nonnegative(),
});

/**
 * Issue a signed HS256 JWT for a principal.
 *
 * Claims:
 *   sub        = principalId
 *   username   = principal username (informational)
 *   tv         = tokenVersion (used for JWT revocation via DB check)
 *   iat        = issued-at (set automatically by SignJWT)
 *   exp        = iat + ttlSeconds
 */
export async function issueSessionToken(
  payload: SessionPayload,
  secret: Uint8Array | string,
  ttlSeconds: number,
): Promise<string> {
  const secretKey = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  return new SignJWT({ username: payload.username, tv: payload.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.principalId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey);
}

/**
 * Verify a JWT and extract session claims.
 *
 * Returns null when the token is malformed, expired, has a bad signature,
 * or uses an unexpected algorithm (alg confusion / none attack). Never throws.
 *
 * The caller is responsible for checking `tokenVersion` against the DB.
 */
export async function verifySessionToken(
  token: string,
  secret: Uint8Array | string,
): Promise<SessionPayload | null> {
  const secretKey = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, secretKey, {
      // Fix alg to HS256. This rejects alg=none and any asymmetric alg.
      algorithms: ['HS256'],
    });
    payload = result.payload;
  } catch {
    return null;
  }

  const parsed = sessionClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  return {
    principalId: parsed.data.sub,
    username: parsed.data.username,
    tokenVersion: parsed.data.tv,
  };
}
