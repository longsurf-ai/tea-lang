# AI SuperTrend KNN — WMA long mode

Clean-room Tea conversion of TradingView's open-source [AI SuperTrend Strategy](https://www.tradingview.com/script/eaTIyEty-AI-SuperTrend-Strategy-presentTrading/), derived from the 2023 Pine v5 page state inspected on 2026-08-14. The selected behavioral contract below remains the authority if that mutable page changes.

## Pinned behavior

- The default WMA mode builds a volume-weighted central line from `WMA(close × volume) / WMA(volume)`, then applies the source's SuperTrend band recurrence.
- ATR keeps Pine's SMA-seeded Wilder recurrence explicit in this historical
  profile.
- The classifier stores the last `n` raw SuperTrend values, labels each from smoothed price versus smoothed SuperTrend, bubble-sorts absolute distances to the current raw SuperTrend, and inverse-distance weights the nearest `k` labels.
- Classification is intentionally exact: only a weighted result equal to `1` is bullish and only `0` is bearish; intermediate values are neutral.
- Entries use the publication's 10%-of-equity sizing, next-open market fill, one tick of adverse slippage, 0.1% commission, and USD 10,000 initial capital.
- A dynamic stop is submitted only for an open or pending `Long` entry and
  through the inspected source's initialized-false / `else if` exit-control
  flow. When the source calls `strategy.exit(..., when=false)`, the last
  submitted matching stop remains active rather than being replaced.
- Execution and accounting use Tea's canonical `broker.new`, `portfolio.new`,
  and `trade.ohlc` components. The strategy supplies only its
  percent-of-equity sizing intent and linked stop prices; it does not construct
  fills or maintain a private account model.
- The checked-in run selects the source's published `Long` direction option. Short signals are still computed and plotted, but no short orders are opened, keeping dashboard buy/sell markers semantically entry/exit.

This is behavior-preserving for the selected WMA + Long mode. The other published moving-average choices and Short/Both direction modes are deliberately outside this example's selected mode, not approximated. The primary data is the immutable Binance BTCUSDT daily snapshot; the publication illustrates eight-hour charts, but its source accepts the chart timeframe generically and makes no higher-timeframe request.

## Run

```sh
node --import tsx src/main.ts execute examples/strategy/ai-supertrend-knn/sweep.yaml
```

## Measured result

Validated on 2026-08-16 with the checked-in 3,283-row BTCUSDT daily snapshot:

- 18 bindings / 59,094 evaluated rows
- Tea lowering: 14.94 ms; execution: 38,355.20 ms; reported core total: 38,370.13 ms; process wall time: 38.55 s
- Best total return: 0.678791 (67.88%), maximum drawdown 9.61%, 22 round trips — binding `neighbors=2`, `data_points=10`, `supertrend_factor=3.0`
- Worst total return: 0.602170 (60.22%), maximum drawdown 9.56%, 27 round trips — binding `neighbors=4`, `data_points=12`, `supertrend_factor=2.5`
- Largest drawdown: 9.70% — binding `neighbors=3`, `data_points=12`, `supertrend_factor=3.0`

These are deterministic results for the hash-pinned CSV and the documented
canonical Tea broker/portfolio policy; they are not a claim that Tea reproduces
TradingView's proprietary broker emulator bit-for-bit outside the selected
source settings.
