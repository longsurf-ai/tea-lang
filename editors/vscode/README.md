# Tea Language Support

Syntax highlighting and editor configuration for Tea `.tea` files in VS Code,
Cursor, and other VS Code-compatible editors.

The extension highlights Tea declarations, control flow, contextual keywords,
functions, types, literals, comments, and operators. It also configures comment
commands, bracket pairing, indentation, and off-side-rule folding.

This first version is deliberately syntax-only. Diagnostics, completion, go to
definition, formatting, and semantic highlighting require a future language
server and are not provided by this extension.

## Development

The TextMate grammar is generated from the Tea compiler's token, checker, and
catalog vocabulary. After changing the language, regenerate and verify it:

```bash
cd packages/tea-lang/editors/vscode
bun run generate
bun run check
```

`packages/tea-lang/testdata/tokens.tea` and
`packages/tea-lang/testdata/types.tea` are useful visual coverage fixtures.

## Package and install

Create a VSIX:

```bash
cd packages/tea-lang/editors/vscode
bun run package:vsix
```

Install the same artifact in either editor:

```bash
code --install-extension ./tea-language-support.vsix --force
cursor --install-extension ./tea-language-support.vsix --force
```

Reload the editor and open any `.tea` file. The language mode shown in the
status bar should be `Tea`.
