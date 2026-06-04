import {
  CATEGORIES,
  CONFIDENCES,
  isValidGlob,
  isValidRegex,
  REQUEST_CHANGES_THRESHOLDS,
  SEVERITIES,
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
    /**
     * Label-based trigger (#157): review fires when *any* of these labels
     * is applied to the PR (`labeled` action). An empty list (default)
     * means label-based triggering is disabled; push/command triggers still
     * apply normally.
     */
    trigger_labels: z.array(z.string().min(1)).default([]),
    /**
     * Label-based skip (#157): auto-review is suppressed when *any* of
     * these labels is currently on the PR. Checked on every push-triggered
     * auto-review; commands (`/review`) are **not** affected by skip_labels
     * (an explicit command always wins). An empty list (default) means no
     * labels suppress review.
     */
    skip_labels: z.array(z.string().min(1)).default([]),
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
    // Maximum number of agent steps (LLM round-trips + tool-call
    // round-trips) before the runner terminates the loop. Maps to
    // `stopWhen: stepCountIs(N)` in the Vercel AI SDK call. Bounds
    // (1–50) are enforced at parse time so an out-of-range YAML value
    // is rejected immediately with an actionable error. Default 20
    // matches the historical hard-coded `MAX_TOOL_CALLS` constant in
    // `packages/runner/src/tools.ts` — preserves existing behaviour
    // for operators who have not set this key. Precedence:
    //   repo/org YAML > env REVIEW_AGENT_MAX_STEPS > built-in default
    // (see `loader.ts` `mergeWithEnvMaxSteps`).
    max_steps: z.number().int().min(1).max(50).default(20),
    // Maximum back-and-forth conversation turns on a single inline-comment
    // thread (#149) before the agent posts a single "conversation limit
    // reached" note and stops replying. A "turn" is one agent reply to a
    // human `@review-agent` mention on the agent's own finding. Bounded
    // (1–50) and cost-capped (turns count against the PR cost ledger).
    // Default 5 keeps threads bounded without feeling abrupt.
    max_conversation_turns: z.number().int().min(1).max(50).default(5),
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
    // Each entry is a regular-expression pattern lifted into a
    // gitleaks `[[rules]]` custom-rule block by the runner (spec
    // §7.4) and also applied in-process by `quickScanContent` when
    // gitleaks itself is unavailable. `.refine(isValidRegex)` rejects
    // empty strings (also caught by `.min(1)`), NUL-byte payloads,
    // and patterns `new RegExp` cannot compile (unbalanced bracket,
    // lone quantifier, etc.) at YAML load time so the operator sees
    // the misconfiguration immediately rather than at scan time.
    redact_patterns: z
      .array(
        z.string().min(1).refine(isValidRegex, {
          message: 'redact_patterns entry must be a valid regular expression',
        }),
      )
      .default([]),
    // Each entry is a glob pattern compiled by `globToRegExp` at
    // runtime (`packages/runner/src/agent.ts`) and unioned with the
    // built-in `DENY_PATTERNS` in the tool dispatcher (spec §7.4
    // "extend, not relax"). `.refine(isValidGlob)` mirrors
    // `path_instructions[*].path`. It rejects empty strings (caught
    // earlier by `.min(1)`) and entries containing a NUL byte at
    // YAML load time rather than letting them throw at runtime
    // inside `runReview`'s `globToRegExp` call. It does NOT reject
    // unsupported glob syntax (`[abc]`, `{a,b}`, `?`) — those are
    // escaped as literals by `globToRegExp` and silently match
    // nothing. See `docs/configuration/privacy.md` glob syntax
    // section for the caveat operators need to know about.
    deny_paths: z
      .array(
        z.string().min(1).refine(isValidGlob, {
          message:
            'must be a valid glob pattern (`*` within a segment, `**` across segments, no NUL bytes)',
        }),
      )
      .default([]),
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

// CodeCommit-specific operator options (issue #74). At the moment the
// only field is `approvalState`, which controls whether the CodeCommit
// adapter maps `review.event` to `UpdatePullRequestApprovalState`.
//
//   off (default)  — preserve v0.2 behavior. The adapter ignores
//                    `review.event`; merge-blocking is left to the
//                    operator's approval rules in CodeCommit itself.
//   managed        — translate `APPROVE` → `UpdatePullRequestApprovalState(APPROVE)`
//                    and `REQUEST_CHANGES` → `UpdatePullRequestApprovalState(REVOKE)`.
//                    `COMMENT` is a no-op. Requires the agent's IAM
//                    principal to be a target of an approval rule on
//                    the PR; otherwise the call is a logged no-op.
//
// Other VCS adapters (GitHub, Bitbucket, ...) ignore this section.
const CodecommitSchema = z
  .object({
    approvalState: z.enum(['managed', 'off']).default('off'),
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

// Large-PR / monorepo strategy (#158). Controls how the runner handles PRs
// that exceed the `reviews.max_files` / `reviews.max_diff_lines` caps.
//
//   enabled (default true)     — when true and a PR exceeds the caps, the runner
//                                splits the diff into chunks and reviews each chunk
//                                in sequence (up to `max_chunks`). When false, the
//                                runner uses the legacy skip behaviour (same as
//                                before this feature).
//
//   max_chunks (default 5)     — maximum number of chunks to review per PR. Files
//                                that would be in chunk N+1 are skipped and recorded
//                                in the ExclusionReport with reason='max_chunks_exceeded'.
//
//   prioritization (default ['path_instructions','diff_size']) — ordered list of
//                                criteria used to rank files before chunk assignment.
//                                Supported values:
//                                  'path_instructions' — files matching a
//                                    path_instructions glob are ranked first.
//                                  'diff_size'         — larger diffs (by added+deleted
//                                    line count) are ranked earlier.
//                                  'alphabetical'      — lexicographic tie-break
//                                    (always applied last, implicit).
//
// Cost impact: with enabled=true, a large PR may trigger multiple LLM calls.
// The PR-level cost cap (`cost.max_usd_per_pr`) applies across all chunks; if
// the cap is hit mid-review the remaining files are recorded as budget_exhausted.
const LARGE_PR_PRIORITIZATION_CRITERIA = [
  'path_instructions',
  'diff_size',
  'alphabetical',
] as const;

export const LargePrSchema = z
  .object({
    enabled: z.boolean().default(true),
    max_chunks: z.number().int().positive().default(5),
    prioritization: z
      .array(z.enum(LARGE_PR_PRIORITIZATION_CRITERIA))
      .default(['path_instructions', 'diff_size']),
  })
  .strict();

export type LargePr = z.infer<typeof LargePrSchema>;

// Committable-suggestion gating (#152). Controls which categories of LLM
// suggestions are rendered as GitHub ```suggestion blocks (or equivalent
// informational code blocks on other platforms).
//
//   enabled (default true)   — when false, all `suggestion` fields are stripped
//                              before posting; only the comment body is published.
//   categories (default all) — suggestion blocks are only rendered for findings
//                              whose category is in this list. Findings in other
//                              categories keep their body but lose the suggestion
//                              block. Findings with no category always keep their
//                              suggestion (category-level gating requires a
//                              category to match against).
const SuggestionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    categories: z.array(z.enum(CATEGORIES)).default([...CATEGORIES]),
  })
  .strict();

export type Suggestions = z.infer<typeof SuggestionsSchema>;

// Feedback-loop tuning (#155). `suppress_after` is the number of distinct
// 👎 / `/feedback reject` signals on the same finding fingerprint before a
// persistent suppression rule is created (stored as a `suppression_rule`
// row in `review_history`). Once suppressed, matching findings are dropped
// from future reviews until an operator runs `review-agent suppression
// remove`. Default 3 requires repeated rejection before muting, so a single
// dismissal never permanently hides a class of finding.
const FeedbackSchema = z
  .object({
    suppress_after: z.number().int().min(1).default(3),
  })
  .strict();

export type Feedback = z.infer<typeof FeedbackSchema>;

// Per-category ruleset entry. Each named category can be toggled on/off
// and can enforce a minimum severity floor. Findings whose severity is
// strictly below `min_severity` are suppressed for that category; findings
// whose category has `enabled: false` are suppressed entirely.
//
// Category keys must be one of the values in `CATEGORIES` from
// `@review-agent/core`. Unknown keys are rejected at parse time with a
// Zod "Unrecognized key(s)" error so operators get an actionable message
// (e.g. "ruleset.correctness: Unrecognized key(s)") rather than a silent
// no-op. The known categories are:
//   bug, security, performance, maintainability, style, docs, test
//
// NOTE: the issue body mentions `security/performance/style/tests/correctness`
// as examples. This implementation uses the canonical CATEGORIES from core:
//   - `test` (not `tests`) — matches the core taxonomy.
//   - `bug` + `maintainability` cover what the issue called `correctness`.
// Operators who want to gate on "correctness-class" findings should use
// `bug: { min_severity: major }` and/or `maintainability: { enabled: false }`.
const RulesetCategorySchema = z
  .object({
    enabled: z.boolean().default(true),
    // Severity floor: findings strictly below this rank are suppressed for
    // this category. Default `'info'` means "post everything" (info is the
    // lowest rank so nothing is filtered out by default). Rank order:
    //   critical (3) > major (2) > minor (1) > info (0).
    min_severity: z.enum(SEVERITIES).default('info'),
  })
  .strict();

export type RulesetCategory = z.infer<typeof RulesetCategorySchema>;

// The full ruleset block. Each key is a known category; unknown keys are
// rejected by `.strict()` on the wrapper (via `z.record` + explicit key
// constraint below). We use `z.record(z.enum(CATEGORIES), ...)` so Zod
// rejects unknown category names at parse time.
//
// An empty ruleset (`ruleset: {}`) is valid — all categories default to
// `{ enabled: true, min_severity: 'info' }` which is a no-op filter.
export const RulesetSchema = z.record(z.enum(CATEGORIES), RulesetCategorySchema).default({});

export type Ruleset = z.infer<typeof RulesetSchema>;

// `extends:` (§10.2 / #151) supports three forms:
//
//   extends: org               — org-merge keyword (§10.2 layer 3). Merges
//                                the org `.github/review-agent.yml` below this
//                                config. Backward-compatible with the original
//                                single-keyword form.
//
//   extends: recommended       — a single bundled preset name. The preset is
//                                deep-merged as a base; this config overrides it.
//
//   extends: [recommended, strict]  — a list of preset names. Presets are
//                                merged left-to-right; this config is applied
//                                last (highest priority).
//
//   extends: null              — explicit "no inheritance" opt-out.
//
// NOTE: mixing 'org' inside an array (e.g. [org, recommended]) is not
// supported. 'org' must appear as a scalar keyword. The preset loader
// (`preset-loader.ts`) raises an actionable error if 'org' appears in an
// array extends list.
const ExtendsSchema = z
  .union([z.literal('org'), z.string().min(1), z.array(z.string().min(1)), z.null()])
  .optional();

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
    codecommit: CodecommitSchema.default({}),
    // Per-category ruleset block. Keys are `CATEGORIES` values; each entry
    // has `enabled` (default true) and `min_severity` (default 'info').
    // Findings whose category has `enabled: false` are suppressed; findings
    // below `min_severity` for their category are also suppressed. The runner
    // applies this filter after dedup and min_confidence. An absent `ruleset`
    // key is identical to `ruleset: {}` — no filtering.
    ruleset: RulesetSchema,
    // Feedback-loop tuning (#155): `feedback.suppress_after` controls how many
    // 👎/reject signals on a finding fingerprint trigger a persistent
    // suppression rule. Absent `feedback` key == defaults (suppress_after: 3).
    feedback: FeedbackSchema.default({}),
    // Committable-suggestion gating (#152): controls whether and for which
    // categories `suggestion` fields are rendered as platform suggestion blocks.
    // Absent `suggestions` key == defaults (enabled: true, all categories).
    suggestions: SuggestionsSchema.default(SuggestionsSchema.parse({})),
    // Large-PR / monorepo strategy (#158): controls chunked multi-pass review
    // for PRs that exceed max_files / max_diff_lines caps.
    // Absent `large_pr` key == defaults (enabled: true, max_chunks: 5, ...).
    large_pr: LargePrSchema.default(LargePrSchema.parse({})),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
