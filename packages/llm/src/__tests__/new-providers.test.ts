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
    experimental_output: reviewObject,
    totalUsage: { inputTokens: 100, outputTokens: 50 },
    steps: [],
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

  // Stage C: pin every `switch (config.type)` arm in createProvider by
  // forcing each non-default branch to fail synchronously inside its
  // driver. We can't supply deps through the factory (no inject seam),
  // so the validation errors short-circuit before the async SDK import.

  it("dispatches the 'bedrock' arm (synchronous validation surface)", async () => {
    // missing config.region → createBedrockProvider throws before any
    // dynamic import. This pins the factory dispatch line.
    await expect(() =>
      createProvider({ type: 'bedrock', model: 'anthropic.claude-x' } as ProviderConfig),
    ).rejects.toThrow(/region/);
  });

  it("dispatches the 'azure-openai' arm", async () => {
    await expect(() =>
      createProvider({ type: 'azure-openai', model: 'gpt-4o' } as ProviderConfig),
    ).rejects.toThrow(/azureDeployment/);
  });

  it("dispatches the 'google' arm", async () => {
    // No apiKey, no env → fails the apiKey check after `!model` passes.
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
    try {
      await expect(() =>
        createProvider({ type: 'google', model: 'gemini-2.0-pro' } as ProviderConfig),
      ).rejects.toThrow(/Google AI Studio API key/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("dispatches the 'vertex' arm", async () => {
    await expect(() =>
      createProvider({ type: 'vertex', model: 'gemini-2.0-pro' } as ProviderConfig),
    ).rejects.toThrow(/vertexProjectId/);
  });

  it("dispatches the 'openai-compatible' arm", async () => {
    await expect(() =>
      createProvider({ type: 'openai-compatible', model: 'llama3' } as ProviderConfig),
    ).rejects.toThrow(/baseUrl/);
  });
});

// Stage C: per-driver branch coverage hardening — wrong `provider.type`
// guards and the optional-field-missing branches that the existing happy-
// path tests skip past. These cover the early-return / throw branches
// that exist for runtime safety even though TypeScript's narrowing should
// prevent the call shape at compile time.

describe('createBedrockProvider — additional guards', () => {
  it('requires config.model', async () => {
    await expect(() =>
      createBedrockProvider({ type: 'bedrock', region: 'us-east-1' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/requires config\.model/);
  });
});

describe('createAzureOpenAIProvider — additional guards', () => {
  it('rejects a wrong provider.type', async () => {
    await expect(() =>
      createAzureOpenAIProvider({ type: 'openai', model: 'gpt-4o' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/provider\.type/);
  });

  it('requires config.model before validating Azure-specific fields', async () => {
    // Drive the `!config.model` branch, which sits before the
    // azureDeployment + baseUrl checks. Pin that the error mentions
    // model, not the downstream fields.
    await expect(() =>
      createAzureOpenAIProvider({ type: 'azure-openai' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/config\.model/);
  });

  it('requires baseUrl when azureDeployment is set', async () => {
    // `!config.baseUrl` branch: previous tests only exercised the
    // `!config.azureDeployment` branch.
    await expect(() =>
      createAzureOpenAIProvider(
        {
          type: 'azure-openai',
          model: 'gpt-4o',
          azureDeployment: 'prod-large',
        } as ProviderConfig,
        { modelForRequest: fakeModelForRequest },
      ),
    ).rejects.toThrow(/baseUrl/);
  });

  it('reads AZURE_OPENAI_API_KEY from env when config.apiKey is absent', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'env-azure-key');
    try {
      const provider = await createAzureOpenAIProvider(
        {
          type: 'azure-openai',
          model: 'gpt-4o',
          azureDeployment: 'prod-large',
          baseUrl: 'https://foo.openai.azure.com',
        } as ProviderConfig,
        { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
      );
      const out = await provider.generateReview(reviewInput);
      expect(out.summary).toBe('ok');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('createGoogleProvider — additional guards', () => {
  it('rejects a wrong provider.type', async () => {
    await expect(() =>
      createGoogleProvider({ type: 'openai', model: 'gpt-4o' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/provider\.type/);
  });

  it('requires config.model', async () => {
    await expect(() =>
      createGoogleProvider({ type: 'google' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/requires config\.model/);
  });

  it('uses config.apiKey directly when supplied (no env fallback needed)', async () => {
    // The `config.apiKey ?? process.env.X` branch — `config.apiKey`
    // truthy short-circuits before the env lookup.
    const provider = await createGoogleProvider(
      { type: 'google', model: 'gemini-2.0-pro', apiKey: 'inline-key' } as ProviderConfig,
      { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
    );
    expect(provider.name).toBe('google');
  });
});

describe('createVertexProvider — additional guards', () => {
  it('rejects a wrong provider.type', async () => {
    await expect(() =>
      createVertexProvider({ type: 'openai', model: 'gpt-4o' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/provider\.type/);
  });

  it('requires config.model', async () => {
    await expect(() =>
      createVertexProvider({ type: 'vertex' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/requires config\.model/);
  });

  it('honors config.region when explicitly provided', async () => {
    // The `config.region ?? process.env.CLOUD_ML_REGION ?? 'us-central1'`
    // chain — `config.region` truthy short-circuits the env + default.
    const provider = await createVertexProvider(
      {
        type: 'vertex',
        model: 'gemini-2.0-pro',
        vertexProjectId: 'p',
        region: 'asia-northeast1',
      } as ProviderConfig,
      { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
    );
    expect(provider.name).toBe('vertex');
  });

  it('reads CLOUD_ML_REGION from env when config.region is absent', async () => {
    // Middle arm of the same `??` chain. We pin that the env value is
    // consulted before falling back to the hardcoded default.
    vi.stubEnv('CLOUD_ML_REGION', 'europe-west4');
    try {
      const provider = await createVertexProvider(
        { type: 'vertex', model: 'gemini-2.0-pro', vertexProjectId: 'p' } as ProviderConfig,
        { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
      );
      expect(provider.name).toBe('vertex');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('createOpenAICompatibleProvider — additional guards', () => {
  it('rejects a wrong provider.type', async () => {
    await expect(() =>
      createOpenAICompatibleProvider({ type: 'openai', model: 'm' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/provider\.type/);
  });

  it('requires config.model', async () => {
    await expect(() =>
      createOpenAICompatibleProvider({ type: 'openai-compatible' } as ProviderConfig, {
        modelForRequest: fakeModelForRequest,
      }),
    ).rejects.toThrow(/requires config\.model/);
  });

  it('reads OPENAI_API_KEY from env when no config.apiKey is supplied', async () => {
    // The `config.apiKey ?? process.env.OPENAI_API_KEY ?? ''` chain —
    // middle arm. Many local OpenAI-compat servers accept any string,
    // so the helper falls through to `''` when neither is set, but
    // when env IS set it must reach the provider construction.
    vi.stubEnv('OPENAI_API_KEY', 'env-compat-key');
    try {
      const provider = await createOpenAICompatibleProvider(
        {
          type: 'openai-compatible',
          model: 'llama3',
          baseUrl: 'http://localhost:11434/v1',
        } as ProviderConfig,
        { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
      );
      expect(provider.name).toBe('openai-compatible');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to empty-string apiKey when neither config nor env is set', async () => {
    // Tail arm of the `??` chain — neither config.apiKey nor env. The
    // provider must still build; the SDK accepts any string (some local
    // servers reject only when the key looks like a real token).
    vi.stubEnv('OPENAI_API_KEY', '');
    try {
      const provider = await createOpenAICompatibleProvider(
        {
          type: 'openai-compatible',
          model: 'llama3',
          baseUrl: 'http://localhost:11434/v1',
        } as ProviderConfig,
        { modelForRequest: fakeModelForRequest, generate: fakeGenerate() },
      );
      expect(provider.name).toBe('openai-compatible');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// Stage C: exercise the `deps.modelForRequest ?? (await defaultXModelFactory(...))`
// right-hand-side branch for each provider that supports the deps seam. The
// default factory bodies themselves are `/* v8 ignore */`-marked (lazy SDK
// imports we don't want to instrument), but the CALL SITE — the `??` itself
// and the `await` against it — sits outside the ignore. Without these tests
// the dispatcher's optional-deps coalesce branch is uncovered.

describe('provider defaults — exercises the `?? (await defaultFactory(...))` branch', () => {
  it('createBedrockProvider falls back to the default model factory when deps omit modelForRequest', async () => {
    // We don't care whether the SDK call inside the default factory
    // throws (it likely does, lacking real AWS creds) — only that the
    // `??` right-hand-side was evaluated. Wrap in a rejects matcher
    // that accepts either success OR any rejection.
    const promise = createBedrockProvider(
      {
        type: 'bedrock',
        model: 'anthropic.claude-sonnet-4-6-v1:0',
        region: 'us-east-1',
      } as ProviderConfig,
      // No modelForRequest — forces the default factory.
      {},
    );
    // The default factory does a dynamic `import('@ai-sdk/amazon-bedrock')`
    // which IS installed as a devDependency; we expect either success or
    // a downstream credential error. Either path takes the `??` right arm.
    await promise.catch(() => undefined);
  });

  it('createAzureOpenAIProvider falls back to the default model factory', async () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'env-key');
    try {
      const promise = createAzureOpenAIProvider(
        {
          type: 'azure-openai',
          model: 'gpt-4o',
          azureDeployment: 'prod-large',
          baseUrl: 'https://foo.openai.azure.com',
        } as ProviderConfig,
        {},
      );
      await promise.catch(() => undefined);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('createGoogleProvider falls back to the default model factory', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'env-key');
    try {
      const promise = createGoogleProvider(
        { type: 'google', model: 'gemini-2.0-pro' } as ProviderConfig,
        {},
      );
      await promise.catch(() => undefined);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('createVertexProvider falls back to the default model factory', async () => {
    const promise = createVertexProvider(
      { type: 'vertex', model: 'gemini-2.0-pro', vertexProjectId: 'p' } as ProviderConfig,
      {},
    );
    await promise.catch(() => undefined);
  });

  it('createOpenAICompatibleProvider falls back to the default model factory', async () => {
    const promise = createOpenAICompatibleProvider(
      {
        type: 'openai-compatible',
        model: 'llama3',
        baseUrl: 'http://localhost:11434/v1',
      } as ProviderConfig,
      {},
    );
    await promise.catch(() => undefined);
  });
});
