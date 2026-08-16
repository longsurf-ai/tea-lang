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
`broker.new(...)`, `portfolio.new(...)`, and `strategy.configure(...)`. The
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
System 2 exit. The default WebGPU config is a 780-scenario stress sweep that
varies stop distance, risk fraction, pyramid spacing, and maximum units.
`sweep-cpu.yaml` is a representative 36-scenario JS/f64 subset used as the
authoritative differential oracle; every one of its bindings also appears in
the larger GPU grid.

```sh
tea execute examples/strategy/turtle-system/sweep.yaml
tea execute examples/strategy/turtle-system/sweep-cpu.yaml
```

With Dawn and the `wgsl-f32-i32` profile, the checked 36-binding oracle subset
executes 118,188 rows in one dispatch. Total return ranges from 1.042421 to
33.825901, maximum drawdown from 0.099307 to 0.534546, fill count from 77 to
243, and completed round trips from 22 to 68.

The matching `js-f64` run executed those 36 bindings and 118,188 rows. Its
extrema were 1.042421 to 33.825902 total return and 0.099307 to 0.534546 maximum
drawdown. A binding-by-binding differential found identical fill counts and
round trips for all 36 scenarios; the largest absolute differences were 1.14
in ending equity, 0.000000199 in maximum drawdown, and 0.00001358 in total
return. This is strong evidence for this grid, but the numeric profiles are not
bit-identical and another threshold-sensitive binding may take a different
branch. The canonical-component migration additionally pins binding 0 at
681,128.24 ending equity, 581,128.24 realized PnL, 156 fills, 44 completed round
trips, 0.17942622143948717 maximum drawdown, and 5.8112824 total return; its
normalized economic fill tape is unchanged.

Within that 36-binding oracle subset, the WebGPU highest-return binding was
`stop N=1.5, risk=0.015, pyramid N=0.5,
max units=5`: ending equity 3,482,590.00, return 33.825901, drawdown 0.527433,
203 fills, and 56 round trips. The lowest-return binding was `stop N=1.5,
risk=0.005, pyramid N=1.0, max units=3`: ending equity 204,242.13, return
1.042421, drawdown 0.103512, 81 fills, and 25 round trips. These are descriptive
snapshot extrema, not parameter recommendations. This is a historical
language/runtime stress fixture, not investment advice.
