import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const MAX_SKILL_BYTES = 50_000;

const FORBIDDEN_FENCED_LANGS = ['ba' + 'sh', 's' + 'h', 'shell', 'powershell', 'python'];
const SCRIPT_TAG_REGEX = /<script[\s\S]*?<\/script>/gi;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    version: z.string().max(32).optional(),
    applies_to: z.array(z.string().min(1)).default([]),
    priority: z.number().int().default(50),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export type Skill = {
  readonly source: string;
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
};

export type LoadSkillDeps = {
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  readonly resolve?: (request: string, from: string) => string;
};

export async function loadSkill(
  reference: string,
  workspaceRoot: string,
  deps: LoadSkillDeps = {},
): Promise<Skill> {
  const readFn = (deps.readFile ?? readFile) as (p: string, enc: 'utf8') => Promise<string>;
  const resolveFn = deps.resolve ?? defaultResolve;
  const skillFile = await locateSkillFile(reference, workspaceRoot, resolveFn);
  const text = await readFn(skillFile, 'utf8');
  if (text.length > MAX_SKILL_BYTES) {
    throw new Error(`Skill '${reference}' exceeds ${MAX_SKILL_BYTES} bytes; refusing to load.`);
  }
  const parsed = parseSkillText(text, reference);
  return { ...parsed, source: reference };
}

export async function loadSkills(
  references: ReadonlyArray<string>,
  workspaceRoot: string,
  deps: LoadSkillDeps = {},
): Promise<Skill[]> {
  return Promise.all(references.map((r) => loadSkill(r, workspaceRoot, deps)));
}

export type RenderSkillsOptions = {
  readonly changedPaths?: ReadonlyArray<string>;
};

export function renderSkillsBlock(
  skills: ReadonlyArray<Skill>,
  opts: RenderSkillsOptions = {},
): string {
  const filtered = filterByAppliesTo(skills, opts.changedPaths ?? []);
  const sorted = [...filtered].sort((a, b) => b.frontmatter.priority - a.frontmatter.priority);
  if (sorted.length === 0) return '';
  return sorted
    .map((s) => `### ${s.frontmatter.name}\n\n${stripScriptyContent(s.body).trim()}`)
    .join('\n\n');
}

function parseSkillText(
  text: string,
  reference: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const match = FRONTMATTER_REGEX.exec(text);
  if (!match) {
    throw new Error(
      `Skill '${reference}' is missing YAML frontmatter (expected --- ... --- block).`,
    );
  }
  const [, frontmatterText, body = ''] = match;
  const data = parseFrontmatter(frontmatterText ?? '');
  const result = SkillFrontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Skill '${reference}' frontmatter invalid: ${result.error.issues.map((i: { message: string }) => i.message).join('; ')}`,
    );
  }
  return { frontmatter: result.data, body };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    const arrayItem = /^\s*-\s+(.+)$/.exec(rawLine);
    if (arrayItem && currentArrayKey) {
      const arr = (out[currentArrayKey] as string[]) ?? [];
      arr.push(unquote(arrayItem[1] ?? ''));
      out[currentArrayKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const key = kv[1] as string;
    const rawValue = (kv[2] ?? '').trim();
    if (rawValue === '') {
      out[key] = [];
      currentArrayKey = key;
      continue;
    }
    currentArrayKey = null;
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      out[key] = Number(rawValue);
      continue;
    }
    if (rawValue === 'true' || rawValue === 'false') {
      out[key] = rawValue === 'true';
      continue;
    }
    out[key] = unquote(rawValue);
  }
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function filterByAppliesTo(
  skills: ReadonlyArray<Skill>,
  changedPaths: ReadonlyArray<string>,
): Skill[] {
  return skills.filter((s) => {
    if (s.frontmatter.applies_to.length === 0) return true;
    if (changedPaths.length === 0) return true;
    const matchers = s.frontmatter.applies_to.map(globToRegExp);
    return changedPaths.some((p) => matchers.some((m: RegExp) => m.test(p)));
  });
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*');
  return new RegExp(`^${re}$`);
}

function stripScriptyContent(body: string): string {
  let out = body.replace(SCRIPT_TAG_REGEX, '');
  for (const lang of FORBIDDEN_FENCED_LANGS) {
    const fenceRe = new RegExp(`\`\`\`\\s*${lang}\\b[\\s\\S]*?\`\`\``, 'gi');
    out = out.replace(fenceRe, '');
  }
  return out;
}

async function locateSkillFile(
  reference: string,
  workspaceRoot: string,
  resolveFn: (request: string, from: string) => string,
): Promise<string> {
  if (reference.startsWith('@') || /^[a-zA-Z][\w-]*$/.test(reference)) {
    const resolved = resolveFn(`${reference}/SKILL.md`, workspaceRoot);
    return resolved;
  }
  const abs = path.isAbsolute(reference) ? reference : path.resolve(workspaceRoot, reference);
  return path.join(abs, 'SKILL.md');
}

function defaultResolve(request: string, _from: string): string {
  throw new Error(
    `npm-distributed skills are not bundled in v0.1. Cannot resolve '${request}'. Use a relative path under .review-agent/skills/ instead.`,
  );
}
