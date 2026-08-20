# Typed builtins and bounded request contexts

## 1. System map

```text
Tea builtin
    |
    v
checker catalog -- explicit BuiltinBinding -----------------------+
    |                                                             |
    +-- numeric data ----------> SeriesInput ----> SeriesSpec ----+--> rt.series()
    |                                                             |
    +-- typed builtin ---------> BuiltinInput -> BuiltinSpec ---+--> rt.builtin()
                                 {source:{domain,field}, type, depth}

request.security(... options ...)
    |
    +--> RequestEdge keeps bind-time expressions
    +--> rt.bindRequestOptions(rid, gaps, lookahead, ignore, bars)
    +--> RangeDemand(full | trailing-bars) --> provider
    +--> runtime clamps returned extent --> child execution --> parent merge
```

- `src/checker/catalog.ts` remains the source of truth for each builtin's Tea spelling, type, qualifier, and explicit `series` or `builtin` binding. Nothing downstream classifies a builtin by parsing its name.
- `BuiltinSource.domain` is only a stable builtin namespace: `time`, `bar`, `barstate`, `syminfo`, or `timeframe`. It must not construct or imply `TimeObject`, `RowContext`, or other domain-shaped runtime objects.
- Closed unions enforce the carrier and range states at L1; bind/runtime type, layout, range, and provider-contract checks fail loudly at L2; owner tests and `AGENTS.md` lock them at L3/L4.
- Currency conversion, primary-program `indicator(calc_bars_count)`, `security_lower_tf`, cross-edge request deduplication, and realtime tick semantics remain separate work. This slice locks fixed historical execution and must not invent an `ExecutionUpdate` object from the domain taxonomy.

## 2. Problem

Every non-const builtin currently becomes a `SeriesInput`. The manifest then retains only `{id, depth}`, while `Runtime.series()` and `SeriesData` can return only numbers. As a result, string `syminfo.*`, string `timeframe.period`, bool `barstate.*`, and simple context values pass checking but cannot execute honestly; `bar_index` works only through a runtime string special case.

Request options have a second correctness hole. The IR retains `calcBarsCount`, but codegen rejects it and the runtime always sends `FULL_RANGE`. Meanwhile noder folds non-const `simple` `gaps` and `lookahead` with `argValue(...) === true`, silently turning valid bind-time expressions into `false`. The change must close both paths without broadening numeric provider series into an untyped catch-all.

## 3. Implementation

1. **Define the contracts first** — `docs/runtime.md`, `docs/requests.md`, `docs/ir.md`
   - Define `BuiltinSource` as a closed `{domain, field}` union using exact builtin names: `time/time_close/timenow`, `bar_index/last_bar_index`, `barstate.*`, `syminfo.*`, and `timeframe.*`.
   - Define `RangeDemand` as `{kind:'full'}` or `{kind:'trailing-bars', bars:number}`. Zero/omitted request counts select `full`; positive safe integers select a trailing extent.
   - State explicitly that domains identify builtins only. For target row `cursor - offset`, a negative/out-of-extent target always returns the layout's typed empty. Otherwise `time/time_close`, `bar_index`, and historical `barstate.*` are row-indexed; `last_bar_index` is extent-constant; `syminfo.*`, `timeframe.*`, and the host-injected historical `timenow` are context-constant. Historical `barstate` is `ishistory/isnew/isconfirmed=true`, `isrealtime=false`, with `isfirst/islast` derived from the target row.

2. **Make builtin binding explicit** — `src/checker/catalog.ts`, `src/checker/object.ts`, `src/checker/check.ts`
   - Replace `hostId` with a discriminated `BuiltinBinding`: numeric OHLCV/derived sources remain `series`; the five typed domains use `builtin`; constants have no runtime binding.
   - Keep `input.source` restricted to the closed numeric-series vocabulary. Add `time_close`; retain `currency` in the positional request signature but mark it staged in catalog/reference metadata and reject a supplied value during checking until the FX/unit model exists.

3. **Project a distinct typed place** — `src/ir`, `src/noder`
   - Add Program-owned `BuiltinInput {source, type, qualifier, depth}` and `PlaceKind.Builtin`; retain numeric `SeriesInput` unchanged.
   - Noder interns one carrier per semantic builtin per Program and reprojects it independently in request children. Visiting, depth analysis, dumping, and exhaustive switches must handle the new place without re-checking or reparsing names.

4. **Publish ABI 4 and execute typed values** — `src/codegen`, `src/runtime`
   - Add manifest `BuiltinSpec {source, layout, depth}` and `rt.builtin(bid, offset): Value`; lower builtin-place history through it and use the layout registry for typed empty values.
   - Remove the `bar_index` series special case. Resolve exact source keys in one exhaustive runtime function and reuse the existing axis/cursor data. `BindInputs` carries one finite safe epoch-ms clock for deterministic historical `timenow`; only the CLI obtains it from `Date.now()`.
   - Keep physical constancy separate from source qualifiers: `timenow` remains `series` even though the injected clock is fixed for one historical run. During module bind, `rt.builtin` accepts only offset-zero `simple` symbol/timeframe metadata; malformed generated code that reads time, timenow, bar, or barstate inputs fails loudly.
   - Extend the existing `ProviderContext` with exactly one accessor, `builtinValue(source: Extract<BuiltinSource, {domain:'syminfo'|'timeframe'}>): Value | undefined`. `undefined` means unavailable and becomes a `BindError` only when demanded; a returned `null`/`NaN`/`false` is a legitimate typed empty and is layout-validated. Registry/drivers must preserve full `syminfo.tickerid` prefixes and the effective canonical `timeframe.period`. No per-domain runtime classes are introduced.

5. **Bind every request option once** — checker, Program, codegen, runtime
   - Retain `gaps`, `lookahead`, `ignore_invalid_symbol`, and `calc_bars_count` as `IrExpr`s. Change the last two from `const` to `simple`, make the count reject `na`, reject folded negatives in the checker, and require every option to satisfy the existing bind-evaluable rule.
   - Treat immutable root-safe `simple` aliases as bind-evaluable. A history demand driven by one remains an exact `DepthKind.Bound`; it must not collapse to either a compile-time constant or a conservatively capped series demand.
   - Apply the same qualifier gate to inline and aliased builtins. A `PlaceKind.Builtin` read is bind-evaluable only when its exact qualifier is no later than `simple`; series-qualified time/bar/barstate expressions always make a request context dynamic.
   - Preserve two honest schedules: options evaluate in source order during bind; dynamic symbol/timeframe expressions evaluate in their own source order per row. The captured expression remains child-context code.
   - Emit `rt.bindRequestOptions(...)` for every static or dynamic edge; keep `rt.bindRequest(...)` solely for a static symbol/timeframe pair. Runtime validates bools and the non-negative safe integer before resolving any child.

6. **Enforce bounded child semantics** — `src/runtime/js-runtime.ts`, `src/providers/data`
   - Pass the bound demand to CSV/Yahoo/FRED. Providers may optimize fetching, but the runtime still exposes an exact trailing view if a provider over-returns.
   - The child extent becomes `min(N, available)`, its `bar_index` restarts at zero, pre-window history is typed empty, and parent rows before the limited child window merge to typed empty. Empty nested symbol/timeframe arguments inherit the current child context's effective identity.

## 4. Verification

- [x] Checker tests prove exact builtin bindings, `input.source` exclusion, currency's early diagnostic, and valid/invalid bind-time request options.
- [x] Noder/IR tests prove distinct Series/Builtin places, per-Program interning, request-child reprojection, depth, traversal, and dump output.
- [x] Codegen tests prove ABI 4 manifests, typed `rt.builtin` reads, option evaluation order, and static/dynamic bind calls.
- [x] Runtime tests cover every domain, the row/extent/context history classes, typed out-of-range values, missing versus typed-empty metadata, deterministic historical `timenow`, and fixed-history bar-state behavior.
- [x] Request/provider tests cover omitted, zero, positive, oversized, negative, fractional, and na counts; provider over-return; nested inheritance; reset child indices; and typed-empty merge prefixes.
- [x] Add one hash-pinned compile-through conformance case, regenerate public reference output, and run `npm run check`; preserve every pre-existing or concurrent working-tree change.
