import { defineConfig } from 'vitest/config';

// migrate.ts is a thin wrapper around drizzle's migrator and is exercised by
// the integration suite (TEST_DATABASE_URL). connection.ts has unit-level
// option-passing logic worth covering directly.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/connection.ts'],
      exclude: [
        'src/index.ts',
        'src/cli/**',
        'src/migrate.ts',
        'src/**/*.test.ts',
        'src/__tests__/**',
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
