import { defineConfig } from 'tsup';

// Integration tests run inside a real VS Code instance, so they build like the
// extension does: `vscode` from the host, everything else bundled. Output lands
// in dist-test/, which .vscodeignore excludes from the .vsix.
export default defineConfig({
  entry: ['src/test-integration/index.ts', 'src/test-integration/runTest.ts'],
  outDir: 'dist-test',
  format: ['cjs'],
  external: ['vscode', '@vscode/test-electron'],
  noExternal: ['@ordewell/core'],
  clean: true,
  splitting: false,
  sourcemap: false,
  treeshake: true,
  esbuildOptions(options) {
    options.logOverride = {
      ...(options.logOverride ?? {}),
      // Same as tsup.config.ts: @ordewell/core is `sideEffects: false`, so
      // dropping its split chunks' bare imports is safe, not worth a warning.
      'ignored-bare-import': 'silent',
    };
  },
});
