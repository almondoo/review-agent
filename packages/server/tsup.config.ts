import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/serverless.ts', 'src/node.ts', 'src/notification/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'node24',
  outDir: 'dist',
});
