import { dashboardRoleSchema } from '@review-agent/core';
import { Command, InvalidArgumentError, Option } from 'commander';
import { auditExportCommand } from './commands/audit-export.js';
import { auditPruneCommand } from './commands/audit-prune.js';
import { runDryRunCommand } from './commands/dry-run.js';
import { runEvalCommand } from './commands/eval.js';
import { feedbackBackfillCommand } from './commands/feedback-backfill.js';
import { parseFailOn } from './commands/local-review.js';
import { listPresetsCommand } from './commands/presets.js';
import {
  recoverFeedbackHistoryCommand,
  recoverReviewEvalEventsCommand,
  recoverSyncStateCommand,
} from './commands/recover.js';
import { runReviewCommand } from './commands/review.js';
import { printSchemaCommand } from './commands/schema.js';
import { setupWorkspaceCommand } from './commands/setup-workspace.js';
import { suppressionListCommand } from './commands/suppression-list.js';
import { suppressionRemoveCommand } from './commands/suppression-remove.js';
import {
  userCreateCommand,
  userDeleteCommand,
  userGrantCommand,
  userListCommand,
  userRevokeCommand,
  userSetPasswordCommand,
} from './commands/user.js';
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
    .description(
      'Run a PR review (VCS mode) or a local diff review (--local / --sample / --range / --diff-file).\n' +
        'VCS mode: requires --repo and --pr plus a GH token.\n' +
        'Local mode: only ANTHROPIC_API_KEY needed; no VCS credential required.',
    )
    // VCS mode options (not required when using local-mode flags)
    .option('--repo <repo>', "repository: 'owner/name' for github, '<name>' for codecommit")
    .option('--pr <n>', 'PR number (VCS mode)', (v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('--pr must be positive');
      return n;
    })
    .addOption(
      new Option('--platform <platform>', 'VCS platform (default: github)')
        .choices([...PLATFORMS])
        .default('github'),
    )
    // Shared options
    .option('--config <path>', 'path to .review-agent.yml', '.review-agent.yml')
    .option('--lang <code>', 'override output language (BCP 47)')
    .addOption(new Option('--profile <profile>', 'override review profile').choices([...PROFILES]))
    .option('--cost-cap-usd <usd>', 'cap total LLM spend per run', (v) => Number.parseFloat(v))
    // VCS mode only
    .option('--post', 'publish comments to the PR (VCS mode, default: dry run)', false)
    // Local mode options
    .option('--local [path]', 'local mode: review working-tree diff (optional path overrides cwd)')
    .option('--range <a..b>', 'local mode: review commits in range (e.g. HEAD~1..HEAD)')
    .option('--diff-file <file>', 'local mode: review a saved unified diff file')
    .option('--sample', 'local mode: review the bundled sample diff (no git repo required)')
    .option('--path <dir>', 'local mode: target directory for git diff commands')
    .option(
      '--fail-on <severity>',
      'local mode: exit non-zero when findings >= this severity (critical|major|minor|info)',
      'major',
    )
    .action(async (opts: ReviewCliOpts) => {
      // Determine whether this is a local-mode invocation.
      const isLocal =
        opts.local !== undefined ||
        opts.sample ||
        opts.range !== undefined ||
        opts.diffFile !== undefined;

      if (isLocal) {
        // ---- Local mode -----------------------------------------------
        const failOn = parseFailOn(opts.failOn ?? 'major');
        if (!failOn) {
          io.stderr(
            `--fail-on must be one of: critical, major, minor, info (got '${opts.failOn ?? ''}').\n`,
          );
          io.exit(1);
          return;
        }
        // --local [path] supplies optional path; --path is an explicit alias.
        const targetDir =
          opts.path ?? (typeof opts.local === 'string' ? opts.local : undefined) ?? process.cwd();
        const mode = opts.sample
          ? ('sample' as const)
          : opts.diffFile !== undefined
            ? ('diff-file' as const)
            : opts.range !== undefined
              ? ('range' as const)
              : ('working-tree' as const);
        const result = await runReviewCommand(io, {
          repo: opts.repo ?? '',
          pr: opts.pr ?? 0,
          configPath: opts.config,
          post: false,
          localMode: mode,
          localPath: targetDir,
          ...(opts.diffFile !== undefined ? { localDiffFile: opts.diffFile } : {}),
          ...(opts.range !== undefined ? { localRange: opts.range } : {}),
          failOn,
          ...(opts.lang ? { language: opts.lang } : {}),
          ...(opts.profile ? { profile: opts.profile } : {}),
          ...(opts.costCapUsd !== undefined ? { costCapUsd: opts.costCapUsd } : {}),
          env,
        });
        io.exit(result.exitCode ?? (result.status === 'reviewed' ? 0 : 1));
        return;
      }

      // ---- VCS mode (original path) ------------------------------------
      /* v8 ignore start */
      if (!opts.repo) {
        io.stderr(
          '--repo is required for VCS mode. ' +
            'Use --local / --sample / --range / --diff-file for local review without a PR.\n',
        );
        io.exit(1);
        return;
      }
      if (opts.pr === undefined || opts.pr <= 0) {
        io.stderr(
          '--pr is required for VCS mode. ' +
            'Use --local / --sample / --range / --diff-file for local review without a PR.\n',
        );
        io.exit(1);
        return;
      }
      /* v8 ignore stop */
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

  const suppression = program
    .command('suppression')
    .description(
      'Inspect and manage false-positive suppression rules (#155). ' +
        'Suppression rules are created automatically when the 👎 rejection threshold ' +
        '(`feedback.suppress_after`, default 3) is crossed for a finding fingerprint. ' +
        'Rules expire after 180 days (same TTL as all review_history rows).',
    );

  suppression
    .command('list')
    .description(
      'List all non-expired suppression rules for a repo. ' +
        'Each rule shows an ID, fingerprint, created date, and expiry date.',
    )
    .requiredOption(
      '--installation-id <id>',
      'GitHub App installation ID (or numeric account ID for CodeCommit)',
      (v) => BigInt(v),
    )
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .action(async (opts: SuppressionListCliOpts) => {
      const result = await suppressionListCommand(io, {
        installationId: opts.installationId,
        repo: opts.repo,
        env,
      });
      // exit-0 fires on 'ok' — both paths tested directly on
      // suppressionListCommand; reaching them through parseAsync requires
      // injecting createDb which the program-level surface does not expose.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  suppression
    .command('remove')
    .description(
      'Remove a suppression rule by its ID (from `suppression list`). ' +
        'The finding will reappear on the next review run.',
    )
    .requiredOption(
      '--installation-id <id>',
      'GitHub App installation ID (or numeric account ID for CodeCommit)',
      (v) => BigInt(v),
    )
    .requiredOption('--repo <owner/repo>', 'repository in `owner/name` format')
    .requiredOption('--rule-id <id>', 'review_history.id of the suppression rule', (v) => BigInt(v))
    .action(async (opts: SuppressionRemoveCliOpts) => {
      const result = await suppressionRemoveCommand(io, {
        installationId: opts.installationId,
        repo: opts.repo,
        ruleId: opts.ruleId,
        env,
      });
      // exit-0 arm fires on 'ok' / 'not_found'. Both tested directly on
      // suppressionRemoveCommand; reaching them through parseAsync needs an
      // injected createDb seam that the program-level surface lacks.
      /* v8 ignore next */
      io.exit(result.status === 'config_error' ? 1 : 0);
    });

  const user = program
    .command('user')
    .description('Dashboard user (operator principal) management (spec §18.x).');

  user
    .command('create')
    .description('Create a new operator principal, optionally granting a membership.')
    .requiredOption('--username <u>', 'login username')
    .addOption(
      new Option('--role <role>', 'membership role (default: viewer)').choices([
        'viewer',
        'editor',
        'admin',
      ]),
    )
    .option('--installation <id>', 'GitHub App installation ID to grant membership on')
    .option('--password <p>', 'plain-text password (omit to prompt interactively)')
    .option('--generate', 'generate a random password and print it once', false)
    .action(async (opts: UserCreateCliOpts) => {
      const parsed = opts.role !== undefined ? dashboardRoleSchema.safeParse(opts.role) : null;
      const result = await userCreateCommand(io, {
        username: opts.username,
        ...(parsed?.success ? { role: parsed.data } : {}),
        ...(opts.installation !== undefined ? { installation: opts.installation } : {}),
        ...(opts.password !== undefined ? { password: opts.password } : {}),
        generate: !!opts.generate,
        env,
      });
      // exit-0 arm fires on 'ok'. The 'already_exists' / 'validation_error'
      // / 'config_error' paths are tested directly on userCreateCommand.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  user
    .command('list')
    .description('List all operator principals and their memberships.')
    .action(async () => {
      const result = await userListCommand(io, { env });
      // exit-0 arm fires on 'ok'. Tested directly on userListCommand.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  user
    .command('set-password')
    .description("Update a principal's password (invalidates existing sessions).")
    .requiredOption('--username <u>', 'login username')
    .option('--password <p>', 'new plain-text password (omit to prompt interactively)')
    .option('--generate', 'generate a random password and print it once', false)
    .action(async (opts: UserSetPasswordCliOpts) => {
      const result = await userSetPasswordCommand(io, {
        username: opts.username,
        ...(opts.password !== undefined ? { password: opts.password } : {}),
        generate: !!opts.generate,
        env,
      });
      // exit-0 arm fires on 'ok'. Tested directly on userSetPasswordCommand.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  user
    .command('delete')
    .description('Delete an operator principal (also removes memberships via FK cascade).')
    .requiredOption('--username <u>', 'login username')
    .action(async (opts: UserDeleteCliOpts) => {
      const result = await userDeleteCommand(io, { username: opts.username, env });
      // exit-0 arm fires on 'ok'. Tested directly on userDeleteCommand.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  user
    .command('grant')
    .description('Grant (or update) a role for a principal on an installation.')
    .requiredOption('--username <u>', 'login username')
    .requiredOption('--installation <id>', 'GitHub App installation ID')
    .addOption(
      new Option('--role <role>', 'role to grant')
        .choices(['viewer', 'editor', 'admin'])
        .makeOptionMandatory(),
    )
    .action(async (opts: UserGrantCliOpts) => {
      const parsedRole = dashboardRoleSchema.safeParse(opts.role);
      const result = await userGrantCommand(io, {
        username: opts.username,
        installation: opts.installation,
        role: parsedRole.success ? parsedRole.data : ('viewer' as const),
        env,
      });
      // exit-0 arm fires on 'ok'. Tested directly on userGrantCommand.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
    });

  user
    .command('revoke')
    .description("Revoke a principal's membership on an installation.")
    .requiredOption('--username <u>', 'login username')
    .requiredOption('--installation <id>', 'GitHub App installation ID')
    .action(async (opts: UserRevokeCliOpts) => {
      const result = await userRevokeCommand(io, {
        username: opts.username,
        installation: opts.installation,
        env,
      });
      // exit-0 arm fires on 'ok'. Tested directly on userRevokeCommand.
      /* v8 ignore next */
      io.exit(result.status === 'ok' ? 0 : 1);
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
  // VCS mode
  repo?: string;
  pr?: number;
  config: string;
  platform: (typeof PLATFORMS)[number];
  lang?: string;
  profile?: (typeof PROFILES)[number];
  costCapUsd?: number;
  post?: boolean;
  // Local mode
  local?: string | boolean;
  range?: string;
  diffFile?: string;
  sample?: boolean;
  path?: string;
  failOn?: string;
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

type SuppressionListCliOpts = {
  installationId: bigint;
  repo: string;
};

type SuppressionRemoveCliOpts = {
  installationId: bigint;
  repo: string;
  ruleId: bigint;
};

type UserCreateCliOpts = {
  username: string;
  role?: string;
  installation?: string;
  password?: string;
  generate?: boolean;
};

type UserSetPasswordCliOpts = {
  username: string;
  password?: string;
  generate?: boolean;
};

type UserDeleteCliOpts = {
  username: string;
};

type UserGrantCliOpts = {
  username: string;
  installation: string;
  role: string;
};

type UserRevokeCliOpts = {
  username: string;
  installation: string;
};

export type { ProgramIo } from './io.js';
