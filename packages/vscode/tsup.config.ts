import { defineConfig } from 'tsup';

export default defineConfig({
  // harnessHost.ts is a second, vscode-free entry point so bench/live's
  // webview harness can import the real ConversationViewHost from a built
  // file that never requires('vscode') (extension.js does, at load time).
  entry: ['src/extension.ts', 'src/harnessHost.ts'],
  outDir: 'dist',
  format: ['cjs'],
  // Only `vscode` is provided by the host. Everything else — including
  // @ordewell/core and its deps — is bundled so the .vsix is self-contained.
  //
  // tsup externalises everything in `dependencies` by default and `external`
  // only adds to that list, so naming @ordewell/core alone left a bare
  // require('uuid') in a .vsix that ships no node_modules — the extension threw
  // on activation. noExternal is matched before external, hence the negative
  // lookahead rather than a blanket /.*/, which would swallow `vscode` too.
  external: ['vscode'],
  noExternal: [/^(?!vscode$)/],
  clean: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
  esbuildOptions(options) {
    options.logOverride = {
      ...(options.logOverride ?? {}),
      // @ordewell/core declares `sideEffects: false`, so esbuild is right to
      // drop the bare chunk imports tsup emits into its split entry points —
      // this only stops esbuild warning about a drop it is already certain is
      // safe. A real side effect would still fail the integration test.
      'ignored-bare-import': 'silent',
    };
  },
});
