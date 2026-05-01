import { AZURE_OPENAI_PRICING } from './pricing.js';
import {
  classifyHttpStyleError,
  createGenericProvider,
  type ProviderDriverDeps,
  type ProviderShape,
} from './provider-base.js';
import type { LlmProvider, ProviderConfig } from './types.js';

// Azure OpenAI — OpenAI-shaped API hosted on Azure. Uses the
// operator-supplied **deployment name** (config.azureDeployment) as
// the request target; the model id we surface back via
// `LlmProvider.model` is the underlying OpenAI model so pricing
// lookups work against AZURE_OPENAI_PRICING.
//
// The deployment-name + model-id split exists because Azure lets
// operators give arbitrary names to deployed models (e.g. an
// ops-team-managed `gpt-4o-2024-11` deployment named `prod-large`).
// The chart / Terraform examples surface this as the
// `provider.azure_deployment` config field.

export type AzureOpenAIDriverDeps = ProviderDriverDeps & {
  readonly modelForRequest?: (model: string) => unknown;
};

export async function createAzureOpenAIProvider(
  config: ProviderConfig,
  deps: AzureOpenAIDriverDeps = {},
): Promise<LlmProvider> {
  if (config.type !== 'azure-openai') {
    throw new Error(`createAzureOpenAIProvider received provider.type='${config.type}'`);
  }
  if (!config.model) {
    throw new Error(
      'createAzureOpenAIProvider requires config.model (the underlying OpenAI model id)',
    );
  }
  if (!config.azureDeployment) {
    throw new Error(
      'createAzureOpenAIProvider requires config.azureDeployment (the Azure deployment name)',
    );
  }
  if (!config.baseUrl) {
    throw new Error(
      'createAzureOpenAIProvider requires config.baseUrl (the Azure resource endpoint, e.g. https://<resource>.openai.azure.com)',
    );
  }
  const apiKey = config.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Azure OpenAI API key not configured. Set AZURE_OPENAI_API_KEY env or provide config.apiKey.',
    );
  }

  const modelForRequest =
    deps.modelForRequest ??
    (await defaultAzureModelFactory({
      apiKey,
      baseUrl: config.baseUrl,
      deployment: config.azureDeployment,
    }));
  const shape: ProviderShape<unknown> = {
    name: 'azure-openai',
    pricing: AZURE_OPENAI_PRICING,
    classifyError: classifyHttpStyleError,
    modelForRequest,
  };
  return createGenericProvider(shape, config.model, deps);
}

async function defaultAzureModelFactory(opts: {
  apiKey: string;
  baseUrl: string;
  deployment: string;
}): Promise<(model: string) => unknown> {
  const mod = (await import('@ai-sdk/azure')) as {
    createAzure: (opts: {
      apiKey: string;
      resourceName?: string;
      baseURL?: string;
    }) => (deployment: string) => unknown;
  };
  // Azure SDK accepts either `resourceName` (which it converts to
  // `https://<name>.openai.azure.com`) or `baseURL` directly. We
  // pass baseURL so config control stays with the operator.
  const azure = mod.createAzure({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
  // The Azure SDK's call signature is `azure(deploymentName)` —
  // model id only comes back into play for pricing. Ignore the
  // model arg and route by deployment.
  return (_model) => azure(opts.deployment);
}
