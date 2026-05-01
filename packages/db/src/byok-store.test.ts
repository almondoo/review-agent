import { Buffer } from 'node:buffer';
import type { KmsClient } from '@review-agent/core';
import { decryptWithDataKey, encryptWithDataKey, generateDataKey } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { createByokStore } from './byok-store.js';

// In-memory KMS that wraps with a fixed master key. Good enough for
// round-trip tests; never use this in production.
function inMemoryKms(): KmsClient {
  const masterKey = generateDataKey();
  return {
    encryptDataKey: async (plaintext, _keyId) => {
      const env = encryptWithDataKey(plaintext.toString('base64'), masterKey);
      return Buffer.concat([env.iv, env.authTag, env.ciphertext]);
    },
    decryptDataKey: async (ciphertext, _keyId) => {
      const iv = ciphertext.subarray(0, 12);
      const authTag = ciphertext.subarray(12, 28);
      const body = ciphertext.subarray(28);
      const text = decryptWithDataKey({ iv, authTag, ciphertext: body }, masterKey);
      return Buffer.from(text, 'base64');
    },
  };
}

type StoredRow = {
  installationId: bigint;
  provider: string;
  kmsKeyId: string;
  wrappedDataKey: Buffer;
  encryptedSecret: Buffer;
  iv: Buffer;
  authTag: Buffer;
  rotatedAt?: Date;
};

// Fake DbClient that captures inserts + answers selects from an
// in-memory map keyed by (installation_id, provider).
function fakeDb() {
  const rows = new Map<string, StoredRow>();
  const key = (id: bigint, provider: string) => `${id}:${provider}`;

  const insert = vi.fn(() => ({
    values: (row: StoredRow) => ({
      onConflictDoUpdate: (_args: unknown) => {
        rows.set(key(row.installationId, row.provider), row);
        return Promise.resolve();
      },
    }),
  }));

  const select = vi.fn(() => ({
    from: (_table: unknown) => ({
      where: (_predicate: { installationId: bigint; provider: string }) => ({
        limit: (_n: number) => {
          const matches = [...rows.values()].filter(
            (r) =>
              r.installationId === _predicate.installationId && r.provider === _predicate.provider,
          );
          return Promise.resolve(matches);
        },
      }),
    }),
  }));

  return {
    db: { insert, select } as unknown as Parameters<typeof createByokStore>[0]['db'],
    rows,
    insert,
    select,
  };
}

// Drizzle's `eq` + `and` produce structured nodes the fake matcher
// can't read directly. Override with simpler shape via `vi.mock`.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string } & Record<string, unknown>, value: unknown) => ({
      _kind: 'eq',
      col,
      value,
    }),
    and: (...args: unknown[]) => {
      const result: Record<string, unknown> = {};
      for (const arg of args) {
        const eq = arg as { col?: { name?: string }; value?: unknown };
        if (eq?.col?.name === 'installation_id') result.installationId = eq.value;
        if (eq?.col?.name === 'provider') result.provider = eq.value;
      }
      return result;
    },
  };
});

describe('createByokStore', () => {
  it('round-trips a secret through encrypt → KMS-wrap → decrypt', async () => {
    const { db } = fakeDb();
    const kms = inMemoryKms();
    const store = createByokStore({ db, kms });

    await store.upsert({
      installationId: 1n,
      provider: 'anthropic',
      kmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc',
      secret: 'sk-ant-xxx',
    });

    const out = await store.read({ installationId: 1n, provider: 'anthropic' });
    expect(out).toBe('sk-ant-xxx');
  });

  it('returns null when no row exists', async () => {
    const { db } = fakeDb();
    const store = createByokStore({ db, kms: inMemoryKms() });
    const out = await store.read({ installationId: 999n, provider: 'anthropic' });
    expect(out).toBeNull();
  });

  it('rotate() re-wraps the stored secret with a new IV / wrapped key', async () => {
    const { db, rows } = fakeDb();
    const kms = inMemoryKms();
    const store = createByokStore({ db, kms });

    await store.upsert({
      installationId: 1n,
      provider: 'anthropic',
      kmsKeyId: 'k1',
      secret: 'sk-ant-xxx',
    });
    const beforeIv = rows.get('1:anthropic')?.iv.toString('hex');
    const beforeWrap = rows.get('1:anthropic')?.wrappedDataKey.toString('hex');

    await store.rotate({ installationId: 1n, provider: 'anthropic', kmsKeyId: 'k2' });
    const after = rows.get('1:anthropic');
    expect(after?.iv.toString('hex')).not.toBe(beforeIv);
    expect(after?.wrappedDataKey.toString('hex')).not.toBe(beforeWrap);
    expect(after?.kmsKeyId).toBe('k2');

    const decrypted = await store.read({ installationId: 1n, provider: 'anthropic' });
    expect(decrypted).toBe('sk-ant-xxx');
  });

  it('rotate() throws when the row does not exist', async () => {
    const { db } = fakeDb();
    const store = createByokStore({ db, kms: inMemoryKms() });
    await expect(() =>
      store.rotate({ installationId: 9n, provider: 'anthropic', kmsKeyId: 'k' }),
    ).rejects.toThrow(/missing/);
  });

  it('does not log the plaintext secret anywhere', async () => {
    const logCalls: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((...args) => logCalls.push(args.map(String).join(' ')));
    const err = vi
      .spyOn(console, 'error')
      .mockImplementation((...args) => logCalls.push(args.map(String).join(' ')));
    try {
      const { db } = fakeDb();
      const store = createByokStore({ db, kms: inMemoryKms() });
      await store.upsert({
        installationId: 1n,
        provider: 'anthropic',
        kmsKeyId: 'k',
        secret: 'sk-VERYSECRET-DO-NOT-LOG',
      });
      await store.read({ installationId: 1n, provider: 'anthropic' });
      const joined = logCalls.join('\n');
      expect(joined).not.toContain('sk-VERYSECRET-DO-NOT-LOG');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
