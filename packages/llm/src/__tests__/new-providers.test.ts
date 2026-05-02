import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAzureOpenAIProvider } from '../azure-openai.js';
import { createBedrockProvider } from '../bedrock.js';
import { createProvider } from '../factory.js';
import { createGoogleProvider } from '../google.js';
import { createOpenAICompatibleProvider } from '../openai-compatible.js';
import type { ProviderConfig, ReviewInput } from '../types.js';
import { createVertexProvider } from '../vertex.js';

const reviewInput: ReviewInput = {
  systemPrompt: 'You are an expert reviewer.',
  diffText: 'diff --git a/x b/x',
  prMetadata: { title: 'T', body: 'B', author: 'a' },
  fileReader: async () => '',
  language: 'en-US',
};

const reviewObject = {
  summary: 'ok',
  comments: [
    { path: 'a.ts', line: 1, side: 'RIGHT' as const, body: 'fine', severity: 'info' as const },
  ],
};

function fakeGenerate() {
  return vi.fn(async () => ({
    object: reviewObject,
    usage: { inputTokens: 100, outputTokens: 50 },
  })) as never;
}

const fakeModelForRequest = vi.fn((m: string) => ({ tag: m }));

describe('createBedrockProvider', () => {
  it('rejects wrong provider.type', async () => {
    await expect(() =>
      createBedrockProvider({ type: 'openai', model: 'm' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
        generate: fakeGenerate(),
      }),
    ).rejects.toThrow(/Bedrock/i);
  });

  it('requires region', async () => {
    await expect(() =>
      createBedrockProvider(
        { type: 'bedrock', model: 'anthropic.claude-sonnet-4-6-v1:0' } as ProviderConfig,
        { modelForRequest: fakeModelForRequest },
      ),
    ).rejects.toThrow(/region/);
  });

  it('round-trips a review through the injected model factory', async () => {
    const provider = await createBedrockProvider(
      {
        type: 'bedrock',
        model: 'anthropic.claude-sonnet-4-6-v1:0',
        region: 'us-east-1',
      } as ProviderConfig,
      { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
    );
    const out = await provider.generateReview(reviewInput);
    expect(out.summary).toBe('ok');
    expect(provider.name).toBe('bedrock');
  });
});

describe('createAzureOpenAIProvider', () => {
  beforeEach(() => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires baseUrl + azureDeployment + model', async () => {
    await expect(() =>
      createAzureOpenAIProvider({ type: 'azure-openai', model: 'gpt-4o' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/azureDeployment/);
  });

  it('requires API key when env is unset', async () => {
    await expect(() =>
      createAzureOpenAIProvider(
        {
          type: 'azure-openai',
          model: 'gpt-4o',
          azureDeployment: 'prod-large',
          baseUrl: 'https://foo.openai.azure.com',
        } as ProviderConfig,
        { modelForRequest: fakeModelForRequest },
      ),
    ).rejects.toThrow(/Azure OpenAI API key/);
  });

  it('builds a working provider given all fields', async () => {
    const provider = await createAzureOpenAIProvider(
      {
        type: 'azure-openai',
        model: 'gpt-4o',
        apiKey: 'k',
        azureDeployment: 'prod-large',
        baseUrl: 'https://foo.openai.azure.com',
      } as ProviderConfig,
      { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
    );
    const out = await provider.generateReview(reviewInput);
    expect(out.tokensUsed.input).toBe(100);
  });
});

describe('createGoogleProvider', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires API key when env is unset', async () => {
    await expect(() =>
      createGoogleProvider({ type: 'google', model: 'gemini-2.0-pro' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/Google AI Studio API key/);
  });

  it('uses GOOGLE_GENERATIVE_AI_API_KEY env when present and routes the model through the factory', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'env-key');
    const modelForRequest = vi.fn((m: string) => ({ tag: m }));
    const provider = await createGoogleProvider(
      { type: 'google', model: 'gemini-2.0-pro' } as ProviderConfig,
      { modelForRequest, generate: fakeGenerate() },
    );
    expect(provider.name).toBe('google');
    const out = await provider.generateReview(reviewInput);
    // Pin that the configured model literally reaches the SDK factory.
    expect(modelForRequest).toHaveBeenCalledWith('gemini-2.0-pro');
    expect(out.tokensUsed).toEqual({ input: 100, output: 50 });
  });
});

describe('createVertexProvider', () => {
  it('requires vertexProjectId', async () => {
    await expect(() =>
      createVertexProvider({ type: 'vertex', model: 'gemini-2.0-pro' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/vertexProjectId/);
  });

  it('defaults region to us-central1 when not set', async () => {
    const provider = await createVertexProvider(
      {
        type: 'vertex',
        model: 'gemini-2.0-pro',
        vertexProjectId: 'p',
      } as ProviderConfig,
      { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
    );
    expect(provider.name).toBe('vertex');
    const out = await provider.generateReview(reviewInput);
    expect(out.summary).toBe('ok');
  });
});

describe('createOpenAICompatibleProvider', () => {
  it('requires baseUrl', async () => {
    await expect(() =>
      createOpenAICompatibleProvider(
        { type: 'openai-compatible', model: 'llama3' } as ProviderConfig,
        { modelForRequest: fakeModelForRequest },
      ),
    ).rejects.toThrow(/baseUrl/);
  });

  it('treats unknown models as zero-cost (operator overrides via config)', async () => {
    const provider = await createOpenAICompatibleProvider(
      {
        type: 'openai-compatible',
        model: 'nobody-prices-this-model',
        baseUrl: 'http://localhost:11434/v1',
      } as ProviderConfig,
      { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
    );
    const out = await provider.generateReview(reviewInput);
    expect(out.costUsd).toBe(0);
    expect(provider.pricePerMillionTokens()).toEqual({ input: 0, output: 0 });
  });
});

describe('createProvider (factory)', () => {
  it('dispatches anthropic without async SDK injection', async () => {
    const provider = await createProvider({
      type: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    } as ProviderConfig);
    expect(provider.name).toBe('anthropic');
  });

  it('dispatches openai without async SDK injection', async () => {
    const provider = await createProvider({
      type: 'openai',
      model: 'gpt-4o',
      apiKey: 'k',
    } as ProviderConfig);
    expect(provider.name).toBe('openai');
  });

  it('throws on an unknown type', async () => {
    await expect(() =>
      createProvider({ type: 'made-up' as never, model: 'm' } as ProviderConfig),
    ).rejects.toThrow(/Unsupported provider/);
  });
});
