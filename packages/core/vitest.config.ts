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
        // These schema files contain only Drizzle FK thunks (()=>ref) and table-builder
        // callbacks that v8 counts as functions but that are never invoked via getTableConfig.
        // Structural correctness is verified in schema.test.ts via getTableConfig assertions.
        'src/db/schema/repos.ts',
        'src/db/schema/installation-memberships.ts',
        'src/db/schema/__tests__/**',
        'src/kms/index.ts',
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
