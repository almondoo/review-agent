import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM envelope encryption helpers (spec §8.5).
//
// A fresh 256-bit data key is generated for every secret, used to
// AES-256-GCM encrypt the plaintext, then handed to KMS for wrapping.
// The plaintext data key is discarded after use; the wrapped form is
// stored alongside the ciphertext + 96-bit IV + 128-bit auth tag.

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
// 96 bits is the recommended IV size for GCM. Smaller / larger IVs
// have known interoperability or security pitfalls — do not change.
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptedPayload = {
  /** AES-256-GCM ciphertext of the customer secret (UTF-8 encoded). */
  readonly ciphertext: Buffer;
  /** 96-bit IV for the AES operation. */
  readonly iv: Buffer;
  /** 128-bit GCM authentication tag. */
  readonly authTag: Buffer;
};

/**
 * Generates a fresh 256-bit data key. Returned as a Buffer so the
 * caller can pass it to both AES + KMS. Never logged.
 */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Encrypts `plaintext` under `dataKey` (AES-256-GCM). Generates a
 * random 96-bit IV per call. Caller is responsible for zeroing the
 * data key after persisting the wrapped form.
 */
export function encryptWithDataKey(plaintext: string, dataKey: Buffer): EncryptedPayload {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(`dataKey must be ${KEY_BYTES} bytes (got ${dataKey.length}).`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

/**
 * Reverses `encryptWithDataKey`. A wrong data key, IV, or tag throws
 * — GCM authenticates, so corruption is never silently decrypted.
 */
export function decryptWithDataKey(payload: EncryptedPayload, dataKey: Buffer): string {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(`dataKey must be ${KEY_BYTES} bytes (got ${dataKey.length}).`);
  }
  if (payload.iv.length !== IV_BYTES) {
    throw new Error(`iv must be ${IV_BYTES} bytes (got ${payload.iv.length}).`);
  }
  if (payload.authTag.length !== TAG_BYTES) {
    throw new Error(`authTag must be ${TAG_BYTES} bytes (got ${payload.authTag.length}).`);
  }
  const decipher = createDecipheriv(ALGORITHM, dataKey, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString('utf8');
}

export const ENVELOPE_PARAMS = {
  algorithm: ALGORITHM,
  keyBytes: KEY_BYTES,
  ivBytes: IV_BYTES,
  tagBytes: TAG_BYTES,
} as const;
