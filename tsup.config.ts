import { defineConfig } from 'tsup';

// Step 1 of the build: TypeScript → .build/ (dependencies external). Step 2 (ncc, see the build
// script) bundles each entry with its dependencies into dist/, which the Action runs as is.
export default defineConfig({
  entry: { bin: 'src/bin.ts', action: 'src/action.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: '.build',
  clean: true,
  splitting: false,
  skipNodeModulesBundle: true,
});
