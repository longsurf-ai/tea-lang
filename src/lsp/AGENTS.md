# lsp

Language-server projection of compiler facts. `analysis.ts` owns `analyze()`:
text in, `Analysis` out. `name-queries.ts` owns hover, definition and
references; `text-queries.ts` owns completion and signature help. `server.ts`
owns `startLanguageServer()`, one session on a host-supplied `Connection`.
`index.ts` is the `tea/lsp` export.

## Invariants

- Reads checker facts; adds no semantic rule.
- `analyze` and the queries are pure: no cache, state, or I/O beyond the
  loader's library reads. `analyze` calls only `compileForTooling`.
- They never throw on user text and never catch. An `InternalError` is a
  compiler defect, fixed at its owner. Only `server.ts` catches it: it logs to
  the client, answers null and keeps the published diagnostics.
- `Pos` is 1-based, LSP 0-based, both UTF-16. Diagnostic ranges are never
  empty; only errors positioned in the document are reported.
- Queries return compiler filenames; the server owns URIs. A `file:` URI is
  its path, any other URI its own filename, and `tea-lib/ta.tea` is
  `tea-lib:/ta.tea`, read through `tea/libraryText`, the only non-standard
  request.
- The server holds the only state: open documents, one `Analysis` per document
  version, one 150 ms debounce each. Requests analyze the current text first.
  No options, no transport.
- The host may dispose the connection at any time, so nothing throws outside
  a library-guarded handler: the debounce timer guards its publish, and every
  send promise is caught.
- Text at the cursor is usually broken: completion and signature help trust
  no syntax node there. They scan tokens, find the enclosing block by range
  (on a blank line, by column) and resolve names through `Info.scopes`.
