# Cowabunga System — inspected Pine v2

Clean-room Tea conversion of TradingView's open-source [Cowabunga System from babypips.com](https://www.tradingview.com/script/FydaIIQ7-Cowabunga-System-from-babypips-com/), derived from the inspectable 2017 Pine v2 page state rather than its surrounding prose. The source was inspected on 2026-08-14; the behavioral contract below remains authoritative if the mutable page changes.

## What the source actually does

- It is intended for a 15-minute chart, but makes no higher-timeframe request. Its so-called four-hour stochastic and RSI are 162/48/48 and 240-bar calculations on the chart bars; this Tea conversion preserves that exact proxy construction.
- Both RSI paths keep Pine's SMA-seeded Wilder recurrence explicit in this
  historical profile.
- It calculates the MACD signal line but does not use the signal line or histogram in either entry. The actual filter is only fast EMA versus slow EMA. This differs from the publication's narrative rules and is preserved intentionally.
- Trading is limited to 05:00–16:00 in the instrument's exchange timezone. Binance uses UTC, so the Tea config expresses the same interval as UTC minutes 300–960.
- Long and short signals, next-open reversals, fixed quantity 10,000, pyramiding zero, and zero commission/slippage are preserved. A reversal fill includes the quantity needed to close the old side and open the new fixed-size side.
- The source defaults are take profit 1,000 ticks, stop loss disabled (`0 → na`), trailing activation 400 ticks, and trailing offset disabled (`0 → na`). Because Pine trailing exits require both activation and offset, the selected default has a profit target but no active stop or trailing pair. Tea still implements the nonzero stop and complete trailing pair for direct parameter overrides; simultaneous intrabar levels follow TradingView's documented inferred OHLC path.

Execution is composed from Tea's canonical `broker.new`, `portfolio.new`, and
`trade.path` components. Signed quantity targets use `strat.rebalance`,
so a next-open reversal remains one delta fill, while fill-derived exits use the
broker's fixed-scalar OHLC path phases. The nondefault trailing branch is now
strictly path-causal: activation and the favorable-extreme update happen on one
segment, and the resulting trail can fill only on the remaining path. This fixes
the former example-local approximation that could compare a newly activated
trail with an earlier extreme. The checked sweep has `trailing_offset=0`, so its
published/default fill tape is unaffected. The strategy contains no private
account or fill implementation.

The strategy is two-sided because that is the published source behavior. In the current dashboard contract, a short opening sell is labeled as an exit and a short-cover buy as an entry; use the signed-position plot to disambiguate those markers.

## Data

The strategy runs on [`../../data/binance/btcusdt-15m.csv`](../../data/binance/btcusdt-15m.csv), an immutable 20,000-row real Binance BTCUSDT snapshot deterministically aggregated from a hash-pinned one-minute archive. [`../../data/binance/btcusdt-15m.source.json`](../../data/binance/btcusdt-15m.source.json) records the source hash, aggregation, completeness rule, time range, and output hash.

This is deliberately a runtime/language stress case, not an economically comparable replay of a forex strategy: the fixed 10,000-unit order and tick-denominated exits have radically different exposure on BTCUSDT. The selected settings preserve the script rather than retuning it to make the result look plausible.

## Run

```sh
node --import tsx src/main.ts execute examples/strategy/cowabunga/sweep.yaml
```

## Measured result

Revalidated on 2026-08-16 with the checked-in 20,000-row BTCUSDT 15-minute
snapshot. The canonical migration reproduced the prior result extrema and fill
counts exactly. Runtime is intentionally omitted until the scalar path matcher's
known interpreter overhead is optimized:

- 18 bindings / 360,000 evaluated rows
- Best total return: 94.5 (9,450%), maximum drawdown 1,304.75%, 63 round trips — bindings `long_stoch_length=120`, `long_rsi_length=240`, and `take_profit_ticks=1500`
- Worst total return: 30.5 (3,050%), maximum drawdown 176.84%, 61 round trips — bindings `long_stoch_length=141`, `take_profit_ticks=500`, and either swept RSI length
- Exact source-default binding (`long_stoch_length=162`, `long_rsi_length=240`, `take_profit_ticks=1000`): total return 62.0 (6,200%), maximum drawdown 110.53%, 62 round trips

Drawdown above 100% is possible because the source's fixed 10,000-unit sizing is intentionally not constrained to the USD 100,000 cash balance. On BTC this creates enormous leveraged exposure. These figures are therefore diagnostic proof that the two-sided engine, brackets, Pine-seeded long-lookback indicators, and sweep execute; they are not meaningful strategy-performance claims.
