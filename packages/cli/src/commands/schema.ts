import { generateJsonSchema } from '@review-agent/config';
import type { ProgramIo } from '../io.js';

// Prints the live JSON Schema for `.review-agent.yml` to stdout. Useful
// for `review-agent config schema > schema/v1.json` to keep the committed
// copy in sync.
export function printSchemaCommand(io: ProgramIo): void {
  const schema = generateJsonSchema();
  io.stdout(`${JSON.stringify(schema, null, 2)}\n`);
}
