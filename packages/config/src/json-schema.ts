import { zodToJsonSchema } from 'zod-to-json-schema';
import { ConfigSchema } from './schema.js';

export function generateJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ConfigSchema, {
    name: 'ReviewAgentConfig',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}
