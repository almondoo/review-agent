import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
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
  async onSuccess() {
    // Copy static asset so the bundled bin can read it via import.meta.url.
    await mkdir('dist/assets', { recursive: true });
    await copyFile('src/assets/sample-diff.txt', 'dist/assets/sample-diff.txt');
  },
});
