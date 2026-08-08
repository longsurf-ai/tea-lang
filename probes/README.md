# Pine heap and history probes

`pine-heap-history.pine` is a manual Pine v6 black-box harness for the
collection, UDT, and drawing-effect semantics that must be known before Tea's
generic heap, temporal layer, and publication registry are designed.

Paste the complete script into TradingView, add it to a chart with more than 12
bars, and capture every **Results page**:

1. `Core`
2. `Nesting`
3. `Views`
4. `Alias + Copy`
5. `Commit + Thaw`
6. `Request`
7. `Effects`
8. `Realtime` after at least two updates on the same open bar

The harness always mutates current objects before historical dereference. Each
row reports the raw observation and independently computed historical/current
candidates. `HISTORICAL` and `CURRENT` are classifications, not pass/fail
labels.

Three rows name a third candidate explicitly: `ONE_BACK` means history on an
already historical view was idempotent, `EARLY_WRITE` means an intermediate
same-bar overwrite was captured, and shallow-copy rows report `SHARED` or
`INDEPENDENT`. The thaw rows additionally name `MUTATED_COPY` and
`ALIASED_MUTATION`. Effect rows report `REGISTERED_NOW`,
`TWO_OBJECTS`, `DELETED`, or `NO_EFFECT`. `NA` and `OTHER` preserve unexpected
results without forcing them into our model.

The final three `Alias + Copy` rows compare each collection owner's current
payload with its mutating peer's current payload. `SHARED` means live aliases
still observe one object even when their historical views differ;
`INDEPENDENT` means the untouched owner remains at its initial payload. The
`UDT.copy nested array` row likewise uses the original wrapper's observed
current child as its `SHARED` candidate instead of assuming that child advanced;
`INITIAL_VIEW` means the copied field still reads the collection's bar-zero
payload while the original field has advanced.

For the `Request` page, use a 60-minute chart with the **Request probe
timeframe** input left at its daily default. The table freezes the latest
historical parent bar whose preceding parent bar maps to the same requested
daily bar, so a daily boundary cannot masquerade as object isolation. If no
such sample exists, its header says `REQUEST: USE 60m / D`.

`REQUEST_VALUE`, `PARENT_NOW`, and `PARENT_PREV` classify the observation
against the requested payload, this parent bar's mutation, and the preceding
parent bar's committed mutation. The three `local ... after mutation` rows only
establish local mutability. Read the three `same-child ... before mutation`
rows together with the three `previous parent-history ...` rows to infer
whether request results are rematerialized, aliased across parent bars, and
historically snapshotted. Matching `REQUEST_VALUE` alone does not prove a
physical copy. Array, matrix, map, and nested-UDT payloads are checked
independently. The request allocates objects only while that page is selected
and is limited to three requested bars to avoid the known memory amplification
from returning collections. The `request.security()` call itself must remain
inside the `Request` page's dynamic local scope. Leaving a same-context request
with `calc_bars_count = 3` active on every page can make the other pages execute
against only that three-bar context and invalidate their historical results.
If parent-side mutation is rejected, retain the exact runtime diagnostic; that
is itself the result for the context-ownership question, and the other pages can
still be run after changing the page input.

The seven historical pages render on the dataset's last bar. On an open market,
that bar is provisional; use a closed market or wait for the bar to close when
recording committed historical evidence. The `Realtime` page intentionally
requires an open market and at least two executions within one bar. Its arrays
use fixed one-element counters, so leaving the probe attached cannot grow the
heap without bound.

The successful harness cannot establish physical COW granularity, allocator
slot reuse, generation values, internal snapshot IDs, or collection/UDT garbage
collection after a result is discarded. Those concepts are not observable from
Pine.

## Confirmed observation ledger

These are TradingView captures from 2026-08-08 on Coinbase BTCUSD. Values and
class names below are the harness output; they are observations, not Tea
language contracts. The three 1D pages used the main chart's `bar_index = 4234`.
The Request page used a 60-minute parent chart requesting daily data and froze
parent `bar_index = 22791`, whose preceding parent bar mapped to the same daily
child.

- **Nesting @4234 (1D):** `persistent holder scalar` and `persistent holder ->
UDT` were `CURRENT`; its array/matrix/map children read `21`/`22`/`23`
  (`OTHER`). A fresh holder's scalar and shared collection children were
  `HISTORICAL`, while its shared UDT child was `CURRENT`; all fresh-child rows
  were `HISTORICAL`. Array/matrix/map -> persistent UDT and the two-edge holder
  -> array -> UDT row were `CURRENT`; the three replaced-UDT rows were
  `HISTORICAL`.
- **Alias + Copy @4234 (1D):** array/matrix/map alias-owner `[1]` reads were
  `61`/`62`/`63` (`OTHER`), while peer `[1]` reads were
  `4233061`/`4233062`/`4233063` (`HISTORICAL`). The three owner-now controls
  remained `61`/`62`/`63` (`INDEPENDENT`) while peer-now values were
  `4234061`/`4234062`/`4234063`. Both UDT alias `[1]` rows were `CURRENT`.
  Collection copy source/target and alternating-reference rows were
  `HISTORICAL`. `UDT.copy nested array` read `81` (`INITIAL_VIEW`); the nested
  UDT and array/matrix/map-copy UDT-child rows were `SHARED`.
- **Commit + Thaw @4234 (1D):** the three final-write rows were `HISTORICAL`.
  Collection history after copy mutation and copy-before-mutation remained
  `HISTORICAL`; copy-after-mutation read `4234121`/`4234122`/`4234123`
  (`MUTATED_COPY`). Long-retained array/matrix/map views read
  `9011`/`9012`/`9013` (`HISTORICAL`). The UDT history source, copy-before,
  captured view, and long-retained view all read `4234014` (`CURRENT`); the
  mutated UDT copy read `4234124` (`MUTATED_COPY`).
- **Request same-child @22791 (60m parent, D request):** requested candidates
  were `1131`-`1135`. The five before-mutation rows read
  `22790141`-`22790145` (`PARENT_PREV`). The five local-after-mutation rows and
  the five previous-parent-history rows read `22791141`-`22791145`
  (`PARENT_NOW`). The history operator in this capture was applied to the outer
  `RequestBundle`; nested collection history was not directly indexed.

An earlier revision left the three-bar `request.security()` active on every
page. That same-context request constrained unrelated pages to three bars, so
those captures are intentionally excluded from this ledger. The observations
above come from the corrected revision, which gates the request at its dynamic
call site.

## Mutation companions

Historical mutation might fail at compile time or runtime, so these cases
cannot coexist with the successful harness. Run each snippet as a separate
script and retain the exact diagnostic or resulting values.

### Array

```pine
//@version=6
indicator("Historical array mutation")
var array<int> a = array.new<int>(1, -1)
array.set(a, 0, bar_index)
int before = na
int after = na
if bar_index > 0
    before := array.get(a[1], 0)
    array.set(a[1], 0, -999)
    after := array.get(a[1], 0)
plot(before, "historical before")
plot(after, "historical after")
plot(array.get(a, 0), "current")
```

Repeat by replacing the guarded block above with this escaped-reference block:

```pine
if bar_index > 0
    array<int> past = a[1]
    before := array.get(past, 0)
    array.set(past, 0, -999)
    after := array.get(past, 0)
```

### Matrix

```pine
//@version=6
indicator("Historical matrix mutation")
var matrix<int> m = matrix.new<int>(1, 1, -1)
matrix.set(m, 0, 0, bar_index)
int before = na
int after = na
if bar_index > 0
    before := matrix.get(m[1], 0, 0)
    matrix.set(m[1], 0, 0, -999)
    after := matrix.get(m[1], 0, 0)
plot(before, "historical before")
plot(after, "historical after")
plot(matrix.get(m, 0, 0), "current")
```

Repeat by replacing the guarded block above with this escaped-reference block:

```pine
if bar_index > 0
    matrix<int> past = m[1]
    before := matrix.get(past, 0, 0)
    matrix.set(past, 0, 0, -999)
    after := matrix.get(past, 0, 0)
```

### Map

```pine
//@version=6
indicator("Historical map mutation")
var map<string, int> m = map.new<string, int>()
map.put(m, "k", bar_index)
int before = na
int after = na
if bar_index > 0
    before := map.get(m[1], "k")
    map.put(m[1], "k", -999)
    after := map.get(m[1], "k")
plot(before, "historical before")
plot(after, "historical after")
plot(map.get(m, "k"), "current")
```

Repeat by replacing the guarded block above with this escaped-reference block:

```pine
if bar_index > 0
    map<string, int> past = m[1]
    before := map.get(past, "k")
    map.put(past, "k", -999)
    after := map.get(past, "k")
```

### Persistent UDT

```pine
//@version=6
indicator("Historical UDT mutation")
type Node
    int marker = -1
var Node n = Node.new()
n.marker := bar_index
int before = na
int after = na
if bar_index > 0
    before := (n[1]).marker
    (n[1]).marker := -999
    after := (n[1]).marker
plot(before, "historical before")
plot(after, "historical after")
plot(n.marker, "current")
```

Repeat by replacing the guarded block above with this escaped-reference block:

```pine
if bar_index > 0
    Node past = n[1]
    before := past.marker
    past.marker := -999
    after := past.marker
```

The Pine v6 reference manual explicitly forbids modifying historical arrays and
directs scripts to make a shallow `array.copy()` first. The matrix, map, and
persistent-UDT cases remain empirical until their actual Pine diagnostics or
behavior are recorded. If a companion compiles, record all three plots: they
distinguish a rejected/no-op mutation from mutation of the historical view or
mutation of the current object.

## Sources

- [Collections and permitted element types](https://www.tradingview.com/pine-script-docs/language/type-system/#collections)
- [Pine v6 reference manual: historical arrays are immutable](https://www.tradingview.com/pine-script-reference/v6/)
- [Array history](https://www.tradingview.com/pine-script-docs/language/arrays/#history-referencing)
- [Matrix scope and history](https://www.tradingview.com/pine-script-docs/language/matrices/#scope-and-history)
- [Map scope and history](https://www.tradingview.com/pine-script-docs/language/maps/#scope-and-history)
- [UDTs, objects, and shallow copies](https://www.tradingview.com/pine-script-docs/language/objects/)
- [UDT history syntax](https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-6/#history-of-udt-fields)
- [Requestable collections and UDTs](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/)
- [Memory limits for requested objects and collections](https://www.tradingview.com/pine-script-docs/errors/RE10139/)
- [Realtime rollback](https://www.tradingview.com/pine-script-docs/language/execution-model/#realtime-bars)
- [Labels, IDs, and realtime drawing rollback](https://www.tradingview.com/pine-script-docs/visuals/text-and-shapes/)
