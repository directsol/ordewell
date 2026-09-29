import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `.mts` so Vite loads this config as ESM instead of its deprecated CJS path;
// Vite rewrites `import.meta.url` to this file's own location, so the html
// entry points resolve the same way `__dirname` did.
const here = (relPath: string): string => fileURLToPath(new URL(relPath, import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/webviews',
    rollupOptions: {
      input: {
        chat: here('./src/views/chat/index.html'),
        // A second entry, not a forked component set: the task-log tab (V1)
        // draws the chat's own ConversationBlocks and stylesheet.
        tasklog: here('./src/views/tasklog/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
    emptyOutDir: true,
  },
});
