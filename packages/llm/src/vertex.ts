import { VERTEX_PRICING } from './pricing.js';
import {
  classifyHttpStyleError,
  createGenericProvider,
  type ProviderDriverDeps,
  type ProviderShape,
} from './provider-base.js';
import type { LlmProvider, ProviderConfig } from './types.js';

// Vertex AI on GCP. Auth via Application Default Credentials (ADC):
// service-account JSON via GOOGLE_APPLICATION_CREDENTIALS, or
// Workload Identity Federation when running in another cloud.
//
// Hosts both Anthropic Claude and Google Gemini behind the same
// pricing table (VERTEX_PRICING merges both).

export type VertexDriverDeps = ProviderDriverDeps & {
  readonly modelForRequest?: (model: string) => unknown;
};

export async function createVertexProvider(
  config: ProviderConfig,
  deps: VertexDriverDeps = {},
): Promise<LlmProvider> {
  if (config.type !== 'vertex') {
    throw new Error(`createVertexProvider received provider.type='${config.type}'`);
  }
  if (!config.model) throw new Error('createVertexProvider requires config.model');
  if (!config.vertexProjectId) {
    throw new Error('createVertexProvider requires config.vertexProjectId');
  }
  const region = config.region ?? process.env.CLOUD_ML_REGION ?? 'us-central1';

  const modelForRequest =
    deps.modelForRequest ??
    (await defaultVertexModelFactory({ project: config.vertexProjectId, location: region }));
  const shape: ProviderShape<unknown> = {
    name: 'vertex',
    pricing: VERTEX_PRICING,
    classifyError: classifyHttpStyleError,
    modelForRequest,
  };
  return createGenericProvider(shape, config.model, deps);
}

async function defaultVertexModelFactory(opts: {
  project: string;
  location: string;
}): Promise<(model: string) => unknown> {
  const mod = (await import('@ai-sdk/google-vertex')) as {
    createVertex: (opts: { project: string; location: string }) => (model: string) => unknown;
  };
  const vertex = mod.createVertex({ project: opts.project, location: opts.location });
  return (model) => vertex(model);
}
