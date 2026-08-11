# Tea documentation

Human-authored language documentation and generated reference material for the
standalone Tea toolchain. The Docusaurus reader experience is owned by
`../website/`; this directory owns the content it publishes.

## Invariants

- Introduction, Getting Started, Language Guide, and Advanced pages are
  human-authored and must never be overwritten by reference generation.
- `memory-model.md` remains the authority for source-observable value semantics,
  `ir.md` remains the authority for Program IR, and `runtime.md` remains the
  authority for physical execution and publication.
- Reference pages are mechanical projections of compiler-owned functions and
  types. Generated reference files are never edited by hand.
- Public navigation is owned by `../website/sidebars.ts`; directory nesting does
  not create additional public sections implicitly.
- All links, examples, and assets must remain inside the independently
  extractable `tea-lang` package.
