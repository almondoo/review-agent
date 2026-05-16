import { Command, Option } from 'commander';
import { auditExportCommand } from './commands/audit-export.js';
import { auditPruneCommand } from './commands/audit-prune.js';
import { runEvalCommand } from './commands/eval.js';
import { recoverSyncStateCommand } from './commands/recover.js';
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
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .requiredOption('--pr <n>', 'PR number', (v) => Number.parseInt(v, 10))
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
        ...(opts.lang ? { language: opts.lang } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(opts.costCapUsd !== undefined ? { costCapUsd: opts.costCapUsd } : {}),
        env,
      });
      io.exit(result.status === 'reviewed' || result.status === 'skipped' ? 0 : 1);
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

  program
    .command('eval')
    .description('Run a promptfoo eval suite (delegates to packages/eval).')
    .requiredOption('--suite <name>', 'suite name (e.g. `golden`)')
    .action(async (opts: EvalCliOpts) => {
      const result = await runEvalCommand(io, { suite: opts.suite });
      io.exit(result.exitCode);
    });

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
        ...(opts.name !== undefined ? { name: opts.name } : {}),
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
    .action(async (opts: RecoverSyncStateCliOpts) => {
      const result = await recoverSyncStateCommand(io, {
        repo: opts.repo,
        installationId: opts.installation,
        env,
      });
      io.exit(result.status === 'auth_failed' ? 1 : 0);
    });

  program.exitOverride();
  return program;
}

type ReviewCliOpts = {
  repo: string;
  pr: number;
  config: string;
  lang?: string;
  profile?: (typeof PROFILES)[number];
  costCapUsd?: number;
  post?: boolean;
};

type EvalCliOpts = {
  suite: string;
};

type RecoverSyncStateCliOpts = {
  repo: string;
  installation: bigint;
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

export type { ProgramIo } from './io.js';
