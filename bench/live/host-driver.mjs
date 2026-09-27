/**
 * A Node-side stand-in for `ChatViewProvider`: the real `ConversationViewHost`
 * plus the handful of `WebviewToHost` replies it owns (`holdPrompt`,
 * `unsendPrompt`, `stopResearch`, `resolveApproval`, `addNote`), so a Playwright page
 * driven against the built webview gets exactly the `HostToWebview` traffic
 * the extension host would send — including the round trip a click or an Esc
 * inside the page triggers, not just a one-way scripted replay.
 *
 * Imported from the built output (packages/vscode/dist/harnessHost.js, a
 * vscode-free tsup entry — see harnessHost.ts) rather than vscode's real
 * ChatViewProvider, which requires('vscode') at load time.
 */
import { ConversationViewHost } from '../../packages/vscode/dist/harnessHost.js';

export function createDriver() {
  const out = [];
  const host = new ConversationViewHost((msg) => out.push(msg));

  return {
    host,
    /** Every `HostToWebview` message posted since the last call, in order. */
    take() {
      return out.splice(0, out.length);
    },
    /**
     * The reply a real host makes to one `WebviewToHost` message it owns.
     * Anything else (sendMessage, editTask, …) has no live planner or Session
     * behind this harness, so it is left for the caller to script directly
     * against `host` instead.
     */
    reply(msg) {
      switch (msg.type) {
        case 'holdPrompt':
          host.holdPrompt(msg.text);
          return true;
        case 'unsendPrompt':
          host.unsendPrompt();
          return true;
        case 'stopResearch':
          host.stop();
          return true;
        case 'resolveApproval':
          // Session.resolveApproval lives outside this harness; standing in
          // for it here settles the same block the real answer would.
          host.receive({ type: 'approval_settled', id: msg.id, granted: msg.granted });
          return true;
        case 'addNote':
          host.note('system', msg.text);
          return true;
        default:
          return false;
      }
    },
  };
}
