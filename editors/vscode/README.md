# Tea Language Support

Syntax highlighting, editor configuration, and a sweep dashboard for Tea
`.tea` files in VS Code, Cursor, and compatible editors.

The extension highlights Tea declarations, control flow, contextual keywords,
functions, types, literals, comments, and operators. It also configures comment
commands, bracket pairing, indentation, and off-side-rule folding. The grammar
publishes stable TextMate scopes; the active editor theme, not this extension,
chooses their colors.

Syntax support remains declarative and works without activating the extension.
The execution host activates only when you invoke `Tea: Open Sweep Dashboard`.
Diagnostics, completion, go to definition, formatting, and semantic
highlighting require a future language server and are not provided.

## Sweep dashboard

Open a Tea source or execution-config file in a trusted local workspace, then
run `Tea: Open Sweep Dashboard` from the command palette. The graph button in a
Tea editor's title bar runs the same command. Select a YAML or JSON execution
config whose `execution.kind` is `sweep`.

The dashboard opens beside the normal text editor. Its upper plot projects two
swept parameters against any numeric metric. Tea returns one bounded JSON sweep
result containing the trajectories captured by the original execution;
clicking an execution selects that result locally instead of contacting a
persistent CLI process or rerunning the strategy. The time-aligned plot below
includes typed broker fill annotations when present. The header reports the
actual runtime, row count, execution count, and timing.

The extension invokes Tea's machine interface, `tea execute <config> --json`,
instead of compiling or interpreting Tea itself. Configure an absolute CLI path
with the application-scoped `tea.executablePath` setting if `tea` is not on the
extension host's `PATH`. Execution is disabled in untrusted workspaces. Plotly
is packaged locally; the webview does not fetch code or data from a CDN or
loopback server.

Tea's JSON sweep capture has a 256 MiB charged retention/projection limit and
supports scalar output channels. This is intended for daily data and other
moderate histories; multi-million-row minute histories need output selection
or a different generic result transport.

## Development

The TextMate grammar is generated from the Tea compiler's token, checker, and
catalog vocabulary. After changing the language, regenerate and verify it:

```bash
cd editors/vscode
bun run generate
bun run check
```

The tests run the generated grammar through the same `vscode-textmate` engine
used by compatible editors. They also lock the generic Tea JSON boundary,
shared visualization projection, and content-security policy.

## Package and install

Create a VSIX:

```bash
cd editors/vscode
bun run package:vsix
```

That command always regenerates and checks the grammar before packaging. To
build and install the fresh artifact in one step, use:

```bash
bun run install:code
# or
bun run install:cursor
```

Install the same artifact in either editor:

```bash
code --install-extension ./tea-language-support.vsix --force
cursor --install-extension ./tea-language-support.vsix --force
```

Reload the editor and open any `.tea` file. The language mode shown in the
status bar should be `Tea`. To diagnose a theme or extension conflict, run
`Developer: Inspect Editor Tokens and Scopes`; equivalent Tea tokens such as
the `export` modifier must report the same `storage.modifier.export.tea` scope.
