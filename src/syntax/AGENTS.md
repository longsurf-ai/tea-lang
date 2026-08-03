# syntax

Tea frontend: source text → AST. `Source` (character cursor) → `Scanner` (incremental tokenizer) → `Parser` (recursive descent) → `File` (`nodes.ts`).

## Invariants

- The scanner is incremental: `next()` advances exactly one token by mutating the scanner's public fields (`tok`/`pos`/`lit`/`kind`/`op`/`prec`), valid only until the following `next()`. It never allocates `Token` objects — `Token` is a debug/test snapshot used only by `tokenize()` and the dumper.
- Lexical context lives in the scanner: the indent stack that synthesizes `indent`/`dedent` tokens (and any newline-significance state) is scanner-owned. The parser never inspects whitespace or columns. Tea's line-structure rules are Pine Script's — Tea is a syntax superset of Pine — including bracket-aware joining: inside an unclosed `(` or `[` group, line breaks are insignificant and the indent machinery is bypassed.
- Grammar facts the corpus proved, preserved by the parser: `type`/`enum`/`import`/`export`/`method`/`to`/`by`/`in`/`as` are contextual keywords (declaration keywords only when the declaration shape follows; ordinary names elsewhere); simple statements chain with commas on one line; a bare `[a, b]` statement is a block's tuple value, not a declaration — `[a, b] = …` declares only when the balanced brackets land on `=`.
- The parser owns its `Scanner` (`this.scanner`) and is the only caller of `next()`; lookahead is exactly the scanner's current token fields — no token buffering, no rescanning.
- `syntax.ts`'s `parse()` is the only frontend entry for modules outside this directory; `Scanner`/`Parser` are constructed nowhere else (`tokenize()` is the sanctioned debug exception).
- The syntax layer reports malformed-source errors through the injected `ErrorHandler` and continues with recovery; it never imports `Errors` — wiring reports into the compilation's error list is the noder/driver's job. `parse()` may return a partial `File` and never throws on malformed Tea source.
- All binary operators share the single `operator` token kind refined by `op`/`prec`; expression parsing is precedence climbing over `prec`, never per-operator token kinds.
