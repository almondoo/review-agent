import {
  CONFIDENCES,
  isValidGlob,
  REQUEST_CHANGES_THRESHOLDS,
  WORKSPACE_STRATEGIES,
} from '@review-agent/core';
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

// Per-instruction auto-fetch options (`reviews.path_instructions[*].auto_fetch`).
// When the diff touches a file matching the instruction's `path`
// glob, the runner pre-fetches related files via the workspace
// tools so the LLM has the right context without spending tool-call
// budget asking for them. Defaults: tests=true, types=true, siblings=false.
//
// Sibling fetch is opt-in because "sibling files" can be a lot of
// noise on dense directories — operators should turn it on only
// after a path_instruction proves it actually needs it.
const AutoFetchSchema = z
  .object({
    tests: z.boolean().default(true),
    types: z.boolean().default(true),
    siblings: z.boolean().default(false),
  })
  .strict();

const PathInstructionSchema = z
  .object({
    // The `path` field is a glob pattern. We compile it via
    // `globToRegExp` (the same compiler the runner's tool dispatcher
    // uses) so a typo like `src/utils/\*.ts` fails at load time
    // instead of silently never matching. `.refine` runs after the
    // base string-length check so the error path is empty-string →
    // length error, otherwise glob-syntax error.
    path: z.string().min(1).refine(isValidGlob, {
      message:
        'must be a valid glob pattern (`*` within a segment, `**` across segments, no NUL bytes)',
    }),
    instructions: z.string().min(1),
    auto_fetch: AutoFetchSchema.optional(),
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
    // Severity threshold at which the GitHub adapter switches the
    // review event from `COMMENT` to `REQUEST_CHANGES`. Default
    // `'critical'` matches the conservative "block on critical only"
    // semantic. Set to `'major'` to also block on `major` findings
    // (e.g. when wiring this into a branch-protection rule on a
    // release branch), or `'never'` to disable the mapping entirely
    // (every review posts `COMMENT`, regardless of severity).
    request_changes_on: z.enum(REQUEST_CHANGES_THRESHOLDS).default('critical'),
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

// Server-mode workspace provisioning. Only consulted by
// `@review-agent/server`'s `provisionWorkspace` — Action mode ignores
// this section (the GitHub Actions runner does `actions/checkout`
// before the Action runs, so the worktree is already present).
//
// `workspace_strategy` defaults to `'none'` so existing Server
// deployments (v0.2 era) keep working without operator action. To
// turn on the read_file / glob / grep tools in Server mode, operators
// must opt in to `'contents-api'` (cheap, no shell deps) or
// `'sparse-clone'` (richer, requires `git` in the Lambda image).
// See `docs/deployment/aws.md` for the trade-off.
const ServerSchema = z
  .object({
    workspace_strategy: z.enum(WORKSPACE_STRATEGIES).default('none'),
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
    server: ServerSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
