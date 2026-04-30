import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'node24',
  outDir: 'dist',
  bundle: true,
  noExternal: [
    '@review-agent/core',
    '@review-agent/llm',
    '@review-agent/runner',
    '@review-agent/config',
    '@review-agent/platform-github',
  ],
});
