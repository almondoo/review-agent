import type { InlineComment } from '@review-agent/core';

export const PROVIDER_TYPES = [
  'anthropic',
  'openai',
  'azure-openai',
  'google',
  'vertex',
  'bedrock',
  'openai-compatible',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export type ProviderConfig = {
  readonly type: ProviderType;
  readonly model: string;
  readonly fallbackModels?: ReadonlyArray<string>;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly region?: string;
  readonly azureDeployment?: string;
  readonly anthropicCacheControl?: boolean;
  readonly vertexProjectId?: string;
};

export type ReviewInput = {
  readonly systemPrompt: string;
  readonly diffText: string;
  readonly prMetadata: {
    readonly title: string;
    readonly body: string;
    readonly author: string;
  };
  readonly fileReader: (path: string) => Promise<string>;
  readonly language: string;
};

export type ReviewOutputComment = Omit<InlineComment, 'fingerprint'>;

export type ReviewOutput = {
  readonly comments: ReadonlyArray<ReviewOutputComment>;
  readonly summary: string;
  readonly tokensUsed: {
    readonly input: number;
    readonly output: number;
    readonly cacheHit?: number;
  };
  readonly costUsd: number;
};

export const ERROR_KINDS = [
  'rate_limit',
  'overloaded',
  'context_length',
  'auth',
  'transient',
  'fatal',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export type ErrorClassification = {
  readonly kind: ErrorKind;
  readonly retryAfterMs?: number;
};

export type LlmProvider = {
  readonly name: string;
  readonly model: string;
  generateReview(input: ReviewInput): Promise<ReviewOutput>;
  estimateCost(input: ReviewInput): Promise<{
    readonly inputTokens: number;
    readonly estimatedUsd: number;
  }>;
  pricePerMillionTokens(): { readonly input: number; readonly output: number };
  classifyError(err: unknown): ErrorClassification;
};
