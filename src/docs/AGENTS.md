# docs

Serves the prebuilt Tea documentation site for the `tea docs` CLI command.

## Invariants

- Documentation assets are resolved relative to this module, never the caller's
  working directory.
- The server binds only to IPv4 loopback and serves only files contained by the
  prebuilt Docusaurus output directory.
- `tea docs` never builds documentation at runtime; a missing build is a
  packaging or source-checkout setup error and must fail explicitly.
- This module receives output callbacks from the CLI and never writes directly
  to stdout or stderr.
