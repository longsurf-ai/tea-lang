# Tea Language Support

Syntax highlighting and editor configuration for Tea `.tea` files in VS Code,
Cursor, and other VS Code-compatible editors.

The extension highlights Tea declarations, control flow, contextual keywords,
functions, types, literals, comments, and operators. It also configures comment
commands, bracket pairing, indentation, and off-side-rule folding. The grammar
publishes stable TextMate scopes; the active editor theme, not this extension,
chooses their colors.

This first version is deliberately syntax-only. Diagnostics, completion, go to
definition, formatting, and semantic highlighting require a future language
server and are not provided by this extension.

## Development

The TextMate grammar is generated from the Tea compiler's token, checker, and
catalog vocabulary. After changing the language, regenerate and verify it:

```bash
cd editors/vscode
bun run generate
bun run check
```

The tests run the generated grammar through the same `vscode-textmate` engine
used by compatible editors. They lock final token scopes and rule precedence,
not merely whether each individual regular expression compiles.

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
