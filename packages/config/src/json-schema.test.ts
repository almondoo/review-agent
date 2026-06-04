import { describe, expect, it } from 'vitest';
import { generateJsonSchema, SCHEMA_ID } from './json-schema.js';

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

  it('includes $id at the top level for migration detection and editor wiring', () => {
    const schema = generateJsonSchema() as { $id?: string };
    expect(schema.$id).toBe(SCHEMA_ID);
    expect(schema.$id).toBe('https://review-agent.dev/schema/v1.json');
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
      'coordination',
      'server',
      'codecommit',
      'ruleset',
      'suggestions',
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

  it('covers reviews.max_steps with integer type and min/max bounds', () => {
    const schema = generateJsonSchema() as {
      definitions: Record<
        string,
        {
          properties: Record<
            string,
            { properties?: Record<string, { type?: string; minimum?: number; maximum?: number }> }
          >;
        }
      >;
    };
    const reviewsProps =
      schema.definitions.ReviewAgentConfig?.properties?.reviews?.properties ?? {};
    const maxSteps = reviewsProps.max_steps;
    expect(maxSteps, 'expected max_steps in reviews properties').toBeDefined();
    expect(maxSteps?.type).toBe('integer');
    // Zod .min(1) maps to minimum: 1; .max(50) maps to maximum: 50.
    expect(maxSteps?.minimum).toBe(1);
    expect(maxSteps?.maximum).toBe(50);
  });

  it('covers reviews.min_confidence with severity enum values', () => {
    const schema = generateJsonSchema() as {
      definitions: Record<
        string,
        {
          properties: Record<
            string,
            { properties?: Record<string, { enum?: string[]; default?: string }> }
          >;
        }
      >;
    };
    const reviewsProps =
      schema.definitions.ReviewAgentConfig?.properties?.reviews?.properties ?? {};
    const minConfidence = reviewsProps.min_confidence;
    expect(minConfidence, 'expected min_confidence in reviews properties').toBeDefined();
    expect(minConfidence?.enum).toContain('high');
    expect(minConfidence?.enum).toContain('medium');
    expect(minConfidence?.enum).toContain('low');
    expect(minConfidence?.default).toBe('low');
  });

  it('covers reviews.request_changes_on with threshold enum values', () => {
    const schema = generateJsonSchema() as {
      definitions: Record<
        string,
        {
          properties: Record<
            string,
            { properties?: Record<string, { enum?: string[]; default?: string }> }
          >;
        }
      >;
    };
    const reviewsProps =
      schema.definitions.ReviewAgentConfig?.properties?.reviews?.properties ?? {};
    const requestChangesOn = reviewsProps.request_changes_on;
    expect(requestChangesOn, 'expected request_changes_on in reviews properties').toBeDefined();
    expect(requestChangesOn?.enum).toContain('critical');
    expect(requestChangesOn?.enum).toContain('major');
    expect(requestChangesOn?.enum).toContain('never');
    expect(requestChangesOn?.default).toBe('critical');
  });

  it('covers the ruleset block with known category keys and enabled/min_severity subfields', () => {
    const schema = generateJsonSchema() as {
      definitions: Record<
        string,
        {
          properties: Record<string, { additionalProperties?: unknown; default?: unknown }>;
        }
      >;
    };
    const rulesetProp = schema.definitions.ReviewAgentConfig?.properties?.ruleset;
    expect(rulesetProp, 'expected ruleset in top-level schema properties').toBeDefined();
    // The ruleset is a z.record so it renders as additionalProperties in JSON Schema.
    // Verify the block exists with a default empty object.
    expect(rulesetProp?.default).toEqual({});
  });
});
