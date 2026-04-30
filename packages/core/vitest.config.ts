import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/vcs.ts',
        'src/**/*.test.ts',
        'src/db/schema/index.ts',
        'src/db/schema/roles.ts',
        'src/db/schema/__tests__/**',
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
