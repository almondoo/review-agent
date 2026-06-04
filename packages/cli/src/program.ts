import { Command, InvalidArgumentError, Option } from 'commander';
import { auditExportCommand } from './commands/audit-export.js';
import { auditPruneCommand } from './commands/audit-prune.js';
import { runDryRunCommand } from './commands/dry-run.js';
import { runEvalCommand } from './commands/eval.js';
import { feedbackBackfillCommand } from './commands/feedback-backfill.js';
import { listPresetsCommand } from './commands/presets.js';
import {
  recoverFeedbackHistoryCommand,
  recoverReviewEvalEventsCommand,
  recoverSyncStateCommand,
} from './commands/recover.js';
import { runReviewCommand } from './commands/review.js';
import { printSchemaCommand } from './commands/schema.js';
import { setupWorkspaceCommand } from './commands/setup-workspace.js';
import { validateConfigCommand } from './commands/validate.js';
import { defaultIo, type ProgramIo } from './io.js';

export type ProgramDeps = {
  readonly io?: ProgramIo;
  readonly env?: NodeJS.ProcessEnv;
  readonly version?: string;
};

const PROFILES = ['chill', 'assertive'] as const;
const PLATFORMS = ['github', 'codecommit'] as const;

export function buildProgram(deps: ProgramDeps = {}): Command {
  const io = deps.io ?? defaultIo();
  const env = deps.env ?? process.env;
  const program = new Command();

  program
    .name('review-agent')
    .description('Self-hosted multi-provider AI code review (local CLI).')
    .version(deps.version ?? '0.0.0', '--version');

  program
    .command('review')
    .description('Run a review against a single PR using a PAT.')
    .requiredOption('--repo <repo>', "repository: 'owner/name' for github, '<name>' for codecommit")
    .requiredOption('--pr <n>', 'PR number', (v) => Number.parseInt(v, 10))
    .addOption(
      new Option('--platform <platform>', 'VCS platform (default: github)')
        .choices([...PLATFORMS])
        .default('github'),
    )
    .option('--config <path>', 'path to .review-agent.yml', '.review-agent.yml')
    .option('--lang <code>', 'override output language (BCP 47)')
    .addOption(new Option('--profile <profile>', 'override review profile').choices([...PROFILES]))
    .option('--cost-cap-usd <usd>', 'cap total LLM spend per run', (v) => Number.parseFloat(v))
    .option('--post', 'publish comments to the PR (default: dry run)', false)
    .action(async (opts: ReviewCliOpts) => {
      const result = await runReviewCommand(io, {
        repo: opts.repo,
        pr: opts.pr,
        configPath: opts.config,
        post: !!opts.post,
        platform: opts.platform,
        ...(opts.lang ? { language: opts.lang } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.costCapUsd !== undefined ? { costCapUsd: opts.costCapUsd } : {}),
        env,
      });
      io.exit(result.status === 'reviewed' || result.status === 'skipped' ? 0 : 1);
    });

  program
    .command('dry-run')
    .description(
      'Preview effective config and optionally run the review pipeline without posting to the PR.',
    )
    .option('--config <path>', 'path to .review-agent.yml', '.review-agent.yml')
    .option(
      '--pr <owner/repo#number>',
      "run the full review pipeline against this PR (no-post); format: 'owner/repo#<n>'",
    )
    .addOption(
      new Option('--platform <platform>', 'VCS platform (default: github)')
        .choices([...PLATFORMS])
        .default('github'),
    )
    .option('--lang <code>', 'override output language (BCP 47)')
    .addOption(new Option('--profile <profile>', 'override review profile').choices([...PROFILES]))
    .action(async (opts: DryRunCliOpts) => {
      const result = await runDryRunCommand(io, {
        configPath: opts.config,
        ...(opts.pr !== undefined ? { pr: opts.pr } : {}),
        platform: opts.platform,
        ...(opts.lang ? { language: opts.lang } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        env,
      });
      io.exit(result.status === 'config_only' || result.status === 'reviewed' ? 0 : 1);
    });

  const config = program.command('config').description('Inspect / validate config.');

  config
    .command('validate')
    .description('Validate `.review-agent.yml` against the schema.')
    .argument('[path]', 'path to config file', '.review-agent.yml')
    .action(async (path: string) => {
      const result = await validateConfigCommand(io, { path });
      io.exit(result.ok ? 0 : 1);
    });

  config
    .command('schema')
    .description('Print the JSON Schema for `.review-agent.yml` to stdout.')
    .action(() => {
      printSchemaCommand(io);
      io.exit(0);
    });

  const presets = config.command('presets').description('Bundled preset helpers.');

  presets
    .command('list')
    .description('List all bundled first-party preset names.')
    .action(() => {
      listPresetsCommand(io);
      io.exit(0);
    });

  program
    .command('eval')
    .description('Run a promptfoo eval suite (delegates to packages/eval).')
    .requiredOption('--suite <name>', 'suite name (e.g. `golden`)')
    // The action body is pure CLI wiring — always replaced by a stub in
    // tests that call runEvalCommand directly.
    /* v8 ignore start */
    .action(async (opts: EvalCliOpts) => {
      const result = await runEvalCommand(io, { suite: opts.suite });
      io.exit(result.exitCode);
    });
  /* v8 ignore stop */

  const setup = program
    .command('setup')
    .description('Onboarding helpers (Anthropic Workspace, etc.).');

  setup
    .command('workspace')
    .description(
      'Configure an Anthropic Workspace for review-agent (ZDR + spend cap). Prints a manual checklist by default; --api uses the Admin API.',
    )
    .option('--api', 'call the Anthropic Admin API directly (requires ANTHROPIC_ADMIN_KEY)', false)
    .option('--name <name>', 'workspace name', 'review-agent')
    .option('--spend-cap-usd <usd>', 'monthly spend cap in USD', (v) => Number.parseFloat(v), 50)
    .action(async (opts: SetupWorkspaceCliOpts) => {
      const result = await setupWorkspaceCommand(io, {
        api: !!opts.api,
        env,
        // Commander's option('--name', ..., 'review-agent') means opts.name
        // is always defined here; the falsy arm is structurally dead.
        /* v8 ignore next */
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        // Same for --spend-cap-usd (default 50).
        /* v8 ignore next */
        ...(opts.spendCapUsd !== undefined ? { spendCapUsd: opts.spendCapUsd } : {}),
      });
      io.exit(result.status === 'manual' || result.status === 'api_ok' ? 0 : 1);
    });

  const audit = program
    .command('audit')
    .description('audit_log + cost_ledger retention helpers (spec §13.3).');

  audit
    .command('export')
    .description(
      'Export audit_log + cost_ledger rows for an installation/date range as gzipped JSONL.',
    )
    .requiredOption('--installation <id>', 'GitHub App installation ID', (v) => BigInt(v))
    .requiredOption('--since <date>', 'inclusive lower bound (YYYY-MM-DD or full ISO 8601)')
    .option('--until <date>', 'inclusive upper bound (YYYY-MM-DD or full ISO 8601)')
    .requiredOption('--output <path>', 'output file path (`.jsonl.gz` by convention)')
    .action(async (opts: AuditExportCliOpts) => {
      const result = await auditExportCommand(io, {
        installationId: opts.installation,
        since: opts.since,
        ...(opts.until !== undefined ? { until: opts.until } : {}),
        output: opts.output,
        env,
      });
      // The exit-0 arm fires on a successful export. auditExportCommand is
      // tested directly for that path; reaching it through parseAsync would
      // require injecting createDb / loadAudit which the program-level
      // surface does not expose.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  audit
    .command('prune')
    .description(
      'Delete audit_log + cost_ledger rows older than --before. Preserves chain integrity via an anchor row.',
    )
    .requiredOption('--before <date>', 'inclusive upper bound (YYYY-MM-DD or full ISO 8601)')
    .option('--confirm', 'actually delete (default is dry run)', false)
    .action(async (opts: AuditPruneCliOpts) => {
      const result = await auditPruneCommand(io, {
        before: opts.before,
        confirm: !!opts.confirm,
        env,
      });
      // exit-0 fires on 'ok' / 'dry_run'. auditPruneCommand is tested for
      // both directly; the program-level path always returns 'config_error'
      // when DATABASE_URL is missing (which it is in tests).
      /* v8 ignore next */
      io.exit(result.status === 'ok' || result.status === 'dry_run' ? 0 : 1);
    });

  const feedback = program
    .command('feedback')
    .description('review_history backfill / inspection helpers (spec §7.6).');

  feedback
    .command('backfill')
    .description(
      'Walk every PR in a GitHub repo and ingest historical +1/-1 reactions on Bot review comments into review_history.',
    )
    .requiredOption('--installation-id <id>', 'GitHub App installation ID', (v) => BigInt(v))
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .addOption(
      new Option('--platform <platform>', 'VCS platform (default: github)')
        .choices([...PLATFORMS])
        .default('github'),
    )
    .option(
      '--since <date>',
      'inclusive lower bound on PR updated_at (YYYY-MM-DD or full ISO 8601)',
    )
    .option('--state-file <path>', 'JSON resume file for interrupted runs')
    .option('--dry-run', 'compute the plan without writing review_history rows', false)
    .option(
      '--rate <req-per-sec>',
      'GitHub API request rate ceiling (default: 2)',
      (v) => Number.parseFloat(v),
      2,
    )
    .option('--bot-login <login>', 'pin the bot login that authored review comments to ingest')
    .action(async (opts: FeedbackBackfillCliOpts) => {
      const result = await feedbackBackfillCommand(io, {
        installationId: opts.installationId,
        repo: opts.repo,
        platform: opts.platform,
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.stateFile !== undefined ? { stateFile: opts.stateFile } : {}),
        dryRun: !!opts.dryRun,
        // --rate has a commander default of 2; opts.rate is always defined.
        /* v8 ignore next */
        ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
        ...(opts.botLogin !== undefined ? { botLogin: opts.botLogin } : {}),
        env,
      });
      // exit-0 arm fires on 'ok' / 'dry_run' — both tested directly on
      // feedbackBackfillCommand; reaching them through parseAsync needs an
      // injected createDb seam that the program-level surface lacks.
      /* v8 ignore next */
      io.exit(result.status === 'ok' || result.status === 'dry_run' ? 0 : 1);
    });

  const recover = program
    .command('recover')
    .description('Disaster-recovery commands (spec §8.6.6).');

  recover
    .command('sync-state')
    .description(
      'Walk every open PR in the repo, parse hidden review-state comments, and upsert review_state rows.',
    )
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .requiredOption('--installation <id>', 'GitHub App installation ID', (v) => BigInt(v))
    .addOption(
      new Option('--platform <platform>', 'VCS platform (default: github)')
        .choices([...PLATFORMS])
        .default('github'),
    )
    .action(async (opts: RecoverSyncStateCliOpts) => {
      const result = await recoverSyncStateCommand(io, {
        repo: opts.repo,
        installationId: opts.installation,
        platform: opts.platform,
        env,
      });
      // exit-0 arm requires a successful recover, which needs an injected
      // VCS / upsert seam not exposed through commander; the command tests
      // exercise that path directly.
      /* v8 ignore next */
      io.exit(result.status === 'auth_failed' ? 1 : 0);
    });

  recover
    .command('review-eval-events')
    .description(
      'Recover review_eval_event rows from cost_ledger aggregation (v1.2 #105). Idempotent: re-running with the same args inserts nothing on the second pass.',
    )
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .requiredOption('--installation-id <id>', 'installation ID', (v) => BigInt(v))
    .option('--since <YYYY-MM-DD>', 'only consider cost_ledger rows newer than this date')
    .option('--dry-run', 'count candidates but do not insert', false)
    .action(async (opts: RecoverEvalEventsCliOpts) => {
      await recoverReviewEvalEventsCommand(io, {
        repo: opts.repo,
        installationId: opts.installationId,
        env,
        ...(opts.since ? { since: opts.since } : {}),
        // option('--dry-run', '...', false) means opts.dryRun is always
        // defined (boolean false when omitted); the ?? false default arm
        // is structurally dead.
        /* v8 ignore next */
        dryRun: opts.dryRun ?? false,
      });
      io.exit(0);
    });

  recover
    .command('feedback-history')
    .description(
      'Recover review_history rows. GitHub: from --candidates-file (#105). CodeCommit: re-scrapes /feedback comments via the CodeCommit SDK (#110). Idempotent against existing fact_text.',
    )
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .requiredOption('--installation-id <id>', 'installation ID', (v) => BigInt(v))
    .addOption(
      new Option('--platform <platform>', 'VCS platform (default: github)')
        .choices([...PLATFORMS])
        .default('github'),
    )
    .option(
      '--candidates-file <path>',
      'JSONL file of {factType, factText} candidates; required for --platform github',
    )
    .option('--since <YYYY-MM-DD>', '(codecommit) only consider comments newer than this date')
    .option('--pr <n>', '(codecommit) single PR scope for debug', (v) => {
      if (!/^\d+$/.test(v)) {
        throw new InvalidArgumentError('--pr must be a positive integer');
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError('--pr must be positive');
      }
      return n;
    })
    .option(
      '--rate <req-per-sec>',
      '(codecommit) rate-limit pacing for the CodeCommit walk; default 2 req/sec',
      (v) => Number.parseFloat(v),
    )
    .option(
      '--bot-arn <arn>',
      '(codecommit) IAM principal ARN of the Bot whose comments may be recovered',
    )
    .option('--dry-run', 'count candidates vs existing rows but do not insert', false)
    .action(async (opts: RecoverFeedbackHistoryCliOpts) => {
      const result = await recoverFeedbackHistoryCommand(io, {
        repo: opts.repo,
        installationId: opts.installationId,
        platform: opts.platform,
        env,
        ...(opts.candidatesFile ? { candidatesFile: opts.candidatesFile } : {}),
        ...(opts.since ? { since: opts.since } : {}),
        ...(opts.pr !== undefined ? { onlyPr: opts.pr } : {}),
        ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
        ...(opts.botArn !== undefined ? { botArn: opts.botArn } : {}),
        // option('--dry-run', '...', false) → opts.dryRun is always defined.
        /* v8 ignore next */
        dryRun: opts.dryRun ?? false,
      });
      // v1.2 #113: 'partial' (codecommit allowlist denied any reply,
      // or REVIEW_AGENT_FEEDBACK_ALLOWLIST was unset with /feedback
      // present) → non-zero exit so cron callers can detect a silent
      // deny without log-scraping. The status downgrade and the
      // accompanying stderr/stdout context lines are layered inside
      // recoverFeedbackHistoryCommand.
      /* v8 ignore next */
      io.exit(result.status === 'partial' ? 1 : 0);
    });

  program.exitOverride();
  return program;
}

type RecoverEvalEventsCliOpts = {
  repo: string;
  installationId: bigint;
  since?: string;
  dryRun?: boolean;
};

type RecoverFeedbackHistoryCliOpts = {
  repo: string;
  installationId: bigint;
  platform: (typeof PLATFORMS)[number];
  candidatesFile?: string;
  since?: string;
  pr?: number;
  rate?: number;
  botArn?: string;
  dryRun?: boolean;
};

type ReviewCliOpts = {
  repo: string;
  pr: number;
  config: string;
  platform: (typeof PLATFORMS)[number];
  lang?: string;
  profile?: (typeof PROFILES)[number];
  costCapUsd?: number;
  post?: boolean;
};

type DryRunCliOpts = {
  config: string;
  pr?: string;
  platform: (typeof PLATFORMS)[number];
  lang?: string;
  profile?: (typeof PROFILES)[number];
};

type EvalCliOpts = {
  suite: string;
};

type RecoverSyncStateCliOpts = {
  repo: string;
  installation: bigint;
  platform: (typeof PLATFORMS)[number];
};

type SetupWorkspaceCliOpts = {
  api?: boolean;
  name?: string;
  spendCapUsd?: number;
};

type AuditExportCliOpts = {
  installation: bigint;
  since: string;
  until?: string;
  output: string;
};

type AuditPruneCliOpts = {
  before: string;
  confirm?: boolean;
};

type FeedbackBackfillCliOpts = {
  installationId: bigint;
  repo: string;
  platform: (typeof PLATFORMS)[number];
  since?: string;
  stateFile?: string;
  dryRun?: boolean;
  rate?: number;
  botLogin?: string;
};

export type { ProgramIo } from './io.js';
