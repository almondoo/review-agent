import { describe, expect, it } from 'vitest';
import { generateJsonSchema } from './json-schema.js';

describe('generateJsonSchema', () => {
  it('produces a non-empty JSON Schema', () => {
    const schema = generateJsonSchema();
    expect(schema).toBeTypeOf('object');
    expect(JSON.stringify(schema).length).toBeGreaterThan(100);
  });

  it('exports the top-level config name', () => {
    const schema = generateJsonSchema() as Record<string, unknown>;
    expect(JSON.stringify(schema)).toContain('ReviewAgentConfig');
  });
});
