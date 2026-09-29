import * as vscode from 'vscode';

/**
 * The HTML every Ordewell webview is served, and the nonce its inline
 * allowances are keyed to. Shared so a second webview — the task-log tab
 * (ADR-0018, V1) — cannot drift from the chat's CSP or asset paths.
 *
 * `script` names the bundle's entry file (`chat.js` / `tasklog.js`). The
 * stylesheet is one asset both entries import (`styles.css`), so the two
 * webviews draw from the same rules rather than a fork.
 */
export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** The shared CSS asset Vite emits for the webviews' common entry stylesheet. */
export const WEBVIEW_STYLES = 'assets/styles.css';

export function renderWebviewHtml(options: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  /** The bundle's file name in `dist/webviews`, e.g. `chat.js`. */
  script: string;
  title: string;
}): string {
  const { webview, extensionUri, script, title } = options;
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', script));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', WEBVIEW_STYLES));
  const cspSource = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; style-src-elem ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}'; connect-src ${cspSource}; img-src ${cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>${title}</title>
</head>
<body><div id="root"></div><script type="module" nonce="${nonce}" src="${scriptUri}"></script></body>
</html>`;
}
