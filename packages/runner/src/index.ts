export { runReview } from './agent.js';
export {
  applyRedactions,
  defaultSpawn,
  type GitleaksFinding,
  type GitleaksResult,
  quickScanContent,
  type ScanDiffOptions,
  type SpawnFn,
  scanWorkspaceWithGitleaks,
  shouldAbortReview,
} from './gitleaks.js';
export {
  type CostGuardOptions,
  type CostState,
  createCostGuard,
  createInjectionGuard,
  type DedupOptions,
  type DedupResult,
  dedupComments,
  type InjectionGuardOptions,
} from './middleware/index.js';
export { type ComposeSystemPromptOptions, composeSystemPrompt } from './prompts/system-prompt.js';
export { type UntrustedMetadata, wrapUntrusted } from './prompts/untrusted.js';
export { type BuildStateInput, buildReviewState } from './state-builder.js';
export {
  createTools,
  dispatchTool,
  TOOL_NAMES,
  type ToolDeps,
  type ToolName,
  type Tools,
} from './tools.js';
export type {
  Middleware,
  MiddlewareCtx,
  ReviewJob,
  RunnerResult,
  RunReviewDeps,
} from './types.js';
