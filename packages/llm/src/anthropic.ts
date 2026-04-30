import { createAnthropic } from '@ai-sdk/anthropic';
import { ReviewOutputSchema } from '@review-agent/core';
import { generateObject } from 'ai';
import { ANTHROPIC_PRICING, priceForModel } from './pricing.js';
import type {
  ErrorClassification,
  LlmProvider,
  ProviderConfig,
  ReviewInput,
  ReviewOutput,
} from './types.js';

const DEFAULT_TEMPERATURE = 0.2;
const FALLBACK_CHARS_PER_TOKEN = 4;

type AnthropicClient = ReturnType<typeof createAnthropic>;
type GenerateObject = typeof generateObject;

export type AnthropicDriverDeps = {
  readonly createClient?: typeof createAnthropic;
  readonly generate?: GenerateObject;
  readonly tokenize?: (text: string) => number;
};

export type AnthropicProvider = LlmProvider;

function approximateTokens(text: string): number {
  return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
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

function looksLikeContextLength(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return /context.{0,5}length|too long|maximum context|prompt is too long/i.test(message);
}

function looksLikeNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];
  return typeof code === 'string' && networkCodes.includes(code);
}

export function classifyAnthropicError(err: unknown): ErrorClassification {
  const status = readStatus(err);
  if (status === 429) {
    const retryAfter = readHeader(err, 'retry-after');
    const retryAfterMs = retryAfter ? Number.parseFloat(retryAfter) * 1000 : undefined;
    return retryAfterMs !== undefined && Number.isFinite(retryAfterMs)
      ? { kind: 'rate_limit', retryAfterMs }
      : { kind: 'rate_limit' };
  }
  if (status === 529) return { kind: 'overloaded' };
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (looksLikeContextLength(err)) return { kind: 'context_length' };
  if (looksLikeNetworkError(err)) return { kind: 'transient' };
  return { kind: 'fatal' };
}

export function createAnthropicProvider(
  config: ProviderConfig,
  deps: AnthropicDriverDeps = {},
): AnthropicProvider {
  if (config.type !== 'anthropic') {
    throw new Error(`createAnthropicProvider received provider.type='${config.type}'`);
  }
  if (!config.model) throw new Error('createAnthropicProvider requires config.model');

  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Anthropic API key not configured. Set ANTHROPIC_API_KEY env or provide config.apiKey.',
    );
  }

  const createClient = deps.createClient ?? createAnthropic;
  const client: AnthropicClient = createClient({ apiKey });
  const doGenerate = deps.generate ?? generateObject;
  const tokenize = deps.tokenize ?? approximateTokens;
  const cacheControl = config.anthropicCacheControl !== false;

  const pricePerMillionTokens = (): { input: number; output: number } => {
    const price = priceForModel(ANTHROPIC_PRICING, config.model);
    return { input: price.inputPerMTok, output: price.outputPerMTok };
  };

  const generateReview = async (input: ReviewInput): Promise<ReviewOutput> => {
    const userPrompt = composeUserPrompt(input);
    const messages = composeMessages(input.systemPrompt, userPrompt, cacheControl);
    const result = await doGenerate({
      model: client(config.model),
      schema: ReviewOutputSchema,
      // biome-ignore lint/suspicious/noExplicitAny: AI SDK message typing differs across providers; we hand-shape the array to spec.
      messages: messages as any,
      temperature: DEFAULT_TEMPERATURE,
    });
    const usage = (result as { usage?: { promptTokens?: number; completionTokens?: number } })
      .usage ?? { promptTokens: 0, completionTokens: 0 };
    const promptTokens = usage.promptTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    const price = priceForModel(ANTHROPIC_PRICING, config.model);
    const costUsd =
      (promptTokens / 1_000_000) * price.inputPerMTok +
      (completionTokens / 1_000_000) * price.outputPerMTok;
    const data = (result as { object: { comments: ReviewOutput['comments']; summary: string } })
      .object;
    return {
      comments: data.comments,
      summary: data.summary,
      tokensUsed: { input: promptTokens, output: completionTokens },
      costUsd,
    };
  };

  const estimateCost = async (
    input: ReviewInput,
  ): Promise<{ inputTokens: number; estimatedUsd: number }> => {
    const promptText = `${input.systemPrompt}\n${composeUserPrompt(input)}`;
    const inputTokens = tokenize(promptText);
    const price = priceForModel(ANTHROPIC_PRICING, config.model);
    return {
      inputTokens,
      estimatedUsd: (inputTokens / 1_000_000) * price.inputPerMTok,
    };
  };

  return {
    name: 'anthropic',
    model: config.model,
    generateReview,
    estimateCost,
    pricePerMillionTokens,
    classifyError: classifyAnthropicError,
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

type MessagePart =
  | { readonly type: 'text'; readonly text: string; readonly providerOptions?: object }
  | { readonly type: 'text'; readonly text: string };

type Message = {
  readonly role: 'system' | 'user';
  readonly content: ReadonlyArray<MessagePart>;
};

function composeMessages(
  systemPrompt: string,
  userPrompt: string,
  cacheControl: boolean,
): ReadonlyArray<Message> {
  const systemPart: MessagePart = cacheControl
    ? {
        type: 'text',
        text: systemPrompt,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      }
    : { type: 'text', text: systemPrompt };
  return [
    { role: 'system', content: [systemPart] },
    { role: 'user', content: [{ type: 'text', text: userPrompt }] },
  ];
}
