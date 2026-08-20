# Tea documentation

Human-authored language documentation and generated reference material for the
standalone Tea toolchain. This directory is also the Mintlify project root;
`docs.json` owns the hosted reader experience and navigation. The Docusaurus
configuration in `../website/` exists only for the packaged offline renderer.

## Invariants

- Introduction, Getting Started, Language Guide, and Advanced pages are
  human-authored and must never be overwritten by reference generation.
- `memory-model.md` remains the authority for source-observable value semantics,
  `ir.md` remains the authority for Program IR, and `runtime.md` remains the
  authority for physical execution and publication.
- Reference pages are mechanical projections of compiler-owned language
  vocabulary, functions, and types. Human-facing descriptions and examples may
  live in a metadata overlay only when completeness tests key them back to the
  owning compiler vocabulary. Generated reference files are never edited by
  hand.
- Hosted navigation is owned by `docs.json`; `../website/sidebars.ts` mirrors it
  for the packaged offline site. Directory nesting does not create additional
  public sections implicitly.
- All links, examples, and assets must remain inside the independently
  extractable `tea-lang` package.
