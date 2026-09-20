# Tea VS Code language client

Development-only LSP client for VS Code and Cursor. Two source files, one
dependency, no build step.

## Invariants

- This package is the activating client only. The grammar, the `tea` language
  id and highlighting stay in `../vscode`, which never activates.
- The server is always the Tea CLI verb, `node --import tsx src/main.ts lsp`,
  spawned over stdio from this checkout. No bundled server, no analysis here.
- No execution host, Webview, commands, or settings beyond `tea.trace.server`.
- Plain CommonJS. `vscode-languageclient` is pinned exactly; its
  `engines.vscode` must stay within ours.
