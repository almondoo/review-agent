import { createOpenAI } from '@ai-sdk/openai';
import { ReviewOutputSchema } from '@review-agent/core';
import { generateText, Output, stepCountIs, type ToolSet } from 'ai';
import { getEncoding } from 'js-tiktoken';
import { OPENAI_PRICING, priceForModel } from './pricing.js';
import { countToolCalls } from './provider-base.js';
import type {
  ErrorClassification,
  LlmProvider,
  ProviderConfig,
  ReviewInput,
  ReviewOutput,
} from './types.js';

const DEFAULT_TEMPERATURE = 0.2;
const FALLBACK_CHARS_PER_TOKEN = 4;
/**
 * Default upper bound on agent-loop steps when `ReviewInput.maxToolCalls`
 * is not set. Mirrors `MAX_TOOL_CALLS` in `@review-agent/runner`.
 */
const DEFAULT_MAX_TOOL_CALLS = 20;

type OpenAIClient = ReturnType<typeof createOpenAI>;
type GenerateText = typeof generateText;
type Tokenizer = (text: string) => number;

export type OpenAIDriverDeps = {
  readonly createClient?: typeof createOpenAI;
  readonly generate?: GenerateText;
  readonly tokenize?: Tokenizer;
};

export type OpenAIProvider = LlmProvider;

function approximateTokens(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
}

let cachedTiktoken: Tokenizer | null | undefined;

function tryLoadTiktoken(): Tokenizer | null {
  if (cachedTiktoken !== undefined) return cachedTiktoken;
  try {
    const encoder = getEncoding('cl100k_base');
    cachedTiktoken = (text: string): number => encoder.encode(text).length;
    return cachedTiktoken;
  } catch {
    /* v8 ignore next -- defensive fallback if js-tiktoken's WASM init fails on a runtime */
    cachedTiktoken = null;
    /* v8 ignore next */
    return null;
  }
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
  return /context.{0,5}length|maximum context length|too long for the model/i.test(message);
}

function looksLikeNetworkError(err: unknown): boolean {
  const code = readErrorCode(err);
  if (!code) return false;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
}

export function classifyOpenAIError(err: unknown): ErrorClassification {
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

export function createOpenAIProvider(
  config: ProviderConfig,
  deps: OpenAIDriverDeps = {},
): OpenAIProvider {
  if (config.type !== 'openai') {
    throw new Error(`createOpenAIProvider received provider.type='${config.type}'`);
  }
  if (!config.model) throw new Error('createOpenAIProvider requires config.model');

  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI API key not configured. Set OPENAI_API_KEY env or provide config.apiKey.',
    );
  }

  const createClient = deps.createClient ?? createOpenAI;
  const clientOpts: { apiKey: string; baseURL?: string } = { apiKey };
  if (config.baseUrl) clientOpts.baseURL = config.baseUrl;
  const client: OpenAIClient = createClient(clientOpts);
  const doGenerate = deps.generate ?? generateText;
  const tokenize = deps.tokenize ?? tryLoadTiktoken() ?? approximateTokens;

  const pricePerMillionTokens = (): { input: number; output: number } => {
    const price = priceForModel(OPENAI_PRICING, config.model);
    return { input: price.inputPerMTok, output: price.outputPerMTok };
  };

  const generateReview = async (input: ReviewInput): Promise<ReviewOutput> => {
    const userPrompt = composeUserPrompt(input);
    const tools = (input.tools ?? {}) as ToolSet;
    const maxSteps = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const result = await doGenerate({
      model: client(config.model),
      tools,
      stopWhen: stepCountIs(maxSteps),
      experimental_output: Output.object({ schema: ReviewOutputSchema }),
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: DEFAULT_TEMPERATURE,
    });
    const usage =
      (result as { totalUsage?: { inputTokens?: number; outputTokens?: number } }).totalUsage ??
      (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage ??
      {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const price = priceForModel(OPENAI_PRICING, config.model);
    const costUsd =
      (inputTokens / 1_000_000) * price.inputPerMTok +
      (outputTokens / 1_000_000) * price.outputPerMTok;
    const data = (
      result as {
        experimental_output: { comments: ReviewOutput['comments']; summary: string };
      }
    ).experimental_output;
    return {
      comments: data.comments,
      summary: data.summary,
      tokensUsed: { input: inputTokens, output: outputTokens },
      costUsd,
      toolCalls: countToolCalls(result),
    };
  };

  const estimateCost = async (
    input: ReviewInput,
  ): Promise<{ inputTokens: number; estimatedUsd: number }> => {
    const promptText = `${input.systemPrompt}\n${composeUserPrompt(input)}`;
    const inputTokens = tokenize(promptText);
    const price = priceForModel(OPENAI_PRICING, config.model);
    return {
      inputTokens,
      estimatedUsd: (inputTokens / 1_000_000) * price.inputPerMTok,
    };
  };

  return {
    name: 'openai',
    model: config.model,
    generateReview,
    estimateCost,
    pricePerMillionTokens,
    classifyError: classifyOpenAIError,
  };
}

function composeUserPrompt(input: ReviewInput): string {
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
