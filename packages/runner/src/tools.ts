import { lstat, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { ToolDispatchRefusedError } from '@review-agent/core';
import { type Tool, tool } from 'ai';
import { z } from 'zod';

const DENY_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)secrets?(\/|$)/i,
  /(^|\/)private(\/|$)/i,
  /(^|\/)credentials?(\/|$)/i,
  /\.(key|pem|p12|pfx)$/i,
  /credentials.*\.json$/i,
  /service-account.*\.json$/i,
  /^\.aws\/credentials$/,
];

export const TOOL_NAMES = ['read_file', 'glob', 'grep'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type Tools = {
  read_file(args: { path: string }): Promise<string>;
  glob(args: { pattern: string }): Promise<ReadonlyArray<string>>;
  grep(args: { pattern: string; path?: string }): Promise<ReadonlyArray<string>>;
};

export type ToolDeps = {
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  readonly lstat?: typeof lstat;
  readonly readdir?: typeof readdir;
};

const MAX_FILE_SIZE = 1_000_000;
const MAX_GREP_PATTERN_LENGTH = 200;

function checkDenyList(rel: string): void {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(rel)) {
      throw new ToolDispatchRefusedError('read_file', `path matches deny-list: '${rel}'`);
    }
  }
}

async function resolveSafePath(
  workspace: string,
  requested: string,
  lstatFn: typeof lstat,
): Promise<string> {
  if (!requested) throw new ToolDispatchRefusedError('read_file', 'empty path');
  if (requested.includes('\0'))
    throw new ToolDispatchRefusedError('read_file', 'path contains NUL byte');
  if (path.isAbsolute(requested))
    throw new ToolDispatchRefusedError('read_file', `absolute path: '${requested}'`);
  if (requested.startsWith('~'))
    throw new ToolDispatchRefusedError('read_file', `home-expanded path: '${requested}'`);

  const absolute = path.resolve(workspace, requested);
  const rel = path.relative(workspace, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolDispatchRefusedError('read_file', `path escapes workspace: '${requested}'`);
  }
  checkDenyList(rel);

  let cursor = workspace;
  for (const segment of rel.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    const stat = await lstatFn(cursor).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new ToolDispatchRefusedError('read_file', `path traverses a symlink: '${rel}'`);
    }
  }

  return absolute;
}

export function createTools(workspace: string, deps: ToolDeps = {}): Tools {
  const readFn = (deps.readFile ?? readFile) as (p: string, enc: 'utf8') => Promise<string>;
  const lstatFn = deps.lstat ?? lstat;
  const readdirFn = deps.readdir ?? readdir;

  return {
    read_file: async ({ path: requested }) => {
      const absolute = await resolveSafePath(workspace, requested, lstatFn);
      const content = await readFn(absolute, 'utf8');
      if (content.length > MAX_FILE_SIZE) {
        return `${content.slice(0, MAX_FILE_SIZE)}\n[...truncated at ${MAX_FILE_SIZE} chars]`;
      }
      return content;
    },
    glob: async ({ pattern }) => {
      if (typeof pattern !== 'string' || !pattern) {
        throw new ToolDispatchRefusedError('glob', 'empty pattern');
      }
      if (pattern.includes('..')) {
        throw new ToolDispatchRefusedError('glob', `traversal pattern: '${pattern}'`);
      }
      return walkAndMatch(workspace, pattern, readdirFn);
    },
    grep: async ({ pattern, path: scope }) => {
      if (!pattern) throw new ToolDispatchRefusedError('grep', 'empty pattern');
      if (typeof pattern !== 'string') {
        throw new ToolDispatchRefusedError('grep', 'pattern must be a string');
      }
      if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
        throw new ToolDispatchRefusedError(
          'grep',
          `pattern too long (max ${MAX_GREP_PATTERN_LENGTH} chars) — defends against ReDoS`,
        );
      }
      let compiled: RegExp;
      try {
        compiled = new RegExp(pattern);
      } catch {
        throw new ToolDispatchRefusedError('grep', `invalid regex: '${pattern}'`);
      }
      const target = scope ? await resolveSafePath(workspace, scope, lstatFn) : workspace;
      return grepInDir(target, compiled, readdirFn, readFn);
    },
  };
}

async function walkAndMatch(
  root: string,
  pattern: string,
  readdirFn: typeof readdir,
): Promise<string[]> {
  const matcher = patternToRegExp(pattern);
  const out: string[] = [];
  await walk(root, root, matcher, out, readdirFn);
  return out;
}

async function walk(
  root: string,
  dir: string,
  matcher: RegExp,
  out: string[],
  readdirFn: typeof readdir,
): Promise<void> {
  const entries = await readdirFn(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (DENY_PATTERNS.some((p) => p.test(rel))) continue;
    if (e.isDirectory()) {
      await walk(root, full, matcher, out, readdirFn);
    } else if (e.isFile() && matcher.test(rel)) {
      out.push(rel);
    }
  }
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*');
  return new RegExp(`^${regex}$`);
}

async function grepInDir(
  scope: string,
  re: RegExp,
  readdirFn: typeof readdir,
  readFn: (p: string, enc: 'utf8') => Promise<string>,
): Promise<string[]> {
  const out: string[] = [];
  const walkAll = async (dir: string): Promise<void> => {
    const entries = await readdirFn(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(scope, full);
      if (DENY_PATTERNS.some((p) => p.test(rel))) continue;
      if (e.isDirectory()) await walkAll(full);
      else if (e.isFile()) {
        const text = await readFn(full, 'utf8').catch(() => '');
        text.split('\n').forEach((line, i) => {
          if (re.test(line)) out.push(`${rel}:${i + 1}: ${line}`);
        });
      }
    }
  };
  await walkAll(scope);
  return out;
}

export async function dispatchTool(name: string, args: unknown, tools: Tools): Promise<unknown> {
  if (!isToolName(name)) {
    throw new ToolDispatchRefusedError(name, 'tool not in whitelist');
  }
  if (typeof args !== 'object' || args === null) {
    throw new ToolDispatchRefusedError(name, 'invalid args (must be object)');
  }
  if (name === 'read_file') {
    return tools.read_file(args as { path: string });
  }
  if (name === 'glob') {
    return tools.glob(args as { pattern: string });
  }
  return tools.grep(args as { pattern: string; path?: string });
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as ReadonlyArray<string>).includes(name);
}

/**
 * Maximum number of agent steps (and therefore upper bound on tool
 * calls) per review. The AI SDK's `stopWhen: stepCountIs(N)` ends
 * the loop after the Nth step. Bounded both as a cost guard and
 * as a denial-of-service hardening against runaway tool use.
 *
 * Counted at the step granularity rather than the call granularity
 * because parallel tool calls within a single step share a single
 * LLM round-trip — and LLM round-trips are what we pay for.
 */
export const MAX_TOOL_CALLS = 20;

export type AiSdkToolSet = Readonly<Record<string, Tool>>;

export type AiSdkToolsOptions = {
  /** Workspace root. Every tool call is resolved relative to this directory. */
  readonly workspace: string;
  /** Test-only overrides for fs primitives — same shape as `createTools`. */
  readonly toolDeps?: ToolDeps;
  /** Called once per LLM-initiated tool invocation. Used for accounting. */
  readonly onCall?: (name: ToolName) => void;
};

const READ_FILE_DESCRIPTION =
  'Read a UTF-8 text file from the workspace. Path is relative to the workspace root (e.g. "src/index.ts"). Absolute paths, "~", traversal escapes, symlinks, and entries on the deny-list (".env*", "secrets/", ".pem", etc.) are refused.';
const GLOB_DESCRIPTION =
  'List workspace files matching a glob pattern (e.g. "src/**/*.ts"). "*" matches within a path segment; "**" matches across segments. Returns paths relative to the workspace root. Traversal patterns and deny-listed paths are excluded.';
const GREP_DESCRIPTION =
  'Search the workspace for lines matching a JavaScript regular expression. Optional "path" scopes the search to a subdirectory. Returns up to many "<file>:<line>: <text>" matches. Patterns longer than 200 chars are rejected as a ReDoS guard.';

const READ_FILE_INPUT = z.object({ path: z.string() }).strict();
const GLOB_INPUT = z.object({ pattern: z.string() }).strict();
const GREP_INPUT = z.object({ pattern: z.string(), path: z.string().optional() }).strict();

/**
 * Wrap the local `createTools` dispatcher in AI-SDK `Tool` objects so the LLM
 * can invoke `read_file` / `glob` / `grep` during a `generateText` call.
 *
 * The same workspace-isolation guarantees as `createTools` apply: every
 * call is validated by the underlying dispatcher before the LLM ever
 * sees the result. `onCall` is invoked **after** the input parse but
 * **before** the dispatch — the count tracks attempted calls including
 * those that get refused by the dispatcher.
 */
export function createAiSdkToolset(opts: AiSdkToolsOptions): AiSdkToolSet {
  const base = createTools(opts.workspace, opts.toolDeps);
  const onCall = opts.onCall;
  return {
    read_file: tool({
      description: READ_FILE_DESCRIPTION,
      inputSchema: READ_FILE_INPUT,
      execute: async ({ path: requested }) => {
        onCall?.('read_file');
        return base.read_file({ path: requested });
      },
    }),
    glob: tool({
      description: GLOB_DESCRIPTION,
      inputSchema: GLOB_INPUT,
      execute: async ({ pattern }) => {
        onCall?.('glob');
        return base.glob({ pattern });
      },
    }),
    grep: tool({
      description: GREP_DESCRIPTION,
      inputSchema: GREP_INPUT,
      execute: async ({ pattern, path: scope }) => {
        onCall?.('grep');
        const args: { pattern: string; path?: string } =
          scope === undefined ? { pattern } : { pattern, path: scope };
        return base.grep(args);
      },
    }),
  };
}
