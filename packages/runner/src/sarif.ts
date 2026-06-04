/**
 * SARIF 2.1.0 ingestion for external static-analysis tool integration (#160).
 *
 * This module is pure (no fs I/O). The caller (entry-point: action/cli) reads
 * the SARIF file content and passes it as a string. The runner merges the
 * returned NormalizedFinding list with AI findings in agent.ts.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 * We parse a minimal subset sufficient for code-review annotation.
 */

import type { Category, Severity } from '@review-agent/core';
import type { ReviewOutputComment } from '@review-agent/llm';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// SARIF 2.1.0 minimal Zod schema
// ---------------------------------------------------------------------------

const SarifRegionSchema = z
  .object({
    startLine: z.number().int().positive().optional(),
  })
  .passthrough();

const SarifPhysicalLocationSchema = z
  .object({
    artifactLocation: z
      .object({
        uri: z.string().optional(),
      })
      .passthrough()
      .optional(),
    region: SarifRegionSchema.optional(),
  })
  .passthrough();

const SarifLocationSchema = z
  .object({
    physicalLocation: SarifPhysicalLocationSchema.optional(),
  })
  .passthrough();

const SarifRuleSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

const SarifDriverSchema = z
  .object({
    name: z.string().default('unknown'),
    rules: z.array(SarifRuleSchema).optional(),
  })
  .passthrough();

const SarifToolSchema = z
  .object({
    driver: SarifDriverSchema,
  })
  .passthrough();

const SarifResultSchema = z
  .object({
    ruleId: z.string().optional(),
    ruleIndex: z.number().int().nonnegative().optional(),
    level: z.string().optional(),
    message: z
      .object({
        text: z.string().default(''),
      })
      .passthrough(),
    locations: z.array(SarifLocationSchema).optional(),
    properties: z
      .object({
        tags: z.array(z.string()).optional(),
        kind: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const SarifRunSchema = z
  .object({
    tool: SarifToolSchema,
    results: z.array(SarifResultSchema).optional(),
  })
  .passthrough();

const SarifSchema = z
  .object({
    runs: z.array(SarifRunSchema),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Normalisation types
// ---------------------------------------------------------------------------

/**
 * A single finding normalised from SARIF into a shape compatible with
 * `ReviewOutputComment`, plus the originating tool name for body
 * annotation and merge-policy labels.
 */
export type NormalizedFinding = ReviewOutputComment & {
  /** The tool name that produced this finding (from SARIF `runs[].tool.driver.name`). */
  readonly toolName: string;
};

/**
 * Result of parsing a single SARIF content string for one configured tool.
 */
export type SarifParseResult = {
  /** The configured display name for this tool (from `.review-agent.yml`). */
  readonly name: string;
  /** The configured merge policy for this tool. */
  readonly mergePolicy: 'tool_wins' | 'annotate' | 'ai_wins';
  /** Normalised findings extracted from all `runs` in the SARIF document. */
  readonly findings: ReadonlyArray<NormalizedFinding>;
};

// ---------------------------------------------------------------------------
// SARIF level → Severity mapping
// ---------------------------------------------------------------------------

function levelToSeverity(level: string | undefined): Severity {
  switch (level) {
    case 'error':
      return 'major';
    case 'warning':
      return 'minor';
    case 'note':
      return 'info';
    default:
      return 'minor';
  }
}

// ---------------------------------------------------------------------------
// Path normalisation: strip leading "./" and URI-scheme prefixes
// ---------------------------------------------------------------------------

function normalizePath(uri: string): string {
  // Strip common URI prefixes that some tools emit (e.g. "file:///src/foo.ts")
  let p = uri;
  try {
    const parsed = new URL(uri);
    // Use the pathname; URL parsing handles percent-encoding.
    p = parsed.pathname;
    // Remove a leading slash if present (absolute → relative-looking path)
    if (p.startsWith('/')) p = p.slice(1);
  } catch {
    // Not a URL — use the raw string.
  }
  // Strip leading "./"
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

// ---------------------------------------------------------------------------
// Category inference from SARIF result properties
// ---------------------------------------------------------------------------

const SECURITY_TAGS = new Set(['security', 'injection', 'auth', 'crypto', 'ssrf', 'xss', 'sqli']);
const BUG_TAGS = new Set(['bug', 'correctness', 'null-deref', 'error', 'reliability']);

function inferCategory(result: z.infer<typeof SarifResultSchema>): Category | undefined {
  const tags = result.properties?.tags ?? [];
  const kind = result.properties?.kind ?? '';

  const combined = [...tags.map((t) => t.toLowerCase()), kind.toLowerCase()];

  for (const t of combined) {
    if (SECURITY_TAGS.has(t)) return 'security';
  }
  for (const t of combined) {
    if (BUG_TAGS.has(t)) return 'bug';
  }
  if (combined.some((t) => t.includes('performance'))) return 'performance';
  if (combined.some((t) => t.includes('style') || t.includes('convention'))) return 'style';
  if (combined.some((t) => t.includes('test'))) return 'test';
  if (combined.some((t) => t.includes('doc') || t.includes('comment'))) return 'docs';
  if (combined.some((t) => t.includes('maintain') || t.includes('complex')))
    return 'maintainability';

  return undefined;
}

// ---------------------------------------------------------------------------
// Warn sink — pure (caller injects nothing; we use a simple array return)
// ---------------------------------------------------------------------------

/**
 * Parse a SARIF 2.1.0 JSON string for one configured tool and return
 * normalised findings.
 *
 * - Invalid JSON or SARIF schema mismatch → returns empty findings (never throws).
 * - Results missing a physical location or startLine are skipped.
 * - `warnings` accumulates human-readable diagnostics for the caller to log.
 */
export function parseSarif(
  name: string,
  mergePolicy: 'tool_wins' | 'annotate' | 'ai_wins',
  sarifContent: string,
): SarifParseResult & { readonly warnings: ReadonlyArray<string> } {
  const warnings: string[] = [];

  // --- 1. Parse JSON ---
  let raw: unknown;
  try {
    raw = JSON.parse(sarifContent);
  } catch {
    warnings.push(`[${name}] SARIF content is not valid JSON — skipping all findings.`);
    return { name, mergePolicy, findings: [], warnings };
  }

  // --- 2. Validate against SARIF schema ---
  const parsed = SarifSchema.safeParse(raw);
  if (!parsed.success) {
    warnings.push(
      `[${name}] SARIF content does not match expected schema — skipping all findings.`,
    );
    return { name, mergePolicy, findings: [], warnings };
  }

  const findings: NormalizedFinding[] = [];

  for (const run of parsed.data.runs) {
    const toolName = run.tool.driver.name;
    const rules = run.tool.driver.rules ?? [];
    const results = run.results ?? [];

    for (const result of results) {
      // --- Resolve ruleId ---
      let ruleId: string | undefined = result.ruleId;
      if (!ruleId && result.ruleIndex !== undefined) {
        ruleId = rules[result.ruleIndex]?.id;
      }
      if (!ruleId) {
        // Fall back to tool name as a coarse rule id.
        ruleId = toolName;
      }

      // --- Extract location ---
      const loc = result.locations?.[0];
      const physLoc = loc?.physicalLocation;
      const uriRaw = physLoc?.artifactLocation?.uri;
      const startLine = physLoc?.region?.startLine;

      if (!uriRaw || startLine === undefined) {
        warnings.push(`[${name}] Result (ruleId=${ruleId}) missing location/startLine — skipped.`);
        continue;
      }

      const path = normalizePath(uriRaw);
      const severity = levelToSeverity(result.level);
      const category = inferCategory(result);
      const body = `[${toolName}] ${result.message.text}`;

      const finding: NormalizedFinding = {
        path,
        line: startLine,
        side: 'RIGHT',
        body,
        severity,
        confidence: 'high',
        ruleId,
        toolName,
        ...(category !== undefined ? { category } : {}),
      };

      findings.push(finding);
    }
  }

  return { name, mergePolicy, findings, warnings };
}
