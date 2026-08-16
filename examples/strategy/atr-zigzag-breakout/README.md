# ATR ZigZag breakout

This is a clean-room implementation of ReflexSignals'
[ATR ZigZag Breakout](https://www.tradingview.com/script/Hi0gI790-ATR-ZigZag-Breakout/),
revision 1, together with the behavior of its public `ZigZagCore` revision 2
[dependency](https://www.tradingview.com/script/co1alidT-ZigZagCore/), whose
release notes identify the v2 `highBroken`/`lowBroken` state used here. Both
mutable pages were inspected on 2026-08-14; the behavior described below is the
reproducible authority if a later page revision changes. The public sources
were used only to derive an independent state and order specification; no
third-party source is copied.

The example preserves the ATR-threshold ZigZag direction/pivot state,
high/low-level broken flags, direction-driven pending-order cancellation,
two-sided stop-market entries, and the fixed ATR stop/target bracket attached
to each candidate. The publication's trading-window option is explicitly off
for the checked-in daily BTC profile; `trading_window_mode=1` is rejected until
Tea owns an exchange-timezone/session-calendar contract.

The strategy composes Tea's canonical `broker.new`, `portfolio.new`, and
`strategy.configure` components. The broker's fixed-scalar path matcher replays
each daily OHLC bar using TradingView's documented heuristic: open to the nearer
extreme, then the opposite extreme, then close. It records where a stop entry
filled, applies that fill to the portfolio, and lets the attached bracket inspect
only the remaining path. Gap-through stops use the open. This makes bars touching
entry, stop, and target deterministic without inventing lower-timeframe data.
Fixed quantity is one unit and commission is zero, matching the publication's
declared profile; the example contains no private account, fill factory, or
broker emulator.

Every fill emits `broker.FillExecuted` with unambiguous command IDs. The current
dashboard nevertheless labels every buy as entry and every sell as exit, so
short-open and short-cover markers appear visually reversed even though signed
cash/P&L accounting is correct.

The 36-scenario JavaScript sweep varies ZigZag ATR length/multiple and bracket
stop/reward multiples on the pinned BTCUSDT daily snapshot:

```sh
tea execute examples/strategy/atr-zigzag-breakout/sweep.yaml
```

The strategy source is eligible for Tea's current WGSL lowering subset. The
published sweep below intentionally uses the JavaScript `f64` runtime so its
audited metrics remain directly comparable; it is not presented as a measured
GPU run.

Revalidated on 2026-08-16 with `js-f64`, the sweep executed 36 bindings and
118,188 rows and reproduced the prior result extrema and fill counts exactly.
Runtime is intentionally not quoted here: the current scalar path matcher has
known interpreter overhead that must be optimized before it is presented as a
representative benchmark. Total return ranged from -0.693712 to 0.644221,
maximum drawdown from 0.077097 to 0.799150, fill count from 58 to 188, and
completed round trips from 29 to 94.

The highest-return binding was `ATR length=70, ZigZag multiple=3, stop
multiple=1.25, reward=2.5`: ending equity 82,211.03, return 0.644221,
drawdown 0.356854, 95 fills, 47 completed round trips, and one open short at
the snapshot boundary. The lowest-return binding was `ATR length=70, ZigZag
multiple=2, stop multiple=1.25, reward=2.5`: ending equity 15,314.39, return
-0.693712, drawdown 0.799150, 169 fills, 84 completed round trips, and one open
short. Ending equity and return include mark-to-market value for that open
unit. These are descriptive snapshot extrema, not parameter recommendations.
This is a historical execution-semantics fixture, not investment advice.
