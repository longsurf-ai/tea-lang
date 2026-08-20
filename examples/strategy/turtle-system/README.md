# Turtle system

This is a clean-room Tea execution model derived from Eugene's open-source
[Turtle System](https://www.tradingview.com/script/cOv24513-Turtle-System/),
page state inspected on 2026-08-14 (Pine v4 source revision 29; the page reports
an update on 2022-11-10). TradingView pages are mutable, so the behavioral
contract below—not the linked page alone—is the reproducible authority. No
third-party source is copied.

The example preserves the published long-only profile: System 1 and System 2
highest-high breakouts, corresponding lowest-low exits, Wilder ATR (`N`),
risk-sized integer units, same-close fills, pyramiding at configurable N
spacing, one whole-position stop, and the System 1 skip rule. A skipped System
1 breakout is tracked as a virtual trade; its result determines whether the
next System 1 breakout may be taken, while a System 2 breakout remains eligible.

Execution and accounting use the compiler-shipped canonical components:
`broker.new(...)`, `portfolio.new(...)`, and `trade.nextOpen(...)`. The
broker processes explicit-quantity market orders on the signal bar's close;
the portfolio maintains the weighted-average long position, cash, realized
PnL, drawdown, fill count, and round trips. Turtle's existing `unit_count`
state remains the sole per-sequence `max_units` guard, so the generic portfolio
capacity is deliberately non-binding. The strategy otherwise retains only
Turtle-specific virtual-trade state and the published sizing rule. Unit size is
floored from `capital × risk fraction / N` and capped by remaining cash;
`stop_n` changes the protective exit distance but not that unit quantity. The
published strategy declares zero commission and slippage, so this profile
charges none.

The implementation excludes chart drawings, alerts, and the published Pine
script's backtest-date controls. Those controls are TradingView host UI for
choosing an execution window, not Turtle trading rules, so they are
intentionally omitted. The checked-in sweep runs the full provider range. If
Tea later adds bounded historical evaluation, that belongs in the Execution
Context with explicit warmup and order-admission semantics, not as epoch
literals repeated inside strategies. Turtle's Wilder ATR state is explicit in
the strategy so the selected historical contract remains locally auditable.

The supported parameter domain requires positive risk/stop/pyramid values,
System 1 entry shorter than System 2 entry, and System 1 exit shorter than
System 2 exit. The default JavaScript config is a 780-scenario stress sweep
that varies stop distance, risk fraction, pyramid spacing, and maximum units.
`sweep-cpu.yaml` keeps the earlier, representative 36-scenario JS/f64 subset;
every one of its bindings also appears in the larger grid.

```sh
tea execute examples/strategy/turtle-system/sweep.yaml
tea execute examples/strategy/turtle-system/sweep-cpu.yaml
```

The checked 36-binding JS/f64 subset executes 118,188 rows. Its total return
ranges from 1.042421 to 33.825902 and maximum drawdown from 0.099307 to
0.534546. Binding 0 is pinned at 681,128.24 ending equity, 581,128.24 realized
PnL, 156 fills, 44 completed round trips, 0.17942622143948717 maximum drawdown,
and 5.8112824 total return.

The complete strategy cannot currently lower to WGSL because its canonical
broker, portfolio, and trade values contain struct references. Selecting
WebGPU stops with `struct-reference-lowering-unimplemented`; it does not fall
back to CPU. These results are descriptive snapshot values, not parameter
recommendations or investment advice.
