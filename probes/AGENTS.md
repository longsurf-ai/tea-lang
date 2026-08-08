# Tea semantic probes

Manual black-box probes for establishing observable Pine semantics before Tea
contracts are designed or implemented.

## Invariants

- Probe observations are evidence, not Tea language contracts. Promote a result
  into `docs/` only after the result and its confounders have been reviewed.
- An observation ledger records the chart/context, harness bar index, exact
  classification, and invalidated confounders. Keep implementation hypotheses
  out of the ledger so later designs cannot turn an inference into evidence.
- Same-identity history probes mutate the current object before dereferencing a
  historical value; otherwise a live reference can look like a snapshot.
- Alias-history probes also show current reads through both aliases; otherwise
  per-reference history is indistinguishable from mutation-time isolation.
- Keep probes self-classifying. Tables report observed values alongside both
  historical and current candidates rather than labeling either one correct.
- Compile-negative and fatal cases stay separate when one result could prevent
  the remaining cases from running. Cross-context mutation and realtime-only
  cases must be page-gated and resource-bounded inside a successful harness.
  Gate `request.*()` at the call site, not only inside its expression: a
  same-context `calc_bars_count` guard must never constrain the main execution
  window of unrelated pages.
- Keep the successful manual harness as one pasteable Pine file even when long;
  page-selectable output is preferable to imports that TradingView users cannot
  paste and run as one script.
