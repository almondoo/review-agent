import { Buffer } from 'node:buffer';
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import type { KmsClient } from '@review-agent/core';

export type AwsKmsClientLike = Pick<KMSClient, 'send'>;

export type CreateAwsKmsClientOpts = {
  /** Inject an existing KMS client (or a test fake). */
  readonly client?: AwsKmsClientLike;
  /** SDK config used when `client` is not supplied. */
  readonly clientConfig?: KMSClientConfig;
};

// AWS KMS implementation of `KmsClient`. Uses GenerateDataKey-style
// wrap/unwrap semantics: the caller supplies the plaintext data key,
// we round-trip it through KMS Encrypt / Decrypt against the named
// CMK. The plaintext key never crosses the network in either
// direction beyond this single call.
export function createAwsKmsClient(opts: CreateAwsKmsClientOpts = {}): KmsClient {
  const client = opts.client ?? (new KMSClient(opts.clientConfig ?? {}) as AwsKmsClientLike);

  return {
    encryptDataKey: async (plaintext: Buffer, keyId: string): Promise<Buffer> => {
      const out = await client.send(
        new EncryptCommand({
          KeyId: keyId,
          Plaintext: new Uint8Array(plaintext),
        }),
      );
      if (!out.CiphertextBlob) {
        throw new Error('AWS KMS Encrypt returned no CiphertextBlob');
      }
      return Buffer.from(out.CiphertextBlob);
    },

    decryptDataKey: async (ciphertext: Buffer, keyId: string): Promise<Buffer> => {
      const out = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: new Uint8Array(ciphertext),
        }),
      );
      if (!out.Plaintext) {
        throw new Error('AWS KMS Decrypt returned no Plaintext');
      }
      return Buffer.from(out.Plaintext);
    },
  };
}
