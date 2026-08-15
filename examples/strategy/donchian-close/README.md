# Donchian close breakout

This is a clean-room Tea implementation of the explicit **Close** execution
mode described by millerrh's open-source
[Donchian Breakout Strategy](https://www.tradingview.com/script/hyYvFjux-Donchian-Breakout-Strategy/),
version 10 as published on 2023-08-23. The public page and release notes were
used to derive the behavior below; no Pine source was copied.

## Behavioral contract

For each completed bar, the strategy computes independent rolling highest-high
and lowest-low channels. While flat and inside the configured date window, a
close at or above the previous bar's upper channel submits an all-in long
market order. While long, a close at or below the previous bar's active stop
submits an all-out market order. Tea's reference broker resolves either order
at the next bar's open with the configured adverse slippage and taker fee.

`tight_stop_mode=1` enables the published tighter-initial-stop idea. The
shorter lower channel is active until it reaches the actual entry fill price;
the transition level is then latched and the wider lower channel trails without
immediately widening the stop. The numeric `0`/`1` spelling is deliberate:
Tea source supports booleans, but execution-config sweep axes are numeric.

The supported parameter domain is
`tight_stop_length < lower_length <= upper_length`. The source emits
`valid parameters = 0` and submits no orders for an invalid direct override.
The checked-in sweep chooses bounds that make all Cartesian combinations valid.

## Deliberate boundary

This conversion targets only Close mode. It omits Wick mode because that mode
needs resting stop orders and cancellation, which the current reference broker
does not provide. The current-timeframe, higher-timeframe, moving-average-slope,
and ADR filters are also omitted; they are disabled by default in the published
strategy, and the higher-timeframe branches require request/resampling policy.
Color, table, and other presentation-only settings are not strategy behavior.

The default-off tight-stop path preserves the selected Close-mode channel
signals. The enabled tight-stop path is an independent implementation of the
author's published prose: the public revision's self-referential stop variable
does not specify a stable cross-bar latch unambiguously. Results for that mode
must therefore be treated as this documented Tea contract, not claimed as a
line-for-line TradingView parity result.

Accounting is also explicit Tea behavior: the shipped long-only broker invests
available cash net of fees, applies fractional adverse slippage, and charges
fees on each fill. Those cost controls are useful stress dimensions, but their
nonzero values are not a claim to reproduce TradingView's tick-slippage model
or every detail of percent-of-equity sizing.

## Reproducible stress sweep

The config runs 600 valid scenarios on the JavaScript runtime:

- 5 upper lookbacks (30 through 70)
- 5 lower lookbacks (10 through 30)
- 2 tight-stop modes and 3 tight-stop lookbacks
- 2 slippage rates and 2 fee rates

It uses the checked-in, SHA-256-pinned Binance Spot BTCUSDT daily snapshot
(3,283 bars, 2017-08-17 through 2026-08-12 UTC). The strategy's published
default start window excludes bars before 2019-01-01 06:00 UTC.

From the repository root:

```sh
tea execute examples/strategy/donchian-close/sweep.yaml
```

Measured on 2026-08-14 with the checked-in config and current JavaScript
runtime (`js-f64`): 600 executions processed 1,969,800 rows. Lowering took
11.18 ms, execution took 549,487.88 ms, reported total time was 549,499.06 ms,
and end-to-end wall time was 549.64 seconds.

Across the sweep, total return ranged from 2.505493 to 16.780692 (250.55% to
1,678.07%), maximum drawdown ranged from 0.409597 to 0.624633, fill count from
28 to 90, and completed round trips from 14 to 45. The highest-return binding
was `upper=40, lower=15, tight=on, tight length=6, slippage=0, fee=0.0005`:
ending equity 1,778,069.17, total return 16.780692, maximum drawdown 0.433924,
52 fills, and 26 round trips. The lowest-return binding was
`upper=60, lower=30, tight=on, tight length=2, slippage=0.001, fee=0.001`:
ending equity 350,549.31, total return 2.505493, maximum drawdown 0.560795,
64 fills, and 32 round trips. These extrema are descriptive facts about this
single historical snapshot; they are not parameter recommendations.

This is a historical runtime stress fixture, not investment advice or a claim
about future returns.
