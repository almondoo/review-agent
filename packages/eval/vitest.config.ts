import { defineConfig } from 'vitest/config';

// Only the pure scoring core is unit-tested here. The runner CLIs are
// thin I/O wrappers exercised by the corresponding promptfoo workflows;
// the heavy validation lives in *-validate.ts scripts already covered
// by golden-validate.ts / red-team-validate.ts patterns.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['scripts/severity-consistency-core.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
