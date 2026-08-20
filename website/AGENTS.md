# Tea offline documentation renderer

Docusaurus shell used only to build the static, version-matched site packaged
for `tea docs`. Hosted documentation uses Mintlify from `../docs/docs.json`.
Content lives in `../docs`; this directory owns only offline configuration,
navigation, and presentation.

## Invariants

- The website must build from the standalone `tea-lang` package without any
  `@openchart/*` dependency or path outside the package.
- `website/package.json` is only the CommonJS build-tool boundary Docusaurus
  needs beneath Tea's ESM package; all dependency versions remain owned by the
  parent package manifest.
- Offline Documentation and Reference remain separate navbar entries and
  sidebars and mirror the hosted Mintlify navigation; generated reference pages
  never enter the learning sequence.
- Broken links, Markdown links, and anchors fail the build.
- Styling stays reading-first, uses local system fonts, and loads no remote
  assets.
- `.docusaurus/` and `build/` are generated outputs, never source files.
  `.gitignore` excludes both; `.npmignore` excludes only `.docusaurus/` so
  installed releases contain the prebuilt site.
