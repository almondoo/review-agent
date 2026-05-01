import {
  type BYOKProvider,
  decryptWithDataKey,
  encryptWithDataKey,
  generateDataKey,
  type KmsClient,
} from '@review-agent/core';
import { installationSecrets } from '@review-agent/core/db';
import { and, eq } from 'drizzle-orm';
import type { DbClient } from './connection.js';

export type ByokStoreDeps = {
  readonly db: DbClient;
  readonly kms: KmsClient;
};

export type ByokRecord = {
  readonly installationId: bigint;
  readonly provider: BYOKProvider;
  /** CMK identifier the data key is wrapped under (ARN / resource name). */
  readonly kmsKeyId: string;
};

export type ByokStore = {
  /** Persists / rotates the BYOK secret for an installation + provider. */
  upsert(record: ByokRecord & { readonly secret: string }): Promise<void>;
  /** Decrypts and returns the plaintext secret. Plaintext never logged. */
  read(record: Pick<ByokRecord, 'installationId' | 'provider'>): Promise<string | null>;
  /**
   * Re-wraps the existing secret under the given (possibly new) CMK and
   * issues a fresh data key + IV. Use for §8.7 rotations.
   */
  rotate(record: ByokRecord): Promise<void>;
};

// Repository for the installation_secrets table — handles AES-256-GCM
// envelope encryption + KMS data-key wrapping per spec §8.5.
//
// All callers must wrap calls in `withTenant(...)` so RLS bounds reads
// to the matching installation_id. The repository never logs the
// plaintext secret; tests assert this.
export function createByokStore(deps: ByokStoreDeps): ByokStore {
  const { db, kms } = deps;

  async function upsertWithSecret(record: ByokRecord & { readonly secret: string }): Promise<void> {
    const dataKey = generateDataKey();
    try {
      const wrappedDataKey = await kms.encryptDataKey(dataKey, record.kmsKeyId);
      const envelope = encryptWithDataKey(record.secret, dataKey);
      await db
        .insert(installationSecrets)
        .values({
          installationId: record.installationId,
          provider: record.provider,
          kmsKeyId: record.kmsKeyId,
          wrappedDataKey,
          encryptedSecret: envelope.ciphertext,
          iv: envelope.iv,
          authTag: envelope.authTag,
        })
        .onConflictDoUpdate({
          target: [installationSecrets.installationId, installationSecrets.provider],
          set: {
            kmsKeyId: record.kmsKeyId,
            wrappedDataKey,
            encryptedSecret: envelope.ciphertext,
            iv: envelope.iv,
            authTag: envelope.authTag,
            rotatedAt: new Date(),
          },
        });
    } finally {
      // Best-effort wipe. Node Buffers expose `.fill(0)` which the JS
      // engine usually honours, though GC timing means we can't make
      // formal guarantees.
      dataKey.fill(0);
    }
  }

  async function read(
    lookup: Pick<ByokRecord, 'installationId' | 'provider'>,
  ): Promise<string | null> {
    const rows = await db
      .select()
      .from(installationSecrets)
      .where(
        and(
          eq(installationSecrets.installationId, lookup.installationId),
          eq(installationSecrets.provider, lookup.provider),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const dataKey = await kms.decryptDataKey(row.wrappedDataKey, row.kmsKeyId);
    try {
      return decryptWithDataKey(
        { ciphertext: row.encryptedSecret, iv: row.iv, authTag: row.authTag },
        dataKey,
      );
    } finally {
      dataKey.fill(0);
    }
  }

  async function rotate(record: ByokRecord): Promise<void> {
    const existing = await read(record);
    if (!existing) {
      throw new Error(
        `BYOK row missing for installation_id=${record.installationId} provider=${record.provider}; nothing to rotate`,
      );
    }
    await upsertWithSecret({ ...record, secret: existing });
  }

  return {
    upsert: upsertWithSecret,
    read,
    rotate,
  };
}
