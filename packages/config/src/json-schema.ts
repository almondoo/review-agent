import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConfigSchema } from './schema.js';

// Stable $id URL for this schema version. Included at the top level so
// editors and tooling can use it as the canonical schema identifier and
// future migration tooling can detect breaking changes by comparing the $id.
export const SCHEMA_ID = 'https://review-agent.dev/schema/v1.json';

export function generateJsonSchema(): Record<string, unknown> {
  const base = zodToJsonSchema(ConfigSchema, {
    name: 'ReviewAgentConfig',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // zod-to-json-schema 3.x does not emit $id directly. We splice it in at
  // the top level so downstream consumers (editors, AJV, etc.) see it.
  return { $id: SCHEMA_ID, ...base };
}
