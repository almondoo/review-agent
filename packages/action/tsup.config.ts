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
  // CJS deps bundled into the ESM output (e.g. yaml@2.8.x's
  // composer.js) call `require('process')`. tsup's default ESM shim
  // refuses dynamic require with `Error: Dynamic require of "..." is
  // not supported`. Wire `createRequire(import.meta.url)` into the
  // bundle banner so those `require()` calls resolve at runtime.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  noExternal: [
    '@review-agent/core',
    '@review-agent/llm',
    '@review-agent/runner',
    '@review-agent/config',
    '@review-agent/platform-github',
  ],
});
