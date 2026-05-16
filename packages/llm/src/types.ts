import type { InlineComment } from '@review-agent/core';
import type { ToolSet } from 'ai';

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
  /**
   * Legacy direct file-reader. Retained for callers that need to read
   * files outside the agent loop (estimator paths, eval harness). The
   * LLM itself reads files via `tools.read_file`, not this hook.
   */
  readonly fileReader: (path: string) => Promise<string>;
  readonly language: string;
  /**
   * AI-SDK tool set exposed to the model for the generateText call.
   * The runner builds this from `runner/src/tools.ts`'s
   * `createAiSdkToolset`. When omitted, the provider runs an empty
   * tool set (text-only generation).
   */
  readonly tools?: ToolSet;
  /**
   * Upper bound on agent steps (and therefore tool-calling
   * round-trips) before the provider stops the loop. The runner
   * passes `MAX_TOOL_CALLS`. When omitted, providers fall back to
   * their own default (currently 20).
   */
  readonly maxToolCalls?: number;
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
  /**
   * Number of tool calls the LLM made during this review (summed
   * across all agent-loop steps). Surfaced for cost-guard accounting
   * and observability.
   */
  readonly toolCalls?: number;
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
