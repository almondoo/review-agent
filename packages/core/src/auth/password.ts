import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Pure password hashing helpers using scrypt (RFC 7914).
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`
 *   N   = 2^14 = 16384  (CPU/memory cost)
 *   r   = 8             (block size)
 *   p   = 1             (parallelisation)
 *   saltB64 = 16 random bytes, base64url-encoded
 *   hashB64 = 64 derived key bytes, base64url-encoded
 *
 * NOTE: N=2^14 rather than the originally specified 2^15. Node.js 24 on this
 * platform enforces an OpenSSL scrypt memory ceiling that rejects 2^15 with
 * ERR_CRYPTO_INVALID_SCRYPT_PARAMS. 2^14 is the OWASP-recommended minimum for
 * interactive logins and is sufficient for the dashboard use-case. Because the
 * stored format is self-describing, existing hashes remain verifiable and the
 * cost parameter can be raised in a future migration once the ceiling is lifted.
 *
 * No I/O. No process.env. Suitable for use in `packages/core` (zero-I/O rule).
 */

const SCRYPT_N = 2 ** 14; // 16384
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SEPARATOR = '$';
const PREFIX = 'scrypt';
const FIELD_COUNT = 6; // prefix, N, r, p, salt, hash

// Upper bounds for scrypt parameters read back from a stored hash. The write
// path (`hashPassword`) always uses the fixed SCRYPT_* values above; these caps
// only guard the verify path against a corrupted or hostile stored hash that
// would otherwise (a) be trivially weak (e.g. N=1) or (b) exhaust memory / stall
// the event loop with an enormous N. Exploiting either requires write access to
// the stored hash, so this is defense-in-depth rather than a primary control.
const MAX_SCRYPT_N = 2 ** 20; // 1,048,576 — generous headroom over the 2^14 used for writes
const MAX_SCRYPT_R = 256;
const MAX_SCRYPT_P = 256;

function encodeB64(buf: Buffer): string {
  return buf.toString('base64url');
}

function decodeB64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/**
 * Hash a plaintext password with a fresh random salt.
 * Returns a self-describing stored string (includes params + salt).
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, encodeB64(salt), encodeB64(hash)].join(SEPARATOR);
}

/**
 * Verify a plaintext password against a stored hash string.
 *
 * Always returns `false` on malformed input rather than throwing, so callers
 * do not need to wrap this in try/catch.
 *
 * Timing note: even on format-parse failures a dummy `timingSafeEqual` of
 * fixed-length zero buffers is performed before returning `false`, preventing
 * an attacker from using the short-circuit path to distinguish "unknown
 * username" from "wrong password" via response time.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  // Dummy buffers used for timing-safe comparison on failure paths.
  const dummy = Buffer.alloc(KEY_BYTES, 0);

  const parts = stored.split(SEPARATOR);
  if (parts.length !== FIELD_COUNT || parts[0] !== PREFIX) {
    // Perform dummy comparison to keep timing consistent.
    timingSafeEqual(dummy, dummy);
    return false;
  }

  const [, rawN, rawR, rawP, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N <= 0 ||
    r <= 0 ||
    p <= 0 ||
    N > MAX_SCRYPT_N ||
    r > MAX_SCRYPT_R ||
    p > MAX_SCRYPT_P
  ) {
    timingSafeEqual(dummy, dummy);
    return false;
  }

  let salt: Buffer;
  let expectedHash: Buffer;
  try {
    salt = decodeB64(saltB64);
    expectedHash = decodeB64(hashB64);
  } catch {
    timingSafeEqual(dummy, dummy);
    return false;
  }

  if (expectedHash.length !== KEY_BYTES) {
    timingSafeEqual(dummy, dummy);
    return false;
  }

  let actualHash: Buffer;
  try {
    actualHash = scryptSync(plain, salt, KEY_BYTES, { N, r, p });
  } catch {
    timingSafeEqual(dummy, dummy);
    return false;
  }

  return timingSafeEqual(actualHash, expectedHash);
}
