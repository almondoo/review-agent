#!/usr/bin/env node
// LLM-as-a-Judge auto-grader (#101).
//
// Given the output of the v1.2 promptfoo to scoring-input shim
// (per-fixture runs, each run carrying a list of comments emitted by
// a candidate reviewer), this CLI calls a separate "judge" LLM to
// score each comment on the 4-axis rubric defined in
// `prompts/judge.md`. The judge per-comment JSON is validated against
// a Zod schema, retried once on parse failure, and aggregated into
// per-fixture / per-axis / overall scores in [1, 5].
//
// The runner is informational by default — its output augments
// baseline.json's `current_pass_rates.llm_judge_score` and
// parity.json's per-provider `llm_judge_score` row. A future PR may
// promote the gate to enforcing; the `--enforce-judge-gate` flag is
// reserved for that promotion but currently has no behavioural effect
// on exit code (the runner always exits 0 once judging completes).
//
// CLI:
//   pnpm --filter @review-agent/eval judge -- \
//     --candidate-results <path> --judge-provider <id> \
//     [--judge-model <model>] [--out <results.json>] \
//     [--prompt <path>] [--baseline-apply] [--parity-apply <provider-id>]
//
// Provider re-use: judge dispatch consults `@review-agent/llm`'s
// `PROVIDER_TYPES` union for `--judge-provider` validation. The
// default judge client uses the AI SDK directly (each provider's
// text-out factory) — same SDK that powers `createProvider`,
// re-routed through the eval-specific output schema (free-form JSON
// rather than the review-comment shape baked into LlmProvider).
//
// Test surface: pass `deps.client` to swap the live LLM for a mock.
// Tests in `llm-as-judge.test.ts` cover schema validation, retry path
// (1st-call parse failure then 2nd-call success / 2nd-call failure
// skip), aggregation maths, and provider switching.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_TYPES, type ProviderType } from '@review-agent/llm';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(HERE, '..');
const DEFAULT_PROMPT_PATH = join(EVAL_ROOT, 'prompts', 'judge.md');
const DEFAULT_BASELINE_PATH = join(EVAL_ROOT, 'baseline.json');
const DEFAULT_PARITY_PATH = join(EVAL_ROOT, 'parity.json');
const DEFAULT_JUDGE_RAW_DIR = join(EVAL_ROOT, '.promptfoo', 'judge');

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SeveritySchema = z.enum(['info', 'minor', 'major', 'critical']);

/**
 * Input shape: same as the severity-consistency scoring input emitted
 * by `promptfoo-to-severity-input.ts`. Each fixture run's `comments`
 * is enriched here with optional `id` / `body` / `ruleId` so the
 * judge has context to grade against. Unknown fields are preserved
 * via `passthrough()` so the shim's existing output stays compatible.
 */
export const CandidateCommentSchema = z
  .object({
    severity: SeveritySchema,
    id: z.string().optional(),
    body: z.string().optional(),
    ruleId: z.string().optional(),
  })
  .passthrough();

export const CandidateRunSchema = z.object({
  comments: z.array(CandidateCommentSchema),
  summary: z.string().optional(),
});

export const CandidateResultsSchema = z.object({
  results: z.array(
    z.object({
      fixtureId: z.string(),
      runs: z.array(CandidateRunSchema),
    }),
  ),
});

export type CandidateResults = z.infer<typeof CandidateResultsSchema>;

const ScoreAxis = z.number().int().min(1).max(5);

export const JudgeScoresSchema = z.object({
  accuracy: ScoreAxis,
  specificity: ScoreAxis,
  actionability: ScoreAxis,
  severity_calibration: ScoreAxis,
});

export const JudgeCommentResultSchema = z.object({
  id: z.string(),
  scores: JudgeScoresSchema,
  reasoning: z.string(),
});

export const JudgeRawResponseSchema = z.object({
  comments: z.array(JudgeCommentResultSchema),
});

export type JudgeScores = z.infer<typeof JudgeScoresSchema>;
export type JudgeCommentResult = z.infer<typeof JudgeCommentResultSchema>;
export type JudgeRawResponse = z.infer<typeof JudgeRawResponseSchema>;

// ---------------------------------------------------------------------------
// Judge client abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal LLM surface the judge needs: a text-in / text-out call
 * keyed on (provider, model). Concrete implementations:
 *
 *   - production: routed through `@review-agent/llm`'s provider
 *     factories (lazy-imported by `createDefaultJudgeClient` so unit
 *     tests don't pull in optional AI SDK SDKs);
 *   - tests: an in-process stub mounted via `deps.client`.
 *
 * The client returns a string the judge runner attempts to JSON.parse
 * and Zod-validate. On parse failure the runner retries once.
 */
export type JudgeClient = {
  call(args: {
    readonly provider: ProviderType;
    readonly model: string;
    readonly prompt: string;
  }): Promise<string>;
};

// ---------------------------------------------------------------------------
// Score axes (kept centralised so callers iterate deterministically)
// ---------------------------------------------------------------------------

export const SCORE_AXES = [
  'accuracy',
  'specificity',
  'actionability',
  'severity_calibration',
] as const;
export type ScoreAxisName = (typeof SCORE_AXES)[number];

// ---------------------------------------------------------------------------
// Per-comment judging
// ---------------------------------------------------------------------------

export type CommentToJudge = {
  readonly id: string;
  readonly severity: string;
  readonly body: string;
  readonly ruleId?: string;
};

export type JudgePerCommentOutcome = {
  readonly id: string;
  readonly scores: JudgeScores | null;
  readonly reasoning: string | null;
  readonly skipped: boolean;
  readonly skipReason?: string;
  readonly rawAttempts: ReadonlyArray<string>;
};

export type JudgeFixtureInput = {
  readonly fixtureId: string;
  readonly expectedSeverityModal: string | null;
  readonly diff: string | null;
  readonly comments: ReadonlyArray<CommentToJudge>;
  readonly summary: string;
};

export type JudgeOptions = {
  readonly provider: ProviderType;
  readonly model: string;
  readonly promptTemplate: string;
  readonly promptVersion: number;
  readonly client: JudgeClient;
};

/**
 * Render the judge prompt for a single (fixture, run) by interpolating
 * the comment-array + summary into the template. Mustache-style
 * placeholders are filled imperatively rather than via a templating
 * engine to keep the script dependency footprint at `zod` only.
 */
export function renderPrompt(template: string, fixture: JudgeFixtureInput): string {
  const commentsBlock = fixture.comments
    .map(
      (c) =>
        `  <comment id="${c.id}" severity="${c.severity}" ruleId="${c.ruleId ?? ''}">\n    ${c.body}\n  </comment>`,
    )
    .join('\n');
  // Replace the {{#each}} block with the rendered comments; the
  // template loop body is intentionally simple (no nested loops, no
  // conditionals) so a regex-based substitution is sufficient.
  return template
    .replace(/{{fixture\.expected_severity_modal}}/g, fixture.expectedSeverityModal ?? '')
    .replace(/{{fixture\.diff}}/g, fixture.diff ?? '')
    .replace(/{{candidate\.summary}}/g, fixture.summary)
    .replace(/\{\{#each candidate\.comments\}\}[\s\S]*?\{\{\/each\}\}/, commentsBlock);
}

/**
 * Extract a JSON object from a free-form judge response. Many models
 * wrap their JSON in markdown fences or chat-style prose; this helper
 * strips obvious fences then attempts parse + Zod validation. Returns
 * null on any failure so the caller can decide to retry or skip.
 */
export function parseJudgeResponse(raw: string): JudgeRawResponse | null {
  const trimmed = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Last-ditch: scan for the outermost { ... } block.
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    try {
      parsed = JSON.parse(candidate.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  const ok = JudgeRawResponseSchema.safeParse(parsed);
  return ok.success ? ok.data : null;
}

/**
 * Judge a single (fixture, run) once. Performs at most two LLM calls:
 * one initial attempt plus one retry on schema failure. Returns one
 * outcome per comment. Comments missing from the judge response are
 * recorded as `skipped: true` with `scores=null`.
 */
export async function judgeRun(
  fixture: JudgeFixtureInput,
  opts: JudgeOptions,
): Promise<ReadonlyArray<JudgePerCommentOutcome>> {
  const prompt = renderPrompt(opts.promptTemplate, fixture);
  const attempts: string[] = [];
  let parsed: JudgeRawResponse | null = null;
  for (let attempt = 0; attempt < 2 && parsed === null; attempt += 1) {
    const raw = await opts.client.call({
      provider: opts.provider,
      model: opts.model,
      prompt,
    });
    attempts.push(raw);
    parsed = parseJudgeResponse(raw);
  }
  const outcomes: JudgePerCommentOutcome[] = [];
  const byId = new Map<string, JudgeCommentResult>();
  if (parsed) {
    for (const c of parsed.comments) byId.set(c.id, c);
  }
  for (const c of fixture.comments) {
    const hit = byId.get(c.id);
    if (hit) {
      outcomes.push({
        id: c.id,
        scores: hit.scores,
        reasoning: hit.reasoning,
        skipped: false,
        rawAttempts: attempts,
      });
    } else if (parsed === null) {
      outcomes.push({
        id: c.id,
        scores: null,
        reasoning: null,
        skipped: true,
        skipReason: 'judge response failed schema validation after 1 retry',
        rawAttempts: attempts,
      });
    } else {
      outcomes.push({
        id: c.id,
        scores: null,
        reasoning: null,
        skipped: true,
        skipReason: 'comment id missing from judge response',
        rawAttempts: attempts,
      });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type AxisAggregate = Readonly<Record<ScoreAxisName, number | null>>;

export type FixtureAggregate = {
  readonly fixtureId: string;
  readonly perAxis: AxisAggregate;
  readonly overall: number | null;
  readonly judged: number;
  readonly skipped: number;
};

export type OverallAggregate = {
  readonly perAxis: AxisAggregate;
  readonly overall: number | null;
  readonly fixtures: ReadonlyArray<FixtureAggregate>;
  readonly totalJudged: number;
  readonly totalSkipped: number;
};

function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, n) => acc + n, 0);
  return Number((sum / values.length).toFixed(2));
}

/**
 * Aggregate per-comment outcomes into per-fixture and overall scores
 * on the 1-5 scale. Internal precision is two decimals; baseline.json
 * stores one decimal upstream.
 */
export function aggregate(
  perFixture: ReadonlyArray<{
    readonly fixtureId: string;
    readonly outcomes: ReadonlyArray<JudgePerCommentOutcome>;
  }>,
): OverallAggregate {
  const fixtures: FixtureAggregate[] = [];
  const allByAxis: Record<ScoreAxisName, number[]> = {
    accuracy: [],
    specificity: [],
    actionability: [],
    severity_calibration: [],
  };
  let totalJudged = 0;
  let totalSkipped = 0;
  for (const f of perFixture) {
    const byAxis: Record<ScoreAxisName, number[]> = {
      accuracy: [],
      specificity: [],
      actionability: [],
      severity_calibration: [],
    };
    let judged = 0;
    let skipped = 0;
    for (const o of f.outcomes) {
      if (o.skipped || o.scores === null) {
        skipped += 1;
        continue;
      }
      judged += 1;
      for (const axis of SCORE_AXES) {
        byAxis[axis].push(o.scores[axis]);
        allByAxis[axis].push(o.scores[axis]);
      }
    }
    const perAxisMeans: AxisAggregate = {
      accuracy: mean(byAxis.accuracy),
      specificity: mean(byAxis.specificity),
      actionability: mean(byAxis.actionability),
      severity_calibration: mean(byAxis.severity_calibration),
    };
    const axisValues = Object.values(perAxisMeans).filter((v): v is number => v !== null);
    const overall =
      axisValues.length === 0
        ? null
        : Number((axisValues.reduce((a, b) => a + b, 0) / axisValues.length).toFixed(2));
    fixtures.push({
      fixtureId: f.fixtureId,
      perAxis: perAxisMeans,
      overall,
      judged,
      skipped,
    });
    totalJudged += judged;
    totalSkipped += skipped;
  }
  const overallPerAxis: AxisAggregate = {
    accuracy: mean(allByAxis.accuracy),
    specificity: mean(allByAxis.specificity),
    actionability: mean(allByAxis.actionability),
    severity_calibration: mean(allByAxis.severity_calibration),
  };
  const axisValues = Object.values(overallPerAxis).filter((v): v is number => v !== null);
  const overall =
    axisValues.length === 0
      ? null
      : Number((axisValues.reduce((a, b) => a + b, 0) / axisValues.length).toFixed(2));
  return {
    perAxis: overallPerAxis,
    overall,
    fixtures,
    totalJudged,
    totalSkipped,
  };
}

// ---------------------------------------------------------------------------
// Prompt loading (YAML frontmatter parsing — minimal hand-written so
// we don't take on `yaml` as a dependency for two keys).
// ---------------------------------------------------------------------------

export type LoadedPrompt = {
  readonly id: string;
  readonly version: number;
  readonly body: string;
};

export function parsePromptFile(raw: string): LoadedPrompt {
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!fm) {
    throw new Error('judge prompt missing YAML frontmatter (--- ... ---)');
  }
  const meta = fm[1] ?? '';
  const body = (fm[2] ?? '').trim();
  let id = '';
  let version = 0;
  for (const line of meta.split('\n')) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+?)\s*$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    const value = (m[2] ?? '').replace(/^['"]|['"]$/g, '');
    if (key === 'id') id = value;
    else if (key === 'version') version = Number.parseInt(value, 10);
  }
  if (!id) throw new Error('judge prompt frontmatter missing `id`');
  if (!Number.isFinite(version) || version <= 0) {
    throw new Error('judge prompt frontmatter missing valid `version`');
  }
  return { id, version, body };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export type RunJudgeArgs = {
  readonly candidateResultsPath: string;
  readonly provider: ProviderType;
  readonly model: string;
  readonly promptPath: string;
  readonly outPath: string | null;
  readonly rawDir: string;
  readonly now: () => Date;
  readonly client: JudgeClient;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly ensureDir: (path: string) => Promise<void>;
  /** Optional path to expected.json fixtures (used to inject expected_severity_modal). When unset, expected fields are left blank. */
  readonly fixturesDir?: string;
};

export type RunJudgeResult = {
  readonly aggregate: OverallAggregate;
  readonly report: string;
  readonly judgePromptVersion: number;
  readonly rawArtifactPath: string;
  readonly outPath: string | null;
};

export async function runJudge(args: RunJudgeArgs): Promise<RunJudgeResult> {
  const promptRaw = await args.readFile(args.promptPath);
  const prompt = parsePromptFile(promptRaw);

  const candidateRaw = await args.readFile(args.candidateResultsPath);
  const candidate = CandidateResultsSchema.parse(JSON.parse(candidateRaw));

  const perFixture: Array<{
    fixtureId: string;
    outcomes: JudgePerCommentOutcome[];
  }> = [];
  const rawRecords: Array<{
    fixtureId: string;
    runIndex: number;
    prompt: string;
    rawAttempts: ReadonlyArray<string>;
  }> = [];

  for (const fx of candidate.results) {
    const expected = await loadExpectedSeverityModal(args.fixturesDir, fx.fixtureId, args.readFile);
    const fixtureOutcomes: JudgePerCommentOutcome[] = [];
    for (let runIndex = 0; runIndex < fx.runs.length; runIndex += 1) {
      const run = fx.runs[runIndex];
      if (!run) continue;
      const comments: CommentToJudge[] = run.comments.map((c, idx) => ({
        id: c.id ?? `${fx.fixtureId}#${runIndex}-${idx}`,
        severity: c.severity,
        body: c.body ?? '',
        ...(c.ruleId !== undefined ? { ruleId: c.ruleId } : {}),
      }));
      if (comments.length === 0) continue;
      const fixtureInput: JudgeFixtureInput = {
        fixtureId: fx.fixtureId,
        expectedSeverityModal: expected,
        diff: null,
        comments,
        summary: run.summary ?? '',
      };
      const renderedPrompt = renderPrompt(prompt.body, fixtureInput);
      const outcomes = await judgeRun(fixtureInput, {
        provider: args.provider,
        model: args.model,
        promptTemplate: prompt.body,
        promptVersion: prompt.version,
        client: args.client,
      });
      fixtureOutcomes.push(...outcomes);
      rawRecords.push({
        fixtureId: fx.fixtureId,
        runIndex,
        prompt: renderedPrompt,
        rawAttempts: outcomes[0]?.rawAttempts ?? [],
      });
    }
    perFixture.push({ fixtureId: fx.fixtureId, outcomes: fixtureOutcomes });
  }

  const agg = aggregate(perFixture);
  const ts = args.now().toISOString().replace(/[:.]/g, '-');
  const rawArtifactPath = join(args.rawDir, `${ts}.json`);
  await args.ensureDir(args.rawDir);
  await args.writeFile(
    rawArtifactPath,
    `${JSON.stringify(
      {
        judge_prompt_version: prompt.version,
        judge_provider: args.provider,
        judge_model: args.model,
        generated_at: args.now().toISOString(),
        records: rawRecords,
      },
      null,
      2,
    )}\n`,
  );

  if (args.outPath) {
    await args.writeFile(
      args.outPath,
      `${JSON.stringify(
        {
          judge_prompt_version: prompt.version,
          judge_provider: args.provider,
          judge_model: args.model,
          aggregate: agg,
        },
        null,
        2,
      )}\n`,
    );
  }

  return {
    aggregate: agg,
    report: renderReport(agg, prompt.version, args.provider, args.model),
    judgePromptVersion: prompt.version,
    rawArtifactPath,
    outPath: args.outPath,
  };
}

function renderReport(
  agg: OverallAggregate,
  promptVersion: number,
  provider: ProviderType,
  model: string,
): string {
  const lines: string[] = [];
  lines.push(`llm_judge prompt_version=${promptVersion} provider=${provider} model=${model}`);
  lines.push(
    `overall=${agg.overall ?? '<none>'}  judged=${agg.totalJudged}  skipped=${agg.totalSkipped}`,
  );
  lines.push(
    `per-axis: accuracy=${agg.perAxis.accuracy ?? '<none>'} specificity=${agg.perAxis.specificity ?? '<none>'} actionability=${agg.perAxis.actionability ?? '<none>'} severity_calibration=${agg.perAxis.severity_calibration ?? '<none>'}`,
  );
  for (const f of agg.fixtures) {
    lines.push(
      `  [${f.fixtureId}] overall=${f.overall ?? '<none>'}  judged=${f.judged}  skipped=${f.skipped}`,
    );
  }
  return lines.join('\n');
}

async function loadExpectedSeverityModal(
  fixturesDir: string | undefined,
  fixtureId: string,
  reader: (path: string) => Promise<string>,
): Promise<string | null> {
  if (!fixturesDir) return null;
  try {
    const raw = await reader(join(fixturesDir, fixtureId, 'expected.json'));
    const parsed = JSON.parse(raw) as { severity_modal?: unknown };
    return typeof parsed.severity_modal === 'string' ? parsed.severity_modal : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Baseline / parity persistence
// ---------------------------------------------------------------------------

const BaselineFileSchema = z
  .object({
    current_pass_rates: z.object({}).passthrough(),
  })
  .passthrough();

const ParityFileSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.string(),
          eval: z.object({}).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export async function applyBaselineUpdate(
  baselinePath: string,
  overall: number | null,
  promptVersion: number,
  provider: ProviderType,
  model: string,
  now: Date,
): Promise<void> {
  const raw = await readFile(baselinePath, 'utf8');
  const data = BaselineFileSchema.parse(JSON.parse(raw));
  const current = data.current_pass_rates as Record<string, unknown>;
  current.llm_judge_score = overall;
  current.llm_judge_metadata = {
    recorded_at: now.toISOString().slice(0, 10),
    judge_provider: provider,
    judge_model: model,
    judge_prompt_version: promptVersion,
  };
  await writeFile(baselinePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function applyParityUpdate(
  parityPath: string,
  providerId: string,
  overall: number | null,
): Promise<void> {
  const raw = await readFile(parityPath, 'utf8');
  const data = ParityFileSchema.parse(JSON.parse(raw));
  let touched = false;
  for (const p of data.providers) {
    if (p.id === providerId) {
      const ev = p.eval as Record<string, unknown>;
      ev.llm_judge_score = overall;
      touched = true;
    }
  }
  if (!touched) {
    throw new Error(`parity.json: provider id '${providerId}' not found`);
  }
  await writeFile(parityPath, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Default judge client (live LLM via @review-agent/llm)
// ---------------------------------------------------------------------------

/**
 * Build a live judge client that routes through the AI SDK provider
 * factories. Imported lazily so unit tests (which always inject a
 * mock client) never need an API key.
 *
 * Each provider's text-out call uses the same SDK that powers
 * `@review-agent/llm`'s `createProvider`, so the env-var conventions
 * line up (ANTHROPIC_API_KEY, OPENAI_API_KEY, AWS creds, etc.).
 */
/* v8 ignore start */
// Provider package names match `@review-agent/llm`'s optional
// peerDependencies block. They are runtime-resolved via dynamic
// import so this script does not force every provider SDK to be
// installed (the operator only needs the one they're using). The
// `dynamicImport` indirection routes through a runtime variable so
// the TypeScript compiler does not attempt to resolve them at
// build / typecheck time — keeps `pnpm typecheck` green without
// having to declare these as direct deps of `@review-agent/eval`.
const PROVIDER_PACKAGES: Readonly<Record<ProviderType, string>> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  'azure-openai': '@ai-sdk/azure',
  google: '@ai-sdk/google',
  vertex: '@ai-sdk/google-vertex',
  bedrock: '@ai-sdk/amazon-bedrock',
  'openai-compatible': '@ai-sdk/openai-compatible',
};

const PROVIDER_FACTORIES: Readonly<Record<ProviderType, string>> = {
  anthropic: 'createAnthropic',
  openai: 'createOpenAI',
  'azure-openai': 'createAzure',
  google: 'createGoogleGenerativeAI',
  vertex: 'createVertex',
  bedrock: 'createAmazonBedrock',
  'openai-compatible': 'createOpenAICompatible',
};

async function dynamicImport(spec: string): Promise<Record<string, unknown>> {
  // Pass a runtime variable into `import()` so TypeScript does not
  // try to resolve the module specifier at compile time. The runner
  // is invoked via `tsx`, which honours the dynamic import at run
  // time.
  const specifier: string = spec;
  return (await import(specifier)) as Record<string, unknown>;
}

export async function createDefaultJudgeClient(): Promise<JudgeClient> {
  return {
    async call({ provider, model, prompt }) {
      const aiModule = await dynamicImport('ai');
      const generateText = aiModule.generateText as (args: {
        model: unknown;
        prompt: string;
        temperature: number;
      }) => Promise<{ text: string }>;
      const languageModel = await buildLanguageModel(provider, model);
      const result = await generateText({
        model: languageModel,
        prompt,
        temperature: 0,
      });
      return result.text;
    },
  };
}

async function buildLanguageModel(provider: ProviderType, model: string): Promise<unknown> {
  const pkgName = PROVIDER_PACKAGES[provider];
  const factoryName = PROVIDER_FACTORIES[provider];
  const mod = await dynamicImport(pkgName);
  const factory = mod[factoryName] as
    | ((opts: Record<string, string>) => (m: string) => unknown)
    | undefined;
  if (typeof factory !== 'function') {
    throw new Error(
      `judge provider '${provider}': expected '${factoryName}' export in '${pkgName}'`,
    );
  }
  if (provider === 'openai-compatible') {
    return factory({
      name: 'openai-compatible',
      baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL ?? '',
    })(model);
  }
  return factory({})(model);
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

type CliArgs = {
  candidateResultsPath: string;
  provider: ProviderType;
  model: string;
  promptPath: string;
  outPath: string | null;
  rawDir: string;
  baselineApply: boolean;
  parityApply: string | null;
};

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let candidateResultsPath = '';
  let provider: ProviderType = 'anthropic';
  let model = 'claude-opus-4-7';
  let promptPath = DEFAULT_PROMPT_PATH;
  let outPath: string | null = null;
  let rawDir = DEFAULT_JUDGE_RAW_DIR;
  let baselineApply = false;
  let parityApply: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--candidate-results') {
      candidateResultsPath = next ?? '';
      i += 1;
    } else if (a === '--judge-provider') {
      const candidate = next ?? '';
      if (!(PROVIDER_TYPES as ReadonlyArray<string>).includes(candidate)) {
        throw new Error(
          `--judge-provider must be one of ${PROVIDER_TYPES.join(', ')}, got '${candidate}'`,
        );
      }
      provider = candidate as ProviderType;
      i += 1;
    } else if (a === '--judge-model') {
      model = next ?? model;
      i += 1;
    } else if (a === '--prompt') {
      promptPath = next ?? promptPath;
      i += 1;
    } else if (a === '--out') {
      outPath = next ?? null;
      i += 1;
    } else if (a === '--raw-dir') {
      rawDir = next ?? rawDir;
      i += 1;
    } else if (a === '--baseline-apply') {
      baselineApply = true;
    } else if (a === '--parity-apply') {
      parityApply = next ?? null;
      i += 1;
    } else if (a === '--enforce-judge-gate') {
      // Reserved per issue #101: column / I/O only. The runner still
      // exits 0 regardless of score — promotion to enforcing happens
      // in a separate PR.
    }
  }
  if (!candidateResultsPath) {
    throw new Error(
      'Usage: llm-as-judge --candidate-results <path> --judge-provider <id> [--judge-model <model>] [--out <path>] [--baseline-apply] [--parity-apply <provider-id>]',
    );
  }
  return {
    candidateResultsPath,
    provider,
    model,
    promptPath,
    outPath,
    rawDir,
    baselineApply,
    parityApply,
  };
}

/* v8 ignore start */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = await createDefaultJudgeClient();
  const result = await runJudge({
    candidateResultsPath: args.candidateResultsPath,
    provider: args.provider,
    model: args.model,
    promptPath: args.promptPath,
    outPath: args.outPath,
    rawDir: args.rawDir,
    now: () => new Date(),
    client,
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, d) => writeFile(p, d),
    ensureDir: async (d) => {
      await mkdir(d, { recursive: true });
    },
  });
  process.stdout.write(`${result.report}\n`);
  process.stdout.write(`raw artifact: ${result.rawArtifactPath}\n`);
  if (args.baselineApply) {
    await applyBaselineUpdate(
      DEFAULT_BASELINE_PATH,
      result.aggregate.overall,
      result.judgePromptVersion,
      args.provider,
      args.model,
      new Date(),
    );
    process.stdout.write(
      `baseline.json: llm_judge_score updated to ${result.aggregate.overall ?? 'null'}\n`,
    );
  }
  if (args.parityApply) {
    await applyParityUpdate(DEFAULT_PARITY_PATH, args.parityApply, result.aggregate.overall);
    process.stdout.write(
      `parity.json: ${args.parityApply}.eval.llm_judge_score updated to ${result.aggregate.overall ?? 'null'}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
/* v8 ignore stop */
