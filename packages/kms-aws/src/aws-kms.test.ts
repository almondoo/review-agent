import { Buffer } from 'node:buffer';
import { DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';
import { createAwsKmsClient } from './aws-kms.js';

function fakeClient(handlers: {
  encrypt?: (input: { KeyId?: string; Plaintext?: Uint8Array }) => unknown;
  decrypt?: (input: { KeyId?: string; CiphertextBlob?: Uint8Array }) => unknown;
}) {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      if (cmd.constructor.name === 'EncryptCommand') {
        return handlers.encrypt?.(cmd.input as { KeyId?: string; Plaintext?: Uint8Array });
      }
      if (cmd.constructor.name === 'DecryptCommand') {
        return handlers.decrypt?.(cmd.input as { KeyId?: string; CiphertextBlob?: Uint8Array });
      }
      throw new Error(`Unexpected command ${cmd.constructor.name}`);
    }),
  };
}

describe('createAwsKmsClient', () => {
  it('passes the CMK id + plaintext through EncryptCommand and returns the CiphertextBlob', async () => {
    const seen: { keyId?: string; plaintext?: Uint8Array } = {};
    const client = fakeClient({
      encrypt: (input) => {
        seen.keyId = input.KeyId;
        seen.plaintext = input.Plaintext;
        return { CiphertextBlob: new Uint8Array([1, 2, 3, 4]) };
      },
    });
    const kms = createAwsKmsClient({ client });
    const out = await kms.encryptDataKey(Buffer.from([9, 9, 9]), 'arn:aws:kms:us-east-1:1:key/abc');
    expect(seen.keyId).toBe('arn:aws:kms:us-east-1:1:key/abc');
    expect(Array.from(seen.plaintext ?? [])).toEqual([9, 9, 9]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(client.send).toHaveBeenCalledWith(expect.any(EncryptCommand));
  });

  it('passes the CMK id + ciphertext through DecryptCommand and returns the Plaintext', async () => {
    const seen: { keyId?: string; ciphertext?: Uint8Array } = {};
    const client = fakeClient({
      decrypt: (input) => {
        seen.keyId = input.KeyId;
        seen.ciphertext = input.CiphertextBlob;
        return { Plaintext: new Uint8Array([7, 7, 7]) };
      },
    });
    const kms = createAwsKmsClient({ client });
    const out = await kms.decryptDataKey(Buffer.from([5, 5]), 'arn:aws:kms:...:key/abc');
    expect(seen.keyId).toBe('arn:aws:kms:...:key/abc');
    expect(Array.from(seen.ciphertext ?? [])).toEqual([5, 5]);
    expect(Array.from(out)).toEqual([7, 7, 7]);
    expect(client.send).toHaveBeenCalledWith(expect.any(DecryptCommand));
  });

  it('throws when EncryptCommand response has no CiphertextBlob', async () => {
    const client = fakeClient({ encrypt: () => ({}) });
    const kms = createAwsKmsClient({ client });
    await expect(() => kms.encryptDataKey(Buffer.from([1]), 'k')).rejects.toThrow(/Encrypt/);
  });

  it('throws when DecryptCommand response has no Plaintext', async () => {
    const client = fakeClient({ decrypt: () => ({}) });
    const kms = createAwsKmsClient({ client });
    await expect(() => kms.decryptDataKey(Buffer.from([1]), 'k')).rejects.toThrow(/Decrypt/);
  });

  it('constructs a default KMSClient when no client is injected', () => {
    expect(() => createAwsKmsClient()).not.toThrow();
    expect(() => createAwsKmsClient({ clientConfig: { region: 'us-east-1' } })).not.toThrow();
  });
});
