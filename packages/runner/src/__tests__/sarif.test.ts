import { describe, expect, it } from 'vitest';
import { parseSarif } from '../sarif.js';

// ---------------------------------------------------------------------------
// Minimal SARIF 2.1.0 fixture helpers
// ---------------------------------------------------------------------------

function makeSarif(overrides: Record<string, unknown> = {}): string {
  const base = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'TestTool',
            rules: [{ id: 'rule-001' }, { id: 'rule-002' }],
          },
        },
        results: [
          {
            ruleId: 'rule-001',
            level: 'error',
            message: { text: 'SQL injection vulnerability detected' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/db.ts' },
                  region: { startLine: 42 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
  return JSON.stringify({ ...base, ...overrides });
}

// ---------------------------------------------------------------------------
// Happy-path parsing
// ---------------------------------------------------------------------------

describe('parseSarif — happy path', () => {
  it('parses a minimal valid SARIF and returns one finding', () => {
    const result = parseSarif('TestTool', 'tool_wins', makeSarif());
    expect(result.name).toBe('TestTool');
    expect(result.mergePolicy).toBe('tool_wins');
    expect(result.findings).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('maps error level → major severity', () => {
    const result = parseSarif('TestTool', 'tool_wins', makeSarif());
    expect(result.findings[0]?.severity).toBe('major');
  });

  it('maps warning level → minor severity', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'warning',
              message: { text: 'warn' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'f.ts' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif('T', 'tool_wins', sarif).findings[0]?.severity).toBe('minor');
  });

  it('maps note level → info severity', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'note',
              message: { text: 'note' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'f.ts' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif('T', 'tool_wins', sarif).findings[0]?.severity).toBe('info');
  });

  it('maps missing level → minor severity (default)', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              message: { text: 'no level' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'f.ts' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif('T', 'tool_wins', sarif).findings[0]?.severity).toBe('minor');
  });

  it('sets side to RIGHT for all findings', () => {
    const result = parseSarif('TestTool', 'tool_wins', makeSarif());
    expect(result.findings[0]?.side).toBe('RIGHT');
  });

  it('sets confidence to high for all findings', () => {
    const result = parseSarif('TestTool', 'tool_wins', makeSarif());
    expect(result.findings[0]?.confidence).toBe('high');
  });

  it('extracts ruleId from result.ruleId field', () => {
    const result = parseSarif('TestTool', 'tool_wins', makeSarif());
    expect(result.findings[0]?.ruleId).toBe('rule-001');
  });

  it('resolves ruleId from ruleIndex when ruleId is absent', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'T',
              rules: [{ id: 'rule-from-index' }, { id: 'other' }],
            },
          },
          results: [
            {
              ruleIndex: 0,
              level: 'error',
              message: { text: 'via ruleIndex' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/a.ts' },
                    region: { startLine: 10 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = parseSarif('T', 'tool_wins', sarif);
    expect(result.findings[0]?.ruleId).toBe('rule-from-index');
  });

  it('falls back to toolName as ruleId when neither ruleId nor ruleIndex present', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'MyTool', rules: [] } },
          results: [
            {
              level: 'warning',
              message: { text: 'no rule' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/b.ts' },
                    region: { startLine: 5 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = parseSarif('MyTool', 'tool_wins', sarif);
    expect(result.findings[0]?.ruleId).toBe('MyTool');
  });

  it('prefixes body with [toolName]', () => {
    const result = parseSarif('TestTool', 'tool_wins', makeSarif());
    expect(result.findings[0]?.body).toContain('[TestTool]');
    expect(result.findings[0]?.body).toContain('SQL injection vulnerability detected');
  });

  it('strips leading "./" from path', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'warning',
              message: { text: 'x' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: './src/foo.ts' },
                    region: { startLine: 3 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif('T', 'tool_wins', sarif).findings[0]?.path).toBe('src/foo.ts');
  });

  it('handles file:// URI paths', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'warning',
              message: { text: 'x' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'file:///workspace/src/bar.ts' },
                    region: { startLine: 7 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const path = parseSarif('T', 'tool_wins', sarif).findings[0]?.path ?? '';
    expect(path).toContain('src/bar.ts');
  });

  it('processes multiple runs in a single SARIF document', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'Tool1', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'error',
              message: { text: 'finding from run 1' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'a.ts' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
        {
          tool: { driver: { name: 'Tool2', rules: [] } },
          results: [
            {
              ruleId: 'r2',
              level: 'warning',
              message: { text: 'finding from run 2' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'b.ts' },
                    region: { startLine: 2 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif('name', 'tool_wins', sarif).findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Skip / warn cases
// ---------------------------------------------------------------------------

describe('parseSarif — skip and warn paths', () => {
  it('skips results missing a physicalLocation and emits a warning', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'error',
              message: { text: 'no location at all' },
            },
          ],
        },
      ],
    });
    const result = parseSarif('T', 'tool_wins', sarif);
    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toContain('missing location/startLine');
  });

  it('skips results missing startLine and emits a warning', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'error',
              message: { text: 'no startLine' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'f.ts' },
                    region: {},
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = parseSarif('T', 'tool_wins', sarif);
    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toContain('missing location/startLine');
  });

  it('returns empty findings and a warning for invalid JSON', () => {
    const result = parseSarif('T', 'tool_wins', '{ not valid json !!');
    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toContain('not valid JSON');
  });

  it('returns empty findings and a warning when SARIF schema is invalid', () => {
    const result = parseSarif('T', 'tool_wins', JSON.stringify({ version: '2.1.0' }));
    expect(result.findings).toHaveLength(0);
    expect(result.warnings[0]).toContain('does not match expected schema');
  });
});

// ---------------------------------------------------------------------------
// Category inference
// ---------------------------------------------------------------------------

describe('parseSarif — category inference', () => {
  function makeSarifWithTags(tags: string[]): string {
    return JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          results: [
            {
              ruleId: 'r1',
              level: 'error',
              message: { text: 'x' },
              properties: { tags },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'f.ts' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  it('infers security category from "security" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['security']));
    expect(result.findings[0]?.category).toBe('security');
  });

  it('infers bug category from "correctness" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['correctness']));
    expect(result.findings[0]?.category).toBe('bug');
  });

  it('infers performance category from "performance" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['performance']));
    expect(result.findings[0]?.category).toBe('performance');
  });

  it('infers style category from "style" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['style']));
    expect(result.findings[0]?.category).toBe('style');
  });

  it('infers style category from "convention" tag (OR branch)', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['convention']));
    expect(result.findings[0]?.category).toBe('style');
  });

  it('infers test category from "test" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['test']));
    expect(result.findings[0]?.category).toBe('test');
  });

  it('infers docs category from "doc" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['doc']));
    expect(result.findings[0]?.category).toBe('docs');
  });

  it('infers docs category from "comment" tag (OR branch)', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['comment']));
    expect(result.findings[0]?.category).toBe('docs');
  });

  it('infers maintainability category from "maintainability" tag', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['maintainability']));
    expect(result.findings[0]?.category).toBe('maintainability');
  });

  it('infers maintainability category from "complex" tag (OR branch)', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags(['complex']));
    expect(result.findings[0]?.category).toBe('maintainability');
  });

  it('returns undefined category when no tags match', () => {
    const result = parseSarif('T', 'tool_wins', makeSarifWithTags([]));
    expect(result.findings[0]?.category).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases: missing rules / results in driver
// ---------------------------------------------------------------------------

describe('parseSarif — driver with no rules or results', () => {
  it('handles a run with no rules array in driver', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T' } }, // no rules key
          results: [
            {
              ruleId: 'r1',
              level: 'warning',
              message: { text: 'x' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'f.ts' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const result = parseSarif('T', 'tool_wins', sarif);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe('r1');
  });

  it('handles a run with no results array', () => {
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'T', rules: [] } },
          // no results key
        },
      ],
    });
    const result = parseSarif('T', 'tool_wins', sarif);
    expect(result.findings).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
