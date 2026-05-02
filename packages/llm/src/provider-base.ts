import { ReviewOutputSchema } from '@review-agent/core';
import { generateObject } from 'ai';
import { getEncoding } from 'js-tiktoken';
import { type ModelPrice, priceForModel } from './pricing.js';
import type { ErrorClassification, LlmProvider, ReviewInput, ReviewOutput } from './types.js';

export type ProviderPricing = Readonly<Record<string, ModelPrice>>;

const DEFAULT_TEMPERATURE = 0.2;
const FALLBACK_CHARS_PER_TOKEN = 4;

export type GenerateObjectFn = typeof generateObject;
export type Tokenizer = (text: string) => number;

// Each driver hands us a small "describe-the-provider" object; this
// module owns the boilerplate (generateObject call, pricing, tokenize
// fallback, prompt composition).
export type ProviderShape<TModelArg> = {
  /** Display name returned on the LlmProvider. */
  readonly name: string;
  /** Pricing table to look up `priceForModel` against. */
  readonly pricing: ProviderPricing;
  /** Provider-specific error classifier. */
  readonly classifyError: (err: unknown) => ErrorClassification;
  /** Builds the AI-SDK `LanguageModel` (or whatever the SDK calls it) for `generateObject`. */
  readonly modelForRequest: (model: string) => TModelArg;
};

export type ProviderDriverDeps = {
  readonly generate?: GenerateObjectFn;
  readonly tokenize?: Tokenizer;
};

let cachedTiktoken: Tokenizer | null | undefined;

function tryLoadTiktoken(): Tokenizer | null {
  if (cachedTiktoken !== undefined) return cachedTiktoken;
  try {
    const encoder = getEncoding('cl100k_base');
    cachedTiktoken = (text: string) => encoder.encode(text).length;
    return cachedTiktoken;
  } catch {
    /* v8 ignore next */
    cachedTiktoken = null;
    /* v8 ignore next */
    return null;
  }
}

function approximateTokens(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

export function composeUserPrompt(input: ReviewInput): string {
  return [
    '<untrusted>',
    `<title>${input.prMetadata.title}</title>`,
    `<author>${input.prMetadata.author}</author>`,
    `<body>${input.prMetadata.body}</body>`,
    '</untrusted>',
    '',
    '<diff>',
    input.diffText,
    '</diff>',
  ].join('\n');
}

// Generic driver factory shared by every provider. Each provider's
// own file becomes a thin shim that builds the `ProviderShape` plus
// validates / extracts its specific config fields.
export function createGenericProvider<TModelArg>(
  shape: ProviderShape<TModelArg>,
  model: string,
  deps: ProviderDriverDeps = {},
): LlmProvider {
  const generate = deps.generate ?? generateObject;
  const tokenize = deps.tokenize ?? tryLoadTiktoken() ?? approximateTokens;

  return {
    name: shape.name,
    model,
    generateReview: async (input: ReviewInput): Promise<ReviewOutput> => {
      const userPrompt = composeUserPrompt(input);
      const result = await generate({
        model: shape.modelForRequest(model) as Parameters<GenerateObjectFn>[0]['model'],
        schema: ReviewOutputSchema,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: DEFAULT_TEMPERATURE,
      });
      const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } })
        .usage ?? { inputTokens: 0, outputTokens: 0 };
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const price = priceForModel(shape.pricing, model);
      const costUsd =
        (inputTokens / 1_000_000) * price.inputPerMTok +
        (outputTokens / 1_000_000) * price.outputPerMTok;
      const data = (
        result as {
          object: { comments: ReviewOutput['comments']; summary: string };
        }
      ).object;
      return {
        comments: data.comments,
        summary: data.summary,
        tokensUsed: { input: inputTokens, output: outputTokens },
        costUsd,
      };
    },
    estimateCost: async (
      input: ReviewInput,
    ): Promise<{ inputTokens: number; estimatedUsd: number }> => {
      const promptText = `${input.systemPrompt}\n${composeUserPrompt(input)}`;
      const inputTokens = tokenize(promptText);
      const price = priceForModel(shape.pricing, model);
      return {
        inputTokens,
        estimatedUsd: (inputTokens / 1_000_000) * price.inputPerMTok,
      };
    },
    pricePerMillionTokens: () => {
      const price = priceForModel(shape.pricing, model);
      return { input: price.inputPerMTok, output: price.outputPerMTok };
    },
    classifyError: shape.classifyError,
  };
}

// Shared HTTP-status-based classifier for OpenAI-shaped APIs.
// Handles 429 / 500 / 503 / 401 / 403 + context-length keyword + the
// common Node network error codes. Each provider tweaks via wrapper.
export function classifyHttpStyleError(err: unknown): ErrorClassification {
  if (looksLikeContextLength(err)) return { kind: 'context_length' };
  const status = readStatus(err);
  if (status === 429) {
    const ms = readHeader(err, 'retry-after-ms');
    if (ms !== null) {
      const n = Number.parseFloat(ms);
      if (Number.isFinite(n)) return { kind: 'rate_limit', retryAfterMs: n };
    }
    const sec = readHeader(err, 'retry-after');
    if (sec !== null) {
      const n = Number.parseFloat(sec);
      if (Number.isFinite(n)) return { kind: 'rate_limit', retryAfterMs: n * 1000 };
    }
    return { kind: 'rate_limit' };
  }
  if (status === 500 || status === 503) return { kind: 'overloaded' };
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (looksLikeNetworkError(err)) return { kind: 'transient' };
  return { kind: 'fatal' };
}

function readStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return null;
}

function readHeader(err: unknown, name: string): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as { headers?: unknown; responseHeaders?: unknown };
  for (const bag of [candidate.headers, candidate.responseHeaders]) {
    if (typeof bag !== 'object' || bag === null) continue;
    const value =
      (bag as Record<string, unknown>)[name] ??
      (bag as Record<string, unknown>)[name.toLowerCase()];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function readErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as { code?: unknown; error?: { code?: unknown }; type?: unknown };
  if (typeof candidate.code === 'string') return candidate.code;
  if (typeof candidate.error?.code === 'string') return candidate.error.code;
  if (typeof candidate.type === 'string') return candidate.type;
  return null;
}

function looksLikeContextLength(err: unknown): boolean {
  const code = readErrorCode(err);
  if (code === 'context_length_exceeded') return true;
  if (typeof err !== 'object' || err === null) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /context.{0,5}length|maximum context length|too long for the model|tokens? exceeds|exceeds.{0,10}context window/i.test(
    message,
  );
}

function looksLikeNetworkError(err: unknown): boolean {
  const code = readErrorCode(err);
  if (!code) return false;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
}
