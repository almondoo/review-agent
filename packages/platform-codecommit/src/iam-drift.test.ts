import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_COMMANDS, EXPECTED_PERMISSIONS, PENDING_COMMANDS } from './iam.js';

const here = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = resolve(here, 'adapter.ts');
const README_PATH = resolve(here, '..', 'README.md');

/**
 * Extract every `new <X>Command(` occurrence from the adapter source.
 * `adapter.ts` does not build Command instances dynamically, so a regex
 * is sufficient — a full AST traversal would not catch any additional
 * cases that this regex misses.
 */
function extractCommandsFromAdapter(): ReadonlySet<string> {
  const src = readFileSync(ADAPTER_PATH, 'utf8');
  const found = new Set<string>();
  const re = /new\s+(\w+Command)\s*\(/g;
  for (const match of src.matchAll(re)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return found;
}

describe('IAM ↔ SDK Command drift', () => {
  const adapterCommands = extractCommandsFromAdapter();
  const registryCommands = new Set(EXPECTED_COMMANDS.map((pair) => pair.command));

  it('extracts at least one Command from adapter.ts (regex sanity)', () => {
    // Defensive: if the regex returned an empty set, the rest of the
    // assertions would pass vacuously. Fail loudly instead.
    expect(adapterCommands.size).toBeGreaterThan(0);
  });

  it('every Command used in adapter.ts has a registry entry', () => {
    const missing: string[] = [];
    for (const name of adapterCommands) {
      if (!registryCommands.has(name)) missing.push(name);
    }
    expect(
      missing,
      `adapter.ts uses Command(s) not listed in EXPECTED_COMMANDS — ` +
        `add them to src/iam.ts and the IAM block in spec §8.4 / README.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every non-pending registry entry is referenced from adapter.ts', () => {
    // The inverse direction: catches dead entries that bloat the IAM
    // block. Commands listed in `PENDING_COMMANDS` are intentionally
    // ahead of the code (docs lead implementation) and are excluded.
    const unused: string[] = [];
    for (const { command } of EXPECTED_COMMANDS) {
      if (PENDING_COMMANDS.has(command)) continue;
      if (!adapterCommands.has(command)) unused.push(command);
    }
    expect(
      unused,
      `EXPECTED_COMMANDS contains entries that adapter.ts no longer uses — ` +
        `remove them from src/iam.ts or move them to PENDING_COMMANDS: ${unused.join(', ')}`,
    ).toEqual([]);
  });

  it('every registry entry has a *Command-suffixed class name', () => {
    const malformed = EXPECTED_COMMANDS.filter((pair) => !pair.command.endsWith('Command'));
    expect(
      malformed,
      `EXPECTED_COMMANDS entries must reference SDK class names ending in "Command": ` +
        `${malformed.map((p) => p.command).join(', ')}`,
    ).toEqual([]);
  });

  it('every registry entry has a codecommit:-prefixed permission', () => {
    const malformed = EXPECTED_COMMANDS.filter(
      (pair) => !pair.permission.startsWith('codecommit:'),
    );
    expect(
      malformed,
      `EXPECTED_COMMANDS permission strings must start with "codecommit:": ` +
        `${malformed.map((p) => p.permission).join(', ')}`,
    ).toEqual([]);
  });

  it('every EXPECTED_PERMISSIONS entry is mentioned inside the README IAM block', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    // Narrow to the IAM JSON fenced block so a stray match elsewhere in
    // the README (e.g. an example) does not lull us into a false pass.
    const iamMatch = readme.match(/```json\s*([\s\S]*?)```/);
    expect(iamMatch, 'README.md must contain a ```json fenced IAM block').not.toBeNull();
    const iamBlock = iamMatch?.[1] ?? '';

    const missing: string[] = [];
    for (const permission of EXPECTED_PERMISSIONS) {
      if (!iamBlock.includes(permission)) missing.push(permission);
    }
    expect(
      missing,
      `permissions present in EXPECTED_PERMISSIONS but missing from README IAM block — ` +
        `update packages/platform-codecommit/README.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('UpdatePullRequestApprovalStateCommand is registered and wired (post issue #74)', () => {
    // Issue #74 wired `UpdatePullRequestApprovalStateCommand` into
    // adapter.ts, so the Command must appear in both the registry and
    // the adapter usage set. It is no longer in PENDING_COMMANDS.
    expect(registryCommands.has('UpdatePullRequestApprovalStateCommand')).toBe(true);
    expect(adapterCommands.has('UpdatePullRequestApprovalStateCommand')).toBe(true);
    expect(PENDING_COMMANDS.has('UpdatePullRequestApprovalStateCommand')).toBe(false);
  });
});
