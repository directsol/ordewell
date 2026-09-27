/**
 * The vscode-free surface of the extension host, for tooling that drives the
 * chat webview outside VS Code (bench/live/webview-harness.mjs). Bundled as
 * its own tsup entry (see tsup.config.ts) so importing it never pulls in
 * `require('vscode')`, which only `extension.ts`'s bundle can resolve.
 *
 * `ConversationViewHost` is already vscode-free (see its own comment); this
 * entry exists to give that a stable, non-extension import path.
 */
export { ConversationViewHost, type SavedConversation } from './ConversationViewHost';
