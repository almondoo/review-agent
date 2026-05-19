// Unit tests for the LLM-as-a-Judge runner (#101). The judge LLM is
// stubbed via the `JudgeClient` interface so the suite never hits a
// real provider.

import { describe, expect, it, vi } from 'vitest';
import {
  aggregate,
  applyBaselineUpdate,
  applyParityUpdate,
  CandidateResultsSchema,
  type JudgeClient,
  type JudgeFixtureInput,
  JudgeRawResponseSchema,
  judgeRun,
  parseArgs,
  parseJudgeResponse,
  parsePromptFile,
  renderPrompt,
  runJudge,
} from '../llm-as-judge.js';

const SAMPLE_PROMPT = `---
id: judge
version: 7
---
Score the comment.
<expected_severity>{{fixture.expected_severity_modal}}</expected_severity>
<diff>{{fixture.diff}}</diff>
<reviewer_output>
{{candidate.summary}}
{{#each candidate.comments}}
  <comment id="{{id}}" severity="{{severity}}" ruleId="{{ruleId}}">
    {{body}}
  </comment>
{{/each}}
</reviewer_output>
`;

function makeClient(responses: ReadonlyArray<string>): JudgeClient {
  let i = 0;
  return {
    async call() {
      const r = responses[i] ?? '';
      i += 1;
      return r;
    },
  };
}

function fixtureInput(commentIds: ReadonlyArray<string>): JudgeFixtureInput {
  return {
    fixtureId: 'fx-1',
    expectedSeverityModal: 'major',
    diff: '--- a\n+++ b\n',
    summary: 'overall fine',
    comments: commentIds.map((id) => ({
      id,
      severity: 'major',
      body: `body for ${id}`,
      ruleId: 'rule-x',
    })),
  };
}

describe('parsePromptFile', () => {
  it('extracts id and version from YAML frontmatter', () => {
    const r = parsePromptFile(SAMPLE_PROMPT);
    expect(r.id).toBe('judge');
    expect(r.version).toBe(7);
    expect(r.body).toContain('Score the comment.');
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parsePromptFile('no frontmatter here')).toThrow(/frontmatter/);
  });

  it('throws when id key is missing', () => {
    expect(() => parsePromptFile('---\nversion: 1\n---\nbody\n')).toThrow(/`id`/);
  });

  it('throws when version is not a positive integer', () => {
    expect(() => parsePromptFile('---\nid: judge\nversion: zero\n---\nbody\n')).toThrow(/version/);
  });

  it('strips quotes from frontmatter values', () => {
    const r = parsePromptFile('---\nid: "judge-quoted"\nversion: 2\n---\nx\n');
    expect(r.id).toBe('judge-quoted');
  });

  it('ignores frontmatter lines that do not match key:value', () => {
    // Comment / blank lines must be skipped without breaking parse.
    const r = parsePromptFile('---\n# this is a comment\nid: judge\n\nversion: 3\n---\nbody\n');
    expect(r.id).toBe('judge');
    expect(r.version).toBe(3);
  });
});

describe('renderPrompt', () => {
  it('interpolates expected_severity, diff, summary, comments', () => {
    const { body } = parsePromptFile(SAMPLE_PROMPT);
    const out = renderPrompt(body, fixtureInput(['c1', 'c2']));
    expect(out).toContain('<expected_severity>major</expected_severity>');
    expect(out).toContain('<diff>--- a');
    expect(out).toContain('overall fine');
    expect(out).toContain('<comment id="c1" severity="major" ruleId="rule-x">');
    expect(out).toContain('body for c1');
    expect(out).toContain('<comment id="c2" severity="major" ruleId="rule-x">');
  });

  it('renders empty ruleId attribute when comment has no ruleId', () => {
    const { body } = parsePromptFile(SAMPLE_PROMPT);
    const fx: JudgeFixtureInput = {
      ...fixtureInput(['c1']),
      comments: [{ id: 'c1', severity: 'minor', body: 'body' }],
    };
    const out = renderPrompt(body, fx);
    expect(out).toContain('ruleId=""');
  });

  it('leaves expected_severity empty when fixture has none', () => {
    const { body } = parsePromptFile(SAMPLE_PROMPT);
    const fx: JudgeFixtureInput = {
      ...fixtureInput(['c1']),
      expectedSeverityModal: null,
      diff: null,
    };
    const out = renderPrompt(body, fx);
    expect(out).toContain('<expected_severity></expected_severity>');
    expect(out).toContain('<diff></diff>');
  });
});

describe('JudgeRawResponseSchema', () => {
  it('accepts a valid response', () => {
    const r = JudgeRawResponseSchema.safeParse({
      comments: [
        {
          id: 'c1',
          scores: {
            accuracy: 5,
            specificity: 4,
            actionability: 3,
            severity_calibration: 5,
          },
          reasoning: 'good',
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects axis < 1', () => {
    const r = JudgeRawResponseSchema.safeParse({
      comments: [
        {
          id: 'c1',
          scores: { accuracy: 0, specificity: 1, actionability: 1, severity_calibration: 1 },
          reasoning: 'r',
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects axis > 5', () => {
    const r = JudgeRawResponseSchema.safeParse({
      comments: [
        {
          id: 'c1',
          scores: { accuracy: 6, specificity: 1, actionability: 1, severity_calibration: 1 },
          reasoning: 'r',
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-integer axes', () => {
    const r = JudgeRawResponseSchema.safeParse({
      comments: [
        {
          id: 'c1',
          scores: { accuracy: 4.5, specificity: 1, actionability: 1, severity_calibration: 1 },
          reasoning: 'r',
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing axis', () => {
    const r = JudgeRawResponseSchema.safeParse({
      comments: [
        {
          id: 'c1',
          scores: { accuracy: 5, specificity: 1, actionability: 1 },
          reasoning: 'r',
        },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('parseJudgeResponse', () => {
  it('returns the parsed object for raw JSON', () => {
    const raw = JSON.stringify({
      comments: [
        {
          id: 'c1',
          scores: { accuracy: 5, specificity: 5, actionability: 5, severity_calibration: 5 },
          reasoning: 'ok',
        },
      ],
    });
    expect(parseJudgeResponse(raw)?.comments).toHaveLength(1);
  });

  it('extracts JSON from a ```json fenced block', () => {
    const payload = JSON.stringify({
      comments: [
        {
          id: 'c1',
          scores: { accuracy: 5, specificity: 5, actionability: 5, severity_calibration: 5 },
          reasoning: 'ok',
        },
      ],
    });
    const raw = `\`\`\`json\n${payload}\n\`\`\``;
    expect(parseJudgeResponse(raw)?.comments[0]?.id).toBe('c1');
  });

  it('falls back to scanning for outermost braces in chatty prose', () => {
    const payload = JSON.stringify({
      comments: [
        {
          id: 'c2',
          scores: { accuracy: 3, specificity: 4, actionability: 4, severity_calibration: 4 },
          reasoning: 'meh',
        },
      ],
    });
    const raw = `Sure! Here you go: ${payload} Let me know if you need more!`;
    expect(parseJudgeResponse(raw)?.comments[0]?.id).toBe('c2');
  });

  it('returns null on completely malformed input', () => {
    expect(parseJudgeResponse('not even json')).toBeNull();
  });

  it('returns null when JSON parses but Zod rejects', () => {
    expect(parseJudgeResponse('{"comments": "wrong shape"}')).toBeNull();
  });

  it('returns null when the brace-scan fallback fails to parse', () => {
    // Has both `{` and `}` so the indexOf check passes, but the slice
    // between them is still invalid JSON — exercises the inner
    // try/catch in parseJudgeResponse.
    expect(parseJudgeResponse('prefix { not json } suffix')).toBeNull();
  });
});

describe('judgeRun retry path', () => {
  function goodResponse(commentIds: ReadonlyArray<string>): string {
    return JSON.stringify({
      comments: commentIds.map((id) => ({
        id,
        scores: { accuracy: 5, specificity: 5, actionability: 5, severity_calibration: 5 },
        reasoning: `ok ${id}`,
      })),
    });
  }

  it('succeeds on first attempt — no retry', async () => {
    const calls: string[] = [];
    const client: JudgeClient = {
      async call() {
        calls.push('a');
        return goodResponse(['c1', 'c2']);
      },
    };
    const result = await judgeRun(fixtureInput(['c1', 'c2']), {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptTemplate: parsePromptFile(SAMPLE_PROMPT).body,
      promptVersion: 1,
      client,
    });
    expect(calls).toHaveLength(1);
    expect(result.every((r) => r.skipped === false)).toBe(true);
    expect(result[0]?.scores?.accuracy).toBe(5);
  });

  it('retries once on schema failure, then succeeds', async () => {
    const client = makeClient(['garbage output', goodResponse(['c1'])]);
    const spy = vi.spyOn(client, 'call');
    const result = await judgeRun(fixtureInput(['c1']), {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptTemplate: parsePromptFile(SAMPLE_PROMPT).body,
      promptVersion: 1,
      client,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result[0]?.skipped).toBe(false);
    expect(result[0]?.scores).not.toBeNull();
  });

  it('marks the comment skipped when both attempts fail', async () => {
    const client = makeClient(['bad 1', 'bad 2']);
    const result = await judgeRun(fixtureInput(['c1']), {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptTemplate: parsePromptFile(SAMPLE_PROMPT).body,
      promptVersion: 1,
      client,
    });
    expect(result[0]?.skipped).toBe(true);
    expect(result[0]?.scores).toBeNull();
    expect(result[0]?.skipReason).toMatch(/retry/);
  });

  it('skips comments missing from a structurally-valid response', async () => {
    // Judge only graded c1; c2 must come back skipped.
    const client = makeClient([
      JSON.stringify({
        comments: [
          {
            id: 'c1',
            scores: { accuracy: 4, specificity: 4, actionability: 4, severity_calibration: 4 },
            reasoning: 'ok',
          },
        ],
      }),
    ]);
    const result = await judgeRun(fixtureInput(['c1', 'c2']), {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptTemplate: parsePromptFile(SAMPLE_PROMPT).body,
      promptVersion: 1,
      client,
    });
    expect(result[0]?.skipped).toBe(false);
    expect(result[1]?.skipped).toBe(true);
    expect(result[1]?.skipReason).toMatch(/missing from/);
  });
});

describe('aggregate', () => {
  const scores = (a: number, s: number, ac: number, sc: number) => ({
    accuracy: a,
    specificity: s,
    actionability: ac,
    severity_calibration: sc,
  });

  it('computes per-axis and overall means on the 1-5 scale', () => {
    const agg = aggregate([
      {
        fixtureId: 'f1',
        outcomes: [
          {
            id: 'c1',
            scores: scores(5, 5, 5, 5),
            reasoning: 'r',
            skipped: false,
            rawAttempts: [''],
          },
          {
            id: 'c2',
            scores: scores(3, 3, 3, 3),
            reasoning: 'r',
            skipped: false,
            rawAttempts: [''],
          },
        ],
      },
      {
        fixtureId: 'f2',
        outcomes: [
          {
            id: 'c3',
            scores: scores(4, 4, 4, 4),
            reasoning: 'r',
            skipped: false,
            rawAttempts: [''],
          },
        ],
      },
    ]);
    expect(agg.totalJudged).toBe(3);
    expect(agg.totalSkipped).toBe(0);
    expect(agg.perAxis.accuracy).toBe(4);
    expect(agg.perAxis.specificity).toBe(4);
    expect(agg.overall).toBe(4);
    expect(agg.fixtures[0]?.perAxis.accuracy).toBe(4);
    expect(agg.fixtures[0]?.overall).toBe(4);
    expect(agg.fixtures[1]?.overall).toBe(4);
  });

  it('excludes skipped outcomes from aggregation', () => {
    const agg = aggregate([
      {
        fixtureId: 'f1',
        outcomes: [
          {
            id: 'c1',
            scores: scores(2, 2, 2, 2),
            reasoning: 'r',
            skipped: false,
            rawAttempts: [''],
          },
          {
            id: 'c2',
            scores: null,
            reasoning: null,
            skipped: true,
            skipReason: 'parse',
            rawAttempts: ['', ''],
          },
        ],
      },
    ]);
    expect(agg.totalJudged).toBe(1);
    expect(agg.totalSkipped).toBe(1);
    expect(agg.overall).toBe(2);
    expect(agg.fixtures[0]?.judged).toBe(1);
    expect(agg.fixtures[0]?.skipped).toBe(1);
  });

  it('returns null overall when every outcome is skipped', () => {
    const agg = aggregate([
      {
        fixtureId: 'f1',
        outcomes: [
          {
            id: 'c1',
            scores: null,
            reasoning: null,
            skipped: true,
            rawAttempts: ['', ''],
          },
        ],
      },
    ]);
    expect(agg.overall).toBeNull();
    expect(agg.perAxis.accuracy).toBeNull();
    expect(agg.fixtures[0]?.overall).toBeNull();
  });

  it('handles asymmetric per-axis nullability', () => {
    // Force an empty per-axis bucket only when there are zero
    // judged comments — covered above. Sanity-check rounding here.
    const agg = aggregate([
      {
        fixtureId: 'f1',
        outcomes: [
          {
            id: 'c1',
            scores: scores(5, 4, 3, 2),
            reasoning: 'r',
            skipped: false,
            rawAttempts: [''],
          },
        ],
      },
    ]);
    expect(agg.overall).toBe(3.5);
  });
});

describe('provider switching (mock per provider)', () => {
  it('dispatches with the configured provider id and model', async () => {
    const seen: Array<{ provider: string; model: string }> = [];
    const client: JudgeClient = {
      async call(args) {
        seen.push({ provider: args.provider, model: args.model });
        return JSON.stringify({
          comments: [
            {
              id: 'c1',
              scores: { accuracy: 4, specificity: 4, actionability: 4, severity_calibration: 4 },
              reasoning: 'ok',
            },
          ],
        });
      },
    };
    for (const provider of ['anthropic', 'openai', 'google', 'bedrock'] as const) {
      const result = await judgeRun(fixtureInput(['c1']), {
        provider,
        model: `model-for-${provider}`,
        promptTemplate: parsePromptFile(SAMPLE_PROMPT).body,
        promptVersion: 1,
        client,
      });
      expect(result[0]?.scores?.accuracy).toBe(4);
    }
    expect(seen.map((s) => s.provider)).toEqual(['anthropic', 'openai', 'google', 'bedrock']);
    expect(seen.map((s) => s.model)).toEqual([
      'model-for-anthropic',
      'model-for-openai',
      'model-for-google',
      'model-for-bedrock',
    ]);
  });
});

describe('parseArgs', () => {
  it('parses required + optional flags', () => {
    const args = parseArgs([
      '--candidate-results',
      'results.json',
      '--judge-provider',
      'openai',
      '--judge-model',
      'gpt-4o',
      '--out',
      'out.json',
    ]);
    expect(args.candidateResultsPath).toBe('results.json');
    expect(args.provider).toBe('openai');
    expect(args.model).toBe('gpt-4o');
    expect(args.outPath).toBe('out.json');
  });

  it('defaults provider=anthropic and model=claude-opus-4-7', () => {
    const args = parseArgs(['--candidate-results', 'r.json']);
    expect(args.provider).toBe('anthropic');
    expect(args.model).toBe('claude-opus-4-7');
  });

  it('rejects an unknown provider', () => {
    expect(() =>
      parseArgs(['--candidate-results', 'r.json', '--judge-provider', 'banana']),
    ).toThrow(/one of/);
  });

  it('throws when --candidate-results is missing', () => {
    expect(() => parseArgs([])).toThrow(/Usage/);
  });

  it('accepts --enforce-judge-gate without altering args (reserved flag)', () => {
    const args = parseArgs(['--candidate-results', 'r.json', '--enforce-judge-gate']);
    expect(args.candidateResultsPath).toBe('r.json');
  });

  it('parses --baseline-apply and --parity-apply', () => {
    const args = parseArgs([
      '--candidate-results',
      'r.json',
      '--baseline-apply',
      '--parity-apply',
      'anthropic',
    ]);
    expect(args.baselineApply).toBe(true);
    expect(args.parityApply).toBe('anthropic');
  });

  it('parses --prompt and --raw-dir', () => {
    const args = parseArgs([
      '--candidate-results',
      'r.json',
      '--prompt',
      '/custom/judge.md',
      '--raw-dir',
      '/custom/raw',
      '--out',
      '/custom/out.json',
    ]);
    expect(args.promptPath).toBe('/custom/judge.md');
    expect(args.rawDir).toBe('/custom/raw');
    expect(args.outPath).toBe('/custom/out.json');
  });

  it('coalesces a missing value after a flag to the default', () => {
    // Trailing `--judge-model` with no next token exercises the
    // `next ?? model` fallback path. parseArgs treats undefined as
    // "keep the default" rather than erroring.
    const args = parseArgs(['--candidate-results', 'r.json', '--judge-model']);
    expect(args.model).toBe('claude-opus-4-7');
  });
});

describe('CandidateResultsSchema', () => {
  it('accepts the v1.2 shim output shape (severity-only comments)', () => {
    const r = CandidateResultsSchema.safeParse({
      results: [
        {
          fixtureId: 'x',
          runs: [{ comments: [{ severity: 'critical' }] }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects bad severity', () => {
    const r = CandidateResultsSchema.safeParse({
      results: [
        {
          fixtureId: 'x',
          runs: [{ comments: [{ severity: 'mega' }] }],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts enriched comments with id/body/ruleId', () => {
    const r = CandidateResultsSchema.safeParse({
      results: [
        {
          fixtureId: 'x',
          runs: [
            {
              comments: [
                {
                  severity: 'major',
                  id: 'comment-1',
                  body: 'too long line',
                  ruleId: 'style/line-length',
                },
              ],
              summary: 'one issue',
            },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe('runJudge end-to-end (with mock client + in-memory FS)', () => {
  function inMemory() {
    const files = new Map<string, string>();
    const ensured = new Set<string>();
    return {
      files,
      ensured,
      reader: async (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`no file ${p}`);
        return v;
      },
      writer: async (p: string, data: string) => {
        files.set(p, data);
      },
      ensureDir: async (d: string) => {
        ensured.add(d);
      },
    };
  }

  const promptPath = '/tmp-prompt/judge.md';
  const candidatePath = '/tmp-candidate/results.json';
  const outPath = '/tmp-out/out.json';
  const rawDir = '/tmp-raw';

  it('writes raw artifact + optional out file, returns aggregate', async () => {
    const fs = inMemory();
    fs.files.set(promptPath, SAMPLE_PROMPT);
    fs.files.set(
      candidatePath,
      JSON.stringify({
        results: [
          {
            fixtureId: 'fx1',
            runs: [
              {
                comments: [
                  { id: 'c1', body: 'body 1', severity: 'major', ruleId: 'r1' },
                  { id: 'c2', body: 'body 2', severity: 'critical', ruleId: 'r2' },
                ],
                summary: 'all good',
              },
            ],
          },
        ],
      }),
    );
    const client: JudgeClient = {
      async call() {
        return JSON.stringify({
          comments: [
            {
              id: 'c1',
              scores: { accuracy: 5, specificity: 5, actionability: 5, severity_calibration: 5 },
              reasoning: 'great',
            },
            {
              id: 'c2',
              scores: { accuracy: 4, specificity: 4, actionability: 4, severity_calibration: 4 },
              reasoning: 'good',
            },
          ],
        });
      },
    };
    const fixedNow = new Date('2026-05-19T12:00:00.000Z');
    const result = await runJudge({
      candidateResultsPath: candidatePath,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath,
      outPath,
      rawDir,
      now: () => fixedNow,
      client,
      readFile: fs.reader,
      writeFile: fs.writer,
      ensureDir: fs.ensureDir,
    });
    expect(result.aggregate.overall).toBe(4.5);
    expect(result.judgePromptVersion).toBe(7);
    expect(fs.ensured.has(rawDir)).toBe(true);
    expect(fs.files.get(result.rawArtifactPath)).toContain('"judge_prompt_version": 7');
    expect(fs.files.get(outPath)).toContain('"overall": 4.5');
    expect(result.report).toContain('overall=4.5');
  });

  it('synthesises ids/body and emits <none> in report when aggregate is null', async () => {
    // Comments arrive with no id / body / ruleId and no summary — the
    // runner must fall back to `${fixtureId}#${runIndex}-${idx}`.
    // The judge fails both attempts, so every comment ends up skipped
    // and the overall aggregate is null (renderReport `'<none>'`
    // branch).
    const fs = inMemory();
    fs.files.set(promptPath, SAMPLE_PROMPT);
    fs.files.set(
      candidatePath,
      JSON.stringify({
        results: [
          {
            fixtureId: 'fx-bare',
            runs: [{ comments: [{ severity: 'major' }] }],
          },
        ],
      }),
    );
    const client: JudgeClient = {
      async call() {
        return 'totally not JSON';
      },
    };
    const result = await runJudge({
      candidateResultsPath: candidatePath,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath,
      outPath: null,
      rawDir,
      now: () => new Date('2026-01-01T00:00:00Z'),
      client,
      readFile: fs.reader,
      writeFile: fs.writer,
      ensureDir: fs.ensureDir,
    });
    expect(result.aggregate.overall).toBeNull();
    expect(result.aggregate.totalSkipped).toBe(1);
    expect(result.report).toContain('overall=<none>');
    expect(result.report).toContain('accuracy=<none>');
    expect(result.report).toContain('[fx-bare] overall=<none>');
  });

  it('loads expected_severity_modal from fixturesDir when present', async () => {
    const fs = inMemory();
    fs.files.set(promptPath, SAMPLE_PROMPT);
    fs.files.set(
      candidatePath,
      JSON.stringify({
        results: [
          {
            fixtureId: 'fx-with-expected',
            runs: [{ comments: [{ id: 'c1', body: 'b', severity: 'minor' }] }],
          },
        ],
      }),
    );
    fs.files.set(
      '/tmp-fixtures/fx-with-expected/expected.json',
      JSON.stringify({ severity_modal: 'critical' }),
    );
    let receivedPrompt = '';
    const client: JudgeClient = {
      async call({ prompt }) {
        receivedPrompt = prompt;
        return JSON.stringify({
          comments: [
            {
              id: 'c1',
              scores: { accuracy: 4, specificity: 4, actionability: 4, severity_calibration: 4 },
              reasoning: 'ok',
            },
          ],
        });
      },
    };
    await runJudge({
      candidateResultsPath: candidatePath,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath,
      outPath: null,
      rawDir,
      fixturesDir: '/tmp-fixtures',
      now: () => new Date('2026-01-01T00:00:00Z'),
      client,
      readFile: fs.reader,
      writeFile: fs.writer,
      ensureDir: fs.ensureDir,
    });
    expect(receivedPrompt).toContain('<expected_severity>critical</expected_severity>');
  });

  it('returns null for expected_severity_modal when fixture file is missing', async () => {
    const fs = inMemory();
    fs.files.set(promptPath, SAMPLE_PROMPT);
    fs.files.set(
      candidatePath,
      JSON.stringify({
        results: [
          {
            fixtureId: 'fx-no-expected',
            runs: [{ comments: [{ id: 'c1', body: 'b', severity: 'minor' }] }],
          },
        ],
      }),
    );
    let receivedPrompt = '';
    const client: JudgeClient = {
      async call({ prompt }) {
        receivedPrompt = prompt;
        return JSON.stringify({
          comments: [
            {
              id: 'c1',
              scores: { accuracy: 4, specificity: 4, actionability: 4, severity_calibration: 4 },
              reasoning: 'ok',
            },
          ],
        });
      },
    };
    await runJudge({
      candidateResultsPath: candidatePath,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath,
      outPath: null,
      rawDir,
      fixturesDir: '/tmp-fixtures-missing',
      now: () => new Date('2026-01-01T00:00:00Z'),
      client,
      readFile: fs.reader,
      writeFile: fs.writer,
      ensureDir: fs.ensureDir,
    });
    expect(receivedPrompt).toContain('<expected_severity></expected_severity>');
  });

  it('skips runs with zero comments and still produces aggregate', async () => {
    const fs = inMemory();
    fs.files.set(promptPath, SAMPLE_PROMPT);
    fs.files.set(
      candidatePath,
      JSON.stringify({
        results: [
          {
            fixtureId: 'fx-empty',
            runs: [
              { comments: [] },
              {
                comments: [{ id: 'c1', body: 'b', severity: 'minor' }],
                summary: 's',
              },
            ],
          },
        ],
      }),
    );
    const client: JudgeClient = {
      async call() {
        return JSON.stringify({
          comments: [
            {
              id: 'c1',
              scores: { accuracy: 3, specificity: 3, actionability: 3, severity_calibration: 3 },
              reasoning: 'meh',
            },
          ],
        });
      },
    };
    const result = await runJudge({
      candidateResultsPath: candidatePath,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath,
      outPath: null,
      rawDir,
      now: () => new Date('2026-01-01T00:00:00Z'),
      client,
      readFile: fs.reader,
      writeFile: fs.writer,
      ensureDir: fs.ensureDir,
    });
    expect(result.aggregate.overall).toBe(3);
    expect(result.aggregate.totalJudged).toBe(1);
  });
});

describe('applyBaselineUpdate / applyParityUpdate', () => {
  // These touch the real fs via node:fs/promises; sandbox to a tmp
  // dir to avoid mutating the repo baseline / parity files.
  it('writes llm_judge_score + metadata into baseline.json (round-trip)', async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'judge-baseline-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(
      baselinePath,
      JSON.stringify({
        current_pass_rates: { existing: true },
        history: [],
      }),
    );
    try {
      await applyBaselineUpdate(
        baselinePath,
        4.2,
        1,
        'anthropic',
        'claude-opus-4-7',
        new Date('2026-05-19T00:00:00Z'),
      );
      const after = JSON.parse(await readFile(baselinePath, 'utf8'));
      expect(after.current_pass_rates.llm_judge_score).toBe(4.2);
      expect(after.current_pass_rates.llm_judge_metadata.judge_prompt_version).toBe(1);
      expect(after.current_pass_rates.existing).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('updates the matching parity.json provider row', async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'judge-parity-'));
    const parityPath = join(dir, 'parity.json');
    await writeFile(
      parityPath,
      JSON.stringify({
        providers: [
          { id: 'anthropic', eval: { known_bug_precision: 0.9 } },
          { id: 'openai', eval: { known_bug_precision: 0.85 } },
        ],
      }),
    );
    try {
      await applyParityUpdate(parityPath, 'openai', 3.7);
      const after = JSON.parse(await readFile(parityPath, 'utf8'));
      expect(after.providers[1].eval.llm_judge_score).toBe(3.7);
      expect(after.providers[0].eval.llm_judge_score).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the parity provider id does not exist', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'judge-parity-'));
    const parityPath = join(dir, 'parity.json');
    await writeFile(parityPath, JSON.stringify({ providers: [{ id: 'anthropic', eval: {} }] }));
    try {
      await expect(applyParityUpdate(parityPath, 'nope', 3.0)).rejects.toThrow(/not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
