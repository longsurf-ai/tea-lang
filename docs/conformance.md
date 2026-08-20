---
title: Execution conformance
---

Tea has two deliberately separate corpora:

- `tests/fixtures/corpus/` is **parse-only**. Its derived real-world scripts contain
  dropped statement groups and are not programs the checker or runtime promises
  to accept.
- `tests/fixtures/execution/` is the fail-closed executable corpus. Every listed
  source must pass the real `compile → load → bind → runAll` pipeline, and the
  harness observes it through the real `TraceSink`.

`tests/fixtures/execution/manifest.json` is the corpus inventory. It names every
source, CSV input, and JSON reference and pins each with SHA-256. The test fails
on a missing file, an unlisted file, a changed hash, a compilation or binding
failure, an output-identity change, a missing or extra row, or a value outside
the case's explicit absolute/relative tolerance. Runtime numbers at the sink
must be finite or numeric `na`; the harness checks raw values recursively, so a
string containing `Infinity` is not mistaken for a non-finite number.

An input-focused reference may add `bindings`. The first scenario supplies the
parameters for the execution whose outputs and rows the reference records;
later scenarios rebind the same compiled module without executing it. Every
scenario is an exact snapshot of `BoundProgram.inputs`, including the complete
manifest spec, bound value, and evaluated `active` flag. This makes UI metadata
and parameter-dependent enablement part of the compile-through contract rather
than incidental source that merely has to typecheck.

The `aggregate-values` compile-through case is also the executable lock for
struct-reference aliasing and rebinding, collection-header copying, historical
references, in-place mutable methods, shallow `const`, and transaction rollback.
Its expected rows are Tea-owned contract values derived from
[memory-model.md](memory-model.md), not copied runtime output.

The `typed-execution-range` compile-through case locks the fixed-history
contract for `time`, `time_close`, `bar_index`, `last_bar_index`, `timenow`,
and every `barstate.*` flag, including one-bar historical reads. The harness
binds a deterministic `timenow` value of `1700000000000`. Its empty
`request.security` symbol/timeframe pair inherits the CSV context, while
`calc_bars_count = 2` restricts the child to the final two bars, restarts its
bar indices at zero, and leaves the parent prefix typed-empty.

## Reference ownership

Differential references must be independent of Tea. The initial common subset
uses values calculated by hand and behavior taken directly from the language
specification. A test must never calculate its expected values with Tea, copy
the current Tea output into the reference, or reach the network. A Tea-owned
compile-through contract may use `oracle.kind = "tea-contract"`; a differential
case may not.

JSON `null` represents `na` for a numeric expected channel and typed-empty
`null` for a nullable channel. Each reference declares non-negative absolute
and relative tolerances; zero means exact comparison.

There is intentionally no `UPDATE_GOLDENS` mode or reference generator. To
change a case, edit the source/data/reference together, independently review
the expected values, calculate the affected hashes with `shasum -a 256`, and
update `manifest.json` explicitly. Hashes create review friction and make
accidental rewrites fail; they are not a substitute for reviewing the oracle.

## Intentional deviations

`deviations.json` records only differences that have been consciously adopted
as Tea's contract. It is not a skip list for suspected bugs or unimplemented
features. Every entry must carry a case owner, both behaviors, rationale, and a
reference; exactly one case reference must name it. The harness still compares
that case against its committed Tea expectation, so the ledger cannot suppress
a runtime mismatch. Unresolved findings stay failing tests or explicit design
work, never passing ledger entries.
