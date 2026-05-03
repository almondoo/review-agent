import type { ProgramIo } from '../io.js';

// `review-agent setup workspace` — opt-in onboarding helper for
// Anthropic Workspace configuration (spec §22 #3 / v1.0 #50). The
// default mode prints a manual checklist; `--api` calls the
// Anthropic Admin API directly to create a workspace and set a
// spend cap, requiring `ANTHROPIC_ADMIN_KEY` (NOT the per-workspace
// API key). The Admin key is sensitive — we never log it.
//
// Provider scope: Anthropic-only today. The command name reads
// naturally for other providers (`setup workspace --provider openai`)
// if/when those APIs gain equivalent endpoints.

export type SetupWorkspaceOpts = {
  /** Use the Anthropic Admin API instead of printing manual steps. */
  readonly api?: boolean;
  /** Workspace name (label only). Defaults to `review-agent`. */
  readonly name?: string;
  /** Per-workspace monthly spend cap in USD. Defaults to 50. */
  readonly spendCapUsd?: number;
  /** Process env. */
  readonly env: NodeJS.ProcessEnv;
  /** Test seam: HTTP fetcher for the Anthropic Admin API. */
  readonly fetchFn?: typeof fetch;
};

export type SetupWorkspaceResult = {
  readonly status: 'manual' | 'api_ok' | 'api_failed' | 'auth_failed';
  readonly workspaceId?: string;
  readonly errorMessage?: string;
};

const DEFAULT_NAME = 'review-agent';
const DEFAULT_SPEND_CAP_USD = 50;
const ADMIN_KEY_ENV = 'ANTHROPIC_ADMIN_KEY';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

export async function setupWorkspaceCommand(
  io: ProgramIo,
  opts: SetupWorkspaceOpts,
): Promise<SetupWorkspaceResult> {
  const name = opts.name ?? DEFAULT_NAME;
  const spendCapUsd = opts.spendCapUsd ?? DEFAULT_SPEND_CAP_USD;

  if (!opts.api) {
    printManualChecklist(io, { name, spendCapUsd });
    return { status: 'manual' };
  }

  const adminKey = opts.env[ADMIN_KEY_ENV];
  if (!adminKey) {
    io.stderr(
      `${ADMIN_KEY_ENV} is required for --api mode.\n` +
        'Generate one in console.anthropic.com → Settings → Admin Keys.\n' +
        'The Admin key is distinct from your per-workspace API key — never reuse it for inference.\n',
    );
    return { status: 'auth_failed' };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  return runApiSetup(io, fetchFn, adminKey, { name, spendCapUsd });
}

function printManualChecklist(
  io: ProgramIo,
  { name, spendCapUsd }: { readonly name: string; readonly spendCapUsd: number },
): void {
  io.stdout(
    [
      `# review-agent setup workspace — manual checklist`,
      ``,
      `Anthropic Workspaces give review-agent isolated billing,`,
      `spend caps, and Zero Data Retention (ZDR). Follow these steps`,
      `once per Anthropic organization.`,
      ``,
      `## 1. Create a Workspace`,
      `   - Open https://console.anthropic.com/settings/workspaces`,
      `   - Click "Create workspace"`,
      `   - Name: ${name}  (or any label your org uses)`,
      `   - Description: "code review agent — BYOK self-hosted"`,
      ``,
      `## 2. Enable Zero Data Retention (ZDR)`,
      `   - In the new workspace's Settings tab, toggle ZDR to "on".`,
      `   - ZDR keeps prompts + completions out of long-term storage.`,
      `     Required for diff review against private code.`,
      ``,
      `## 3. Set a spend cap`,
      `   - Settings → Spend Limits → set per-month cap to USD ${spendCapUsd}.`,
      `   - Lower for low-volume orgs; raise after a week of measured cost.`,
      `   - Spend caps are HARD: requests get rejected with 402 once hit.`,
      ``,
      `## 4. Issue a workspace-scoped API key`,
      `   - Settings → API Keys → Create key`,
      `   - Scope: this workspace only.`,
      `   - Copy the key once — it cannot be retrieved later.`,
      ``,
      `## 5. Wire it into your deployment`,
      ``,
      `   .review-agent.yml:`,
      `     provider:`,
      `       type: anthropic`,
      `       model: claude-sonnet-4-6`,
      ``,
      `   .env (or your secret manager):`,
      `     ANTHROPIC_API_KEY=<the key from step 4>`,
      ``,
      `## 6. Verify`,
      ``,
      `   review-agent review --repo owner/name --pr 1   # dry run`,
      ``,
      `Re-run this command with --api to perform steps 1 + 3 via the`,
      `Anthropic Admin API instead of clicking. Requires ${ADMIN_KEY_ENV}.`,
      ``,
    ].join('\n'),
  );
}

async function runApiSetup(
  io: ProgramIo,
  fetchFn: typeof fetch,
  adminKey: string,
  args: { readonly name: string; readonly spendCapUsd: number },
): Promise<SetupWorkspaceResult> {
  // Surface the ZDR-not-automatable caveat BEFORE the first network
  // call so the operator sees it whether or not the API setup later
  // succeeds. The Anthropic Admin API does not expose a ZDR toggle;
  // the operator must enable it manually in the console regardless
  // of which mode this command runs in.
  io.stdout(
    'Note: ZDR cannot be enabled via the Anthropic Admin API. After this command finishes, enable ZDR manually in console.anthropic.com → workspace → Settings.\n',
  );
  const headers = {
    'x-api-key': adminKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  let workspaceId: string;
  try {
    const created = await fetchFn(`${ANTHROPIC_API_BASE}/v1/organizations/workspaces`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: args.name }),
    });
    if (!created.ok) {
      const body = await safeText(created);
      io.stderr(`Workspace create failed: ${created.status} ${created.statusText}\n${body}\n`);
      return { status: 'api_failed', errorMessage: `${created.status} ${created.statusText}` };
    }
    const json = (await created.json()) as { id?: string };
    if (!json.id) {
      io.stderr('Workspace create returned no id; cannot continue.\n');
      return { status: 'api_failed', errorMessage: 'missing workspace id in response' };
    }
    workspaceId = json.id;
    io.stdout(`Created workspace '${args.name}' (id=${workspaceId}).\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Workspace create error: ${message}\n`);
    return { status: 'api_failed', errorMessage: message };
  }

  try {
    const cap = await fetchFn(
      `${ANTHROPIC_API_BASE}/v1/organizations/workspaces/${workspaceId}/spend_limit`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ limit_usd_per_month: args.spendCapUsd }),
      },
    );
    if (!cap.ok) {
      const body = await safeText(cap);
      io.stderr(`Spend cap set failed: ${cap.status} ${cap.statusText}\n${body}\n`);
      return {
        status: 'api_failed',
        workspaceId,
        errorMessage: `${cap.status} ${cap.statusText}`,
      };
    }
    io.stdout(`Set monthly spend cap to USD ${args.spendCapUsd}.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Spend cap error: ${message}\n`);
    return { status: 'api_failed', workspaceId, errorMessage: message };
  }

  io.stdout(
    [
      ``,
      `Next steps (manual):`,
      `  1. In console.anthropic.com → workspace '${args.name}' → Settings,`,
      `     enable ZDR. The Admin API does not expose ZDR toggling.`,
      `  2. Settings → API Keys → Create a workspace-scoped key.`,
      `     Copy it once — it cannot be retrieved later.`,
      `  3. Set ANTHROPIC_API_KEY=<that key> in your deployment env.`,
      ``,
      `.review-agent.yml snippet:`,
      `  provider:`,
      `    type: anthropic`,
      `    model: claude-sonnet-4-6`,
      ``,
      `Workspace id: ${workspaceId}`,
      ``,
    ].join('\n'),
  );

  return { status: 'api_ok', workspaceId };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
