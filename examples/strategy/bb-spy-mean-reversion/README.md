# BB SPY mean reversion

This is a clean-room Tea implementation of the public open-source
[BB SPY Mean Reversion Investment Strategy](https://www.tradingview.com/script/QJfC4zEj-BB-SPY-Mean-Reversion-Investment-Strategy/),
published 2025-11-08 and inspected 2026-08-14. No Pine source is copied here.

The pinned profile is the publication's default **long-only** direction. It
preserves the Bollinger/candle/EMA setup, optional adaptive
volatility-of-volatility bands, optional width-rank regime gates, persistent
direction bias and re-arm behavior, 5%-of-equity sizing, marketable or resting
buy-stop entries, confirmed-month ATR stop/target segmentation, break-even
replacement, optional time exits, fees, tick slippage, and deterministic
same-bar bracket ordering. Standard `broker.FillExecuted` events remain
available to output sinks.

The strategy now composes the shipped `broker.new`, `portfolio.new`, and
`trade.ohlc` components. Resting buy stops, atomic stop/target exits,
replacement/cancellation, fill pricing, costs, and accounting therefore live
in the canonical libraries rather than in a strategy-local fill factory. The
Tea port omits the publication's display-only bias-history collection because
only the current scalar bias affects orders. Confirmed monthly ATR is built
from the checked-in daily bars
instead of issuing an external higher-timeframe request: the CSV `time_close`
boundary identifies the month's final daily row, so the completed value is
published on the same lower-timeframe bar as Pine's `lookahead_off` merge. Its
Wilder smoothing is seeded with the simple average of the first 14 completed
monthly true ranges. The short-side ADX gate likewise uses local
Pine-compatible SMA-seeded DMI/ADX smoothing so the selected historical
contract remains explicit beside the strategy. Presentation and alert text are
omitted.

## Stress profile and measured result

The publication is designed for SPY daily. The checked-in stress sweep applies
the same rules to the repository's SHA-pinned Binance BTCUSDT daily snapshot so
it remains offline and reproducible; these numbers are therefore not a SPY or
TradingView parity claim.

```sh
tea run examples/strategy/bb-spy-mean-reversion/strategy.tea \
  -i examples/data/binance/btcusdt-1d.csv
```

The 16-scenario JavaScript sweep processes 52,528 rows. On the 2026-08-16
canonical-component parity run it completed in **32.36 s**. Across the scenarios, total return
ranged from **17.38% to 21.26%**, maximum drawdown from **11.19% to 12.49%**,
and completed round trips from **10 to 22**. The best scenario returned
**21.26%**, with **12.49%** maximum drawdown and **21** completed round trips
(`bb_length=12`, multiplier 1.4, 1.5 ATR stop, 2.5 ATR target). Every checked
scenario was profitable on this sample, but that is not evidence of future
performance.

For binding 0, the migration preserves the prior 36-fill/18-round-trip tape
and its final values exactly: equity **29,964.929552900474**, realized P&L
**4,964.929552900471**, fees **16.785778506874447**, maximum drawdown
**12.4884%**, and return **19.8597%**. Canonical order submission,
replacement, cancellation, and expiry events are additional lifecycle detail;
numeric order IDs are intentionally not a cross-implementation contract.

Runtime measurements vary by machine. This is a language/runtime stress
fixture, not investment advice.
