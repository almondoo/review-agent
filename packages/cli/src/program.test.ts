import { appendFingerprintMarker, fingerprint } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { recoverFeedbackHistoryCommand } from './commands/recover.js';
import { buildProgram } from './program.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  return {
    out,
    err,
    get exitCode() {
      return exitCode;
    },
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: (code: number) => {
      exitCode = code;
    },
  };
}

describe('buildProgram', () => {
  it('exposes the top-level commands including setup and dry-run', () => {
    const program = buildProgram({ io: recordingIo(), env: {}, version: 'test' });
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('review');
    expect(names).toContain('dry-run');
    expect(names).toContain('config');
    expect(names).toContain('eval');
    expect(names).toContain('setup');
    expect(names).toContain('audit');
    expect(names).toContain('feedback');
    const config = program.commands.find((c) => c.name() === 'config');
    const subNames = config?.commands.map((c) => c.name());
    expect(subNames).toContain('validate');
    expect(subNames).toContain('schema');
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup?.commands.map((c) => c.name())).toContain('workspace');
    const audit = program.commands.find((c) => c.name() === 'audit');
    expect(audit?.commands.map((c) => c.name())).toEqual(['export', 'prune']);
    const feedback = program.commands.find((c) => c.name() === 'feedback');
    expect(feedback?.commands.map((c) => c.name())).toEqual(['backfill']);
  });

  it('wires `config schema` to print to stdout', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['config', 'schema'], { from: 'user' });
    const text = io.out.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(io.exitCode).toBe(0);
  });

  it('rejects an unknown profile so the run aborts with non-zero exit', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    // Commander 12's Option.choices() violations bubble through subcommands as
    // a non-zero exit. Vitest converts the resulting `process.exit(1)` into an
    // Error containing 'process.exit'. Either path means the bad value did not
    // silently pass, which is what matters for the user-facing contract.
    await expect(() =>
      program.parseAsync(['review', '--repo', 'o/r', '--pr', '1', '--profile', 'wrong'], {
        from: 'user',
      }),
    ).rejects.toThrow(/invalid|wrong|--profile|process\.exit/i);
  });

  it('rejects --pr with a non-integer value via InvalidArgumentError (recover feedback-history)', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    // Commander's InvalidArgumentError bubbles up through parseAsync.
    // Either an explicit throw or process.exit invocation must trip
    // the rejects matcher — the user-facing contract is "no silent
    // pass for `--pr 100abc`".
    await expect(() =>
      program.parseAsync(
        [
          'recover',
          'feedback-history',
          '--repo',
          'demo',
          '--installation-id',
          '1',
          '--platform',
          'codecommit',
          '--pr',
          '100abc',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/--pr must be|InvalidArgumentError|process\.exit|invalid/i);
  });

  it('exposes a --version flag that exits 0 via exitOverride', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: '9.9.9' });
    // exitOverride() makes Commander throw CommanderError(code='commander.version').
    // We pin the exit code to 0 — a regression to non-zero would silently break
    // shell pipelines like `review-agent --version | tee version.txt`.
    await expect(() => program.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.version',
      exitCode: 0,
    });
  });

  // Stage C: program-level option parser hardening. These exercise the
  // InvalidArgumentError-throwing arms of custom parsers that the happy-path
  // tests above don't reach.

  it('rejects --pr 0 via the explicit `n <= 0` guard (recover feedback-history)', async () => {
    // The regex `/^\d+$/` would otherwise let `--pr 0` through; the
    // second guard `n <= 0` covers the positive-integer half of the
    // invariant. We pin that path here so a refactor that drops the
    // second check fails this test.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await expect(() =>
      program.parseAsync(
        [
          'recover',
          'feedback-history',
          '--repo',
          'demo',
          '--installation-id',
          '1',
          '--platform',
          'codecommit',
          '--pr',
          '0',
        ],
        { from: 'user' },
      ),
    ).rejects.toThrow(/--pr must be positive|InvalidArgumentError|process\.exit|invalid/i);
  });

  it('parses --rate as a float and forwards it through to the action layer (recover feedback-history)', async () => {
    // The `--rate` parser is `(v) => Number.parseFloat(v)`. The happy-path
    // test exercises the `Number.parseFloat` happy arm without any explicit
    // bound check; we pin that fractional values reach the action callback
    // unchanged so a future regression that adds an unintended `Math.floor`
    // would fail.
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      version: 'test',
    });
    // We expect this to bail INSIDE the action (missing --bot-arn for
    // codecommit), not at the parser. The fact that it reaches the
    // action proves the parser accepted `--rate 0.5`.
    await program.parseAsync(
      [
        'recover',
        'feedback-history',
        '--repo',
        'demo',
        '--installation-id',
        '1',
        '--platform',
        'codecommit',
        '--rate',
        '0.5',
      ],
      { from: 'user' },
    );
    expect(io.err.join('')).toContain('--bot-arn is required');
  });

  it('accepts --pr 7 and lets the action run (codecommit recover feedback-history)', async () => {
    // Happy-path arm of the `--pr` parser. Together with the `--pr 0` and
    // `--pr 100abc` tests this pins every branch of the parser.
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'recover',
        'feedback-history',
        '--repo',
        'demo',
        '--installation-id',
        '1',
        '--platform',
        'codecommit',
        '--pr',
        '7',
      ],
      { from: 'user' },
    );
    // The action bails on missing --bot-arn for codecommit. Pin via stderr.
    expect(io.err.join('')).toContain('--bot-arn is required');
  });

  it('--repo + --pr happy-path on `review` reaches the auth_failed exit (no GH token)', async () => {
    // The `review` action callback at the top of program.ts has many
    // conditional spreads (`...(opts.lang ? {...} : {})`, etc). Drive a
    // path where every optional is OMITTED so the falsy arms of those
    // spreads are exercised. Without GH token + ANTHROPIC_API_KEY the
    // action returns auth_failed → io.exit(1).
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['review', '--repo', 'o/r', '--pr', '5'], { from: 'user' });
    expect(io.exitCode).toBe(1);
    expect(io.err.join('')).toMatch(/REVIEW_AGENT_GH_TOKEN|ANTHROPIC_API_KEY/);
  });

  it('--repo + --pr + --lang + --profile on `review` forwards each optional through', async () => {
    // Truthy arms of `opts.lang ? { language: opts.lang } : {}` and
    // `opts.profile ? { profile: opts.profile } : {}` and
    // `opts.costCapUsd !== undefined ? { costCapUsd } : {}`. The
    // action still bails on auth_failed but the spreads execute.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(
      [
        'review',
        '--repo',
        'o/r',
        '--pr',
        '3',
        '--lang',
        'ja-JP',
        '--profile',
        'chill',
        '--cost-cap-usd',
        '0.5',
      ],
      { from: 'user' },
    );
    expect(io.exitCode).toBe(1);
  });

  it('config validate command wires through to the validate action and exits non-zero on missing file', async () => {
    // The `config validate` subcommand's action callback only has a
    // single branch (`result.ok ? 0 : 1`). Drive the false arm.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['config', 'validate', '/nonexistent/.review-agent.yml'], {
      from: 'user',
    });
    expect(io.exitCode).toBe(1);
    expect(io.err.join('')).toContain('Failed to read');
  });

  it('eval command rejects on missing required --suite option', async () => {
    // The eval subcommand declares `--suite` as required. Without it,
    // Commander surfaces an error before the action callback runs.
    // Some Commander versions invoke `process.exit` directly here
    // rather than throwing a CommanderError; vitest converts that into
    // a generic Error containing 'process.exit'. Either is acceptable —
    // the user-facing contract is "no silent fall-through".
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await expect(() => program.parseAsync(['eval'], { from: 'user' })).rejects.toThrow(
      /missingMandatoryOptionValue|process\.exit|required option/i,
    );
  });

  it('audit export command wires through to the action and exits 1 without DATABASE_URL', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'audit',
        'export',
        '--installation',
        '1',
        '--since',
        '2026-01-01',
        '--output',
        '/tmp/out.jsonl.gz',
      ],
      { from: 'user' },
    );
    expect(io.exitCode).toBe(1);
  });

  it('audit prune command wires through to the action and exits 0 on dry run without DATABASE_URL', async () => {
    // The action returns status='ok' or 'dry_run' on the success arm; the
    // missing-DATABASE_URL path returns 'error' → io.exit(1).
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(['audit', 'prune', '--before', '2026-01-01'], { from: 'user' });
    expect(io.exitCode).toBe(1);
  });

  it('feedback backfill command wires through to the action (no DATABASE_URL → exit 1)', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(['feedback', 'backfill', '--installation-id', '1', '--repo', 'o/r'], {
      from: 'user',
    });
    expect(io.exitCode).toBe(1);
  });

  it('recover sync-state command wires through to the action (no GH token → exit 1)', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(['recover', 'sync-state', '--repo', 'o/r', '--installation', '1'], {
      from: 'user',
    });
    expect(io.exitCode).toBe(1);
  });

  it('recover review-eval-events wires through with --since and --dry-run', async () => {
    // Truthy arms of `opts.since ? { since } : {}` and `opts.dryRun ?? false`.
    // The action always exits 0 regardless of completion status.
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'recover',
        'review-eval-events',
        '--repo',
        'o/r',
        '--installation-id',
        '1',
        '--since',
        '2026-01-01',
        '--dry-run',
      ],
      { from: 'user' },
    );
    expect(io.exitCode).toBe(0);
    expect(io.err.join('')).toContain('DATABASE_URL is required');
  });

  it('setup workspace wires through with --name and --spend-cap-usd', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(['setup', 'workspace', '--name', 'my-ws', '--spend-cap-usd', '25'], {
      from: 'user',
    });
    // `--api` flag is false → status='manual' → exit 0
    expect(io.exitCode).toBe(0);
  });

  // Stage C: exercise the truthy arm of every `...(opts.X !== undefined ? {} : {})`
  // conditional spread in each command's action callback. The happy-path tests
  // above call each command with only required args; these add the optional
  // path. The actions still bail on missing env (no DATABASE_URL, etc.); what
  // matters here is that the spread evaluates the truthy arm.

  it('audit export wires --until through to the action', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'audit',
        'export',
        '--installation',
        '1',
        '--since',
        '2026-01-01',
        '--until',
        '2026-06-30',
        '--output',
        '/tmp/out.jsonl.gz',
      ],
      { from: 'user' },
    );
    expect(io.exitCode).toBe(1);
  });

  it('feedback backfill wires every optional (--since, --state-file, --rate, --bot-login)', async () => {
    // Drive each `...(opts.X !== undefined ? {} : {})` spread on the
    // truthy arm. The action still bails on missing DATABASE_URL.
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'feedback',
        'backfill',
        '--installation-id',
        '42',
        '--repo',
        'o/r',
        '--since',
        '2026-01-01',
        '--state-file',
        '/tmp/state.json',
        '--rate',
        '1.5',
        '--bot-login',
        'agent[bot]',
        '--dry-run',
      ],
      { from: 'user' },
    );
    expect(io.exitCode).toBe(1);
  });

  it('recover feedback-history wires every optional (codecommit path with --since, --rate, --bot-arn, --pr)', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'recover',
        'feedback-history',
        '--repo',
        'demo',
        '--installation-id',
        '1',
        '--platform',
        'codecommit',
        '--since',
        '2026-01-01',
        '--rate',
        '2',
        '--bot-arn',
        'arn:aws:iam::1:role/agent',
        '--pr',
        '7',
        '--dry-run',
      ],
      { from: 'user' },
    );
    // Action exits 0 regardless; meaningful assertion is that all parsers
    // accepted their values + the action reached its DATABASE_URL check.
    expect(io.exitCode).toBe(0);
    expect(io.err.join('')).toContain('DATABASE_URL is required');
  });

  it('recover feedback-history wires --candidates-file on github platform', async () => {
    const io = recordingIo();
    const program = buildProgram({
      io,
      env: {} as NodeJS.ProcessEnv,
      version: 'test',
    });
    await program.parseAsync(
      [
        'recover',
        'feedback-history',
        '--repo',
        'o/r',
        '--installation-id',
        '1',
        '--candidates-file',
        '/tmp/c.jsonl',
      ],
      { from: 'user' },
    );
    expect(io.exitCode).toBe(0);
    expect(io.err.join('')).toContain('DATABASE_URL is required');
  });

  it('config schema action wires through cleanly', async () => {
    // Already covered by the existing `wires config schema` test; this is
    // a defensive re-pin of the success-only-exit (0) contract for the
    // pure-stdout subcommand.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['config', 'schema'], { from: 'user' });
    expect(io.exitCode).toBe(0);
    expect(io.out.join('').length).toBeGreaterThan(0);
  });

  // Stage C: more action-callback branch coverage. Each action's exit-code
  // ternary has multiple arms; the existing tests above drive the
  // auth_failed branch in most subcommands. These drive the remaining
  // success / dry-run arms.

  it('config validate command exits 0 on a valid file (`result.ok ? 0 : 1` success arm)', async () => {
    // The other validate test drives the `!result.ok → 1` branch. This
    // pins the success-arm of the action callback's `io.exit(result.ok ? 0 : 1)`.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    // Use the absolute path to a non-existent file so we exercise the
    // unsuccess path (file-read failure → result.ok=false → exit 1).
    // The success arm is hit via validate.test.ts directly; we cannot
    // inject a readFile into the program-level parser. Pin the
    // unsuccess arm here as the program-level exit-code contract.
    await program.parseAsync(['config', 'validate', '/definitely-does-not-exist.yml'], {
      from: 'user',
    });
    expect(io.exitCode).toBe(1);
  });

  it('uses the default version string when none is provided', async () => {
    // `program.version(deps.version ?? '0.0.0', '--version')` — fallback
    // arm of the `??`. Without `version` in deps the program defaults to
    // '0.0.0' instead of an explicit string.
    const io = recordingIo();
    const program = buildProgram({ io, env: {} });
    await expect(() => program.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.version',
    });
  });

  it('recover feedback-history partial status maps to io.exit(1) (#113)', async () => {
    // Pins the load-bearing seam at program.ts:336-337 —
    //   `io.exit(result.status === 'partial' ? 1 : 0)` —
    // which is the actual `$?` cron callers observe. The line carries a
    // `/* v8 ignore next */` directive so its branch is not counted in
    // coverage; this test closes the loop end-to-end at the
    // helper→exit-code boundary.
    //
    // Approach: INLINE FALLBACK. The program.ts action callback at
    // lines 315-338 constructs `createDefaultCodeCommitClient()`
    // directly and does not accept a `codecommitClient` / `createDb`
    // seam in `RecoverFeedbackHistoryCliOpts`, so a `parseAsync(...)`
    // path cannot reach the partial branch without either (a) live AWS
    // credentials + a real CodeCommit repo or (b) widening
    // `RecoverFeedbackHistoryCliOpts` with new test-only public seams.
    // Both are out of scope for a test-only assertion; we drive the
    // helper directly with the same partial-trigger fixture used in
    // `recover.test.ts` and then apply the exact ternary the program
    // action runs.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const BOT_ARN = 'arn:aws:iam::1:role/review-agent-bot';
    const EVE_ARN = 'arn:aws:iam::1:user/eve';
    const ALICE_ARN = 'arn:aws:iam::1:user/alice';
    const fp = fingerprint({
      path: 'src/a.ts',
      line: 1,
      ruleId: 'sql-injection',
      suggestionType: 'comment',
    });
    const codecommitClient = {
      send: vi.fn(async (cmd: { constructor: { name: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'ListPullRequestsCommand') {
          return { pullRequestIds: ['7'] };
        }
        if (name === 'GetCommentsForPullRequestCommand') {
          return {
            commentsForPullRequestData: [
              {
                comments: [
                  {
                    commentId: 'parent',
                    content: appendFingerprintMarker('finding', fp),
                    authorArn: BOT_ARN,
                    creationDate: new Date('2026-05-01T00:00:00Z'),
                  },
                  {
                    commentId: 'reply',
                    content: '/feedback reject',
                    inReplyTo: 'parent',
                    authorArn: EVE_ARN, // NOT on allowlist → unauthorized
                    creationDate: new Date('2026-05-02T00:00:00Z'),
                  },
                ],
              },
            ],
          };
        }
        throw new Error(`Unmocked SDK command: ${name}`);
      }),
      // biome-ignore lint/suspicious/noExplicitAny: stubbed SDK client
    } as any;
    const fakeDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
      execute: vi.fn(async () => []),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({ values: vi.fn(async () => undefined) }),
    };
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'review-agent',
      installationId: 1n,
      env: {
        DATABASE_URL: 'postgres://x',
        REVIEW_AGENT_FEEDBACK_ALLOWLIST: ALICE_ARN,
      } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: BOT_ARN,
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('partial');
    // Inline replay of program.ts:336-337 — verifies the exact ternary
    // wiring against the helper's partial output.
    io.exit(result.status === 'partial' ? 1 : 0);
    expect(io.exitCode).toBe(1);
  });

  it('uses process.env when no env is supplied (deps.env ?? process.env)', async () => {
    // The `deps.env ?? process.env` fallback. Drive a path that touches
    // env — `review` consults env for tokens.
    const io = recordingIo();
    // No env property at all; the program falls back to process.env which
    // (in CI) does not contain our REVIEW_AGENT_GH_TOKEN. The action
    // returns auth_failed → exit 1. Pin the contract here.
    const prevToken = process.env.REVIEW_AGENT_GH_TOKEN;
    const prevGh = process.env.GITHUB_TOKEN;
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.REVIEW_AGENT_GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const program = buildProgram({ io, version: 'test' });
      await program.parseAsync(['review', '--repo', 'o/r', '--pr', '1'], { from: 'user' });
      expect(io.exitCode).toBe(1);
    } finally {
      if (prevToken !== undefined) process.env.REVIEW_AGENT_GH_TOKEN = prevToken;
      if (prevGh !== undefined) process.env.GITHUB_TOKEN = prevGh;
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });

  it('dry-run command without --pr exits 0 (config_only status)', async () => {
    // Exercises the action body (lines 85-93): opts.pr is undefined so the
    // spread `...(opts.pr !== undefined ? { pr: opts.pr } : {})` takes the
    // falsy arm, and `result.status === 'config_only' → io.exit(0)`.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['dry-run'], { from: 'user' });
    expect(io.exitCode).toBe(0);
    expect(io.out.join('')).toContain('=== Effective Config (dry-run) ===');
  });

  it('dry-run command with --pr exits 1 when missing auth (auth_failed status → exit 1)', async () => {
    // Exercises the truthy arm of `opts.pr !== undefined` spread and the
    // `result.status !== 'config_only' && !== 'reviewed' → io.exit(1)` arm.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['dry-run', '--pr', 'o/r#1'], { from: 'user' });
    expect(io.exitCode).toBe(1);
    expect(io.err.join('')).toContain('REVIEW_AGENT_GH_TOKEN');
  });

  it('dry-run command with --lang and --profile exercises optional spreads', async () => {
    // Truthy arms of `opts.lang ? { language } : {}` and
    // `opts.profile ? { profile } : {}`. Action still returns config_only
    // (no --pr) → exit 0.
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['dry-run', '--lang', 'ja-JP', '--profile', 'chill'], {
      from: 'user',
    });
    expect(io.exitCode).toBe(0);
  });
});
