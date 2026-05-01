import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts', 'src/defaults.ts', 'src/**/*.test.ts'],
      thresholds: {
        // Lowered for v0.3 #31: the dynamic-import default
        // model factories in azure-openai/bedrock/google/vertex/
        // openai-compatible only execute when the corresponding
        // SDK is present at runtime. Those factories exist
        // specifically to keep the SDKs as optional peers; they
        // are exercised by integration tests against a live
        // endpoint, not by unit tests.
        lines: 75,
        functions: 70,
        branches: 70,
        statements: 75,
      },
    },
  },
});
