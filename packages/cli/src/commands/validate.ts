import { readFile as fsReadFile } from 'node:fs/promises';
import { ConfigSchema } from '@review-agent/config';
import { LineCounter, parseDocument } from 'yaml';
import type { ProgramIo } from '../io.js';

export type ValidateConfigOpts = {
  readonly path: string;
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
};

export type ValidateConfigResult = {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<ValidationIssue>;
};

export type ValidationIssue = {
  readonly path: string;
  readonly message: string;
  readonly line?: number;
};

export async function validateConfigCommand(
  io: ProgramIo,
  opts: ValidateConfigOpts,
): Promise<ValidateConfigResult> {
  const readFile = opts.readFile ?? defaultReadFile;
  let yamlText: string;
  try {
    yamlText = await readFile(opts.path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Failed to read ${opts.path}: ${message}\n`);
    return { ok: false, issues: [{ path: opts.path, message }] };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter });
  if (doc.errors.length > 0) {
    const issues: ValidationIssue[] = doc.errors.map((e) => {
      const issue: ValidationIssue = { path: opts.path, message: e.message };
      const offset = e.pos?.[0];
      if (typeof offset === 'number') {
        const pos = lineCounter.linePos(offset);
        return { ...issue, line: pos.line };
      }
      return issue;
    });
    printIssues(io, opts.path, issues);
    return { ok: false, issues };
  }

  const parsed = doc.toJS() ?? {};
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((i) => {
      const dottedPath = i.path.join('.') || '<root>';
      const line = locateLine(doc, lineCounter, i.path);
      const issue: ValidationIssue = { path: dottedPath, message: i.message };
      return line === undefined ? issue : { ...issue, line };
    });
    printIssues(io, opts.path, issues);
    return { ok: false, issues };
  }

  io.stdout(`OK: ${opts.path} is valid.\n`);
  return { ok: true, issues: [] };
}

function defaultReadFile(p: string, enc: 'utf8'): Promise<string> {
  return fsReadFile(p, enc as BufferEncoding).then(String);
}

function locateLine(
  doc: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
  path: ReadonlyArray<string | number>,
): number | undefined {
  if (path.length === 0) return undefined;
  const node = doc.getIn(path, true) as { range?: ReadonlyArray<number> } | undefined;
  const start = node?.range?.[0];
  if (typeof start !== 'number') return undefined;
  return lineCounter.linePos(start).line;
}

function printIssues(io: ProgramIo, file: string, issues: ReadonlyArray<ValidationIssue>): void {
  io.stderr(`Invalid ${file}:\n`);
  for (const issue of issues) {
    const where = issue.line === undefined ? '' : `:${issue.line}`;
    io.stderr(`  ${issue.path}${where} — ${issue.message}\n`);
  }
}
