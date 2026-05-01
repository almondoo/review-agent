// KMS abstraction. Both methods accept the operator-supplied CMK
// identifier (ARN / resource name / Key Vault key URL) and operate on
// the data key, never the plaintext customer secret. Implementations
// live in dedicated packages (`@review-agent/kms-aws`, `kms-gcp`,
// `kms-azure`) so deployments only install the SDK they need.
export type KmsClient = {
  /** Wraps a fresh AES-256 data key under the supplied CMK. */
  encryptDataKey(plaintext: Buffer, keyId: string): Promise<Buffer>;
  /** Unwraps a previously-encrypted data key under the supplied CMK. */
  decryptDataKey(ciphertext: Buffer, keyId: string): Promise<Buffer>;
};

// Provider IDs we accept on the BYOK path. Kept narrow (vs the full
// LLM provider matrix) so the schema's `provider` column has a
// well-defined contract.
export const BYOK_PROVIDERS = [
  'anthropic',
  'openai',
  'azure-openai',
  'google',
  'vertex',
  'bedrock',
  'openai-compatible',
] as const;
export type BYOKProvider = (typeof BYOK_PROVIDERS)[number];
