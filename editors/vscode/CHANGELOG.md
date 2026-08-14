# Changelog

## 0.3.0

- Add a scientific sweep dashboard with a 3D parameter field and drill-down
  output trajectory.
- Add runtime/config statistics and typed entry/exit annotations.
- Keep Plotly and result transport local to the extension host.
- Resolve surface clicks from the rendered X/Y coordinates and add an exact
  hover marker so the highlighted execution is always the clickable one.
- Retain a bounded sweep trajectory archive so daily-history drill-down returns
  immediately instead of rerunning the selected strategy.

## 0.2.0

- Keep declaration scopes stable across enums, interfaces, aliases, and
  constrained generic user types.
- Tokenize declaration headers and nested type parameters as recoverable
  TextMate regions instead of requiring one complete line-wide match.
- Add real `vscode-textmate` scope tests and fresh-build install commands.

## 0.1.0

- Add Tea syntax highlighting for `.tea` files.
- Add Tea comments, bracket pairing, indentation, and folding configuration.
