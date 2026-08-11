# Tea Docusaurus Documentation

## System map

Tea will own one documentation source tree and one generated static site. The
same Docusaurus build is deployable on the public web and packaged with the Tea
CLI for local, version-matched reading.

```text
packages/tea-lang/docs/
  authored Markdown + generated reference projections
        |
        | docs:generate (compiler catalog -> Types / Functions)
        v
packages/tea-lang/website/       Docusaurus configuration and theme
        |
        | docs:build
        v
packages/tea-lang/website/build/ static, release-packaged assets
        |
        | tea docs
        v
127.0.0.1:<available-port>       local browser, no build service required
```

The public navigation has two reader surfaces. **Documentation** contains one
Introduction page, the six requested Getting Started pages, Language Guide
(Program Structure, Execution Model, Memory Model), and Advanced (Tea Compiler,
Tea IR, GPU Lowering). **Reference** contains only Types and Functions. Existing
`docs/memory-model.md` and `docs/ir.md` stay in place as authoritative sources;
the sidebar places them in the appropriate reader sequence without copying
them.

## Problem

Tea has authoritative internal design notes, but not a reader-oriented site,
the requested tutorial sequence, mechanically current API reference, or a
version-matched local viewing command. Building a separate documentation
package would also undermine Tea's standalone extraction boundary and risk
coupling the clean language implementation to a legacy language surface.

The key ownership rule is that documentation may explain compiler truth but
must not redefine it. Authored guide pages remain human-written Markdown.
Reference signatures are deterministic projections of the checker-owned public
type vocabulary and native-function catalog. AI-authored descriptions may be
checked in later as reviewed copy, but neither `tea docs` nor a normal site
build will call a model, require credentials, or invent a signature.

## Implementation

1. Add the Docusaurus site under `packages/tea-lang/website/`, with concrete
   dependency versions in Tea's own `package.json`. Configure strict broken
   link and anchor failures, one docs plugin, separate Documentation and
   Reference sidebars, and a minimal reading-focused theme. Keep the package
   independently installable and free of workspace protocols.

2. Add lightweight writing documents for every missing page in the agreed
   structure. Each file contains its title and a short HTML-comment writing
   brief, not speculative product prose. Reuse the existing Memory Model and
   Tea IR documents directly; keep other internal notes outside the v1
   navigation.

3. Introduce a checker-owned public type catalog that the checker itself uses
   to resolve writable built-in and collection type names. Generate exactly
   two reference pages from that catalog and `CATALOG.funcs`: Types and
   Functions. Preserve overload order, sort names deterministically, expose
   stable anchors, mark generated files, and support `--check` byte comparison
   so stale output fails validation.

4. Add package scripts for reference generation, Docusaurus development,
   typechecking, building, and the combined docs gate. Site builds always
   regenerate references; checks verify committed reference output before
   building. Package releases prebuild and include the static assets.

5. Add `tea docs [--port <number>] [--no-open]`. Keep Commander wiring and
   process output in `src/main.ts`; put static routing in a dedicated docs
   server. Resolve assets relative to the installed module, bind only to
   loopback, reject traversal, serve Docusaurus clean URLs and correct 404s,
   and open the printed URL by default. Installed releases never need
   Docusaurus at runtime.

## Verification

- [x] `bun run docs:generate` produces stable Types and Functions pages.
- [x] `bun run docs:check` verifies generated output, site types, strict links,
      and a production Docusaurus build.
- [x] `bun run typecheck` passes for the Tea compiler and CLI.
- [x] `bun test` passes, including docs-server routing, traversal, HEAD/404,
      and browser-opening tests.
- [x] `tea docs --no-open` serves `/`, a nested guide route, both reference
      routes, and static assets from an available loopback port.
- [x] A package-content smoke check confirms the release includes
      `website/build/index.html` and its assets without runtime build tools.
- [x] A packed release installs with runtime dependencies only and serves its
      bundled documentation from an arbitrary working directory.
