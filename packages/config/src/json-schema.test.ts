import { describe, expect, it } from 'vitest';
import { generateJsonSchema } from './json-schema.js';

describe('generateJsonSchema', () => {
  it('exports a JSON Schema referencing ReviewAgentConfig', () => {
    const schema = generateJsonSchema() as {
      $ref?: string;
      definitions?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
    };
    expect(schema.$ref).toBe('#/definitions/ReviewAgentConfig');
    expect(schema.definitions).toBeDefined();
    expect(schema.definitions?.ReviewAgentConfig).toBeDefined();
  });

  it('describes every top-level config field from the Zod source', () => {
    const schema = generateJsonSchema() as {
      definitions: Record<string, { properties: Record<string, unknown> }>;
    };
    const props = schema.definitions.ReviewAgentConfig?.properties ?? {};
    // These keys come straight from `ConfigSchema` in schema.ts. A regression
    // that drops a section (e.g. `cost`) would silently strip the schema
    // surface that downstream consumers rely on for IDE completion.
    for (const required of [
      'extends',
      'language',
      'profile',
      'provider',
      'reviews',
      'cost',
      'privacy',
      'repo',
      'skills',
      'incremental',
    ]) {
      expect(props[required], `expected '${required}' in JSON Schema properties`).toBeDefined();
    }
  });

  it('inlines the language enum so editors offer the supported BCP-47 codes', () => {
    const schema = generateJsonSchema() as {
      definitions: Record<
        string,
        { properties: Record<string, { enum?: string[]; default?: string }> }
      >;
    };
    const language = schema.definitions.ReviewAgentConfig?.properties?.language;
    expect(language?.enum).toContain('en-US');
    expect(language?.enum).toContain('ja-JP');
    expect(language?.default).toBe('en-US');
  });
});
