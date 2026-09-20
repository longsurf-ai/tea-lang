# Tea Language Client

Development-only VS Code / Cursor client for the Tea language server. It spawns
`node --import tsx <tea root>/src/main.ts lsp` over stdio, from this checkout.
The `tea` language id and highlighting come from the grammar extension in
`../vscode`; this package adds diagnostics, hover, completion, go to
definition, references and signature help.

## Setup, once

From the Tea root, after its own `npm install` (the server runs from source):

```bash
(cd editors/vscode && npm run install:code)   # grammar; install:cursor for Cursor
(cd editors/vscode-lsp && npm install --ignore-scripts)
```

## Run

Nothing is packaged. From the Tea root, open a development host:

```bash
code --extensionDevelopmentPath="$PWD/editors/vscode-lsp" examples/
cursor --extensionDevelopmentPath="$PWD/editors/vscode-lsp" examples/
```

Open any `.tea` file. The server is spawned as `node`, so the `node` on the
editor's PATH must satisfy the Tea root's `engines`.

## See the JSON-RPC traffic

Set `"tea.trace.server": "verbose"` in settings, then open the Output panel and
pick **Tea Language Server**. It shows every message in both directions, plus
the server's stderr.

## After a compiler edit

The server loads the compiler once, at startup. Run **Developer: Reload
Window** in the development host to restart it.
