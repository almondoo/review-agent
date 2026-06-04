import { BUNDLED_PRESET_NAMES } from '@review-agent/config';
import type { ProgramIo } from '../io.js';

export type ListPresetsResult = {
  readonly presets: ReadonlyArray<string>;
};

/**
 * Lists all bundled preset names to stdout, one per line. Intended as the
 * implementation behind `review-agent config presets list`.
 */
export function listPresetsCommand(io: ProgramIo): ListPresetsResult {
  const presets = [...BUNDLED_PRESET_NAMES].sort();
  io.stdout('Bundled presets:\n');
  for (const name of presets) {
    io.stdout(`  ${name}\n`);
  }
  io.stdout(
    '\nUse in .review-agent.yml:\n' +
      '  extends: <preset-name>\n' +
      '  extends: [<preset1>, <preset2>]\n',
  );
  return { presets };
}
