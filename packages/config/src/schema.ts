import { CONFIDENCES } from '@review-agent/core';
import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from './languages.js';

const ProviderSchema = z
  .object({
    type: z.enum([
      'anthropic',
      'openai',
      'azure-openai',
      'google',
      'vertex',
      'bedrock',
      'openai-compatible',
    ]),
    model: z.string().min(1),
    fallback_models: z.array(z.string().min(1)).default([]),
    base_url: z.string().url().optional(),
    region: z.string().optional(),
    azure_deployment: z.string().optional(),
    vertex_project_id: z.string().optional(),
    anthropic_cache_control: z.boolean().default(true),
  })
  .strict();

const AutoReviewSchema = z
  .object({
    enabled: z.boolean().default(true),
    drafts: z.boolean().default(false),
    base_branches: z.array(z.string().min(1)).default(['main', 'master', 'develop']),
    paths: z.array(z.string().min(1)).default([]),
  })
  .strict();

const PathInstructionSchema = z
  .object({
    path: z.string().min(1),
    instructions: z.string().min(1),
  })
  .strict();

const ReviewsSchema = z
  .object({
    auto_review: AutoReviewSchema.default({}),
    path_filters: z.array(z.string()).default([]),
    path_instructions: z.array(PathInstructionSchema).default([]),
    max_files: z.number().int().positive().default(50),
    max_diff_lines: z.number().int().positive().default(3000),
    ignore_authors: z
      .array(z.string().min(1))
      .default(['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']),
    // Suppress comments whose model-reported confidence is strictly
    // below this threshold. Default `'low'` means "post everything";
    // operators tighten to `'medium'` to drop hunches or `'high'` to
    // post only the model's strongest findings. Comments emitted
    // without a confidence field are treated as `'high'`.
    min_confidence: z.enum(CONFIDENCES).default('low'),
  })
  .strict();

const CostSchema = z
  .object({
    max_usd_per_pr: z.number().positive().default(1.0),
    hard_stop: z.boolean().default(true),
    daily_cap_usd: z.number().positive().default(50.0),
  })
  .strict();

const PrivacySchema = z
  .object({
    redact_patterns: z.array(z.string().min(1)).default([]),
    deny_paths: z.array(z.string().min(1)).default([]),
    allowed_url_prefixes: z.array(z.string().url()).default([]),
  })
  .strict();

const RepoSchema = z
  .object({
    submodules: z.boolean().default(false),
    lfs: z.boolean().default(false),
  })
  .strict();

const IncrementalSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

// `coordination.other_bots` (§22 #9 / v1.0 #48) controls coexistence with
// other PR-review bots (`coderabbitai[bot]`, `qodo-merge[bot]`, etc.).
//
//   ignore (default)      — review independently; rely on per-finding
//                           fingerprint dedup to avoid duplicate posts
//                           against ourselves but make no attempt to
//                           coordinate across bots.
//   defer_if_present      — if any author in `other_bots_logins` (plus
//                           the built-in allowlist in `known-bots.ts`)
//                           has commented on the PR, post a single
//                           skip-summary and exit without invoking the
//                           agent loop. Useful when an org runs multiple
//                           review bots in parallel and wants to avoid
//                           comment thrash.
//
// `other_bots_logins` *adds to* the built-in list — operators don't lose
// the defaults by overriding. To shrink the list, set the YAML key to
// the desired full list and override the defaults at code level (not
// supported via config).
const CoordinationSchema = z
  .object({
    other_bots: z.enum(['ignore', 'defer_if_present']).default('ignore'),
    other_bots_logins: z.array(z.string().min(1)).default([]),
  })
  .strict();

// `extends: 'org'` (§10.2 layer 3) opts the repo into merging the
// `<org>/.github/review-agent.yml` central config underneath this
// file. Without `extends`, the org file is consulted only as a
// silent fallback when the repo file is absent. We accept the
// keyword form (mirrors ESLint / Prettier) plus the explicit
// `null` to mean "no inheritance", which lets a tenant override
// inherited org config back to defaults.
const ExtendsSchema = z.literal('org').or(z.null()).optional();

export const ConfigSchema = z
  .object({
    extends: ExtendsSchema,
    language: z.enum(SUPPORTED_LANGUAGES).default('en-US'),
    profile: z.enum(['chill', 'assertive']).default('chill'),
    provider: ProviderSchema.optional(),
    reviews: ReviewsSchema.default({}),
    cost: CostSchema.default({}),
    privacy: PrivacySchema.default({}),
    repo: RepoSchema.default({}),
    skills: z.array(z.string().min(1)).default([]),
    incremental: IncrementalSchema.default({}),
    coordination: CoordinationSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
