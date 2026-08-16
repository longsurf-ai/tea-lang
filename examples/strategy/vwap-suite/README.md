# VWAP Suite

This is a clean-room Tea implementation of the public open-source
[VWAP Suite | Trend & Mean Reversion with Adaptive Filters](https://www.tradingview.com/script/L7P3quUz-VWAP-Suite-Trend-Mean-Reversion-with-Adaptive-Filters/),
inspected on 2026-08-14 (the page was published on 2026-07-26). No Pine source
is copied here.

The example preserves the manually accumulated anchored VWAP and
volume-weighted variance bands, symmetric long/short trend and mean-reversion
entry families, independently switchable volume/ATR/bandwidth/slope/ADX
filters, optional RSI or EMA confluence, risk-based quantity, a maximum
allocation cap, next-open market entry, ATR- or band-based stops, VWAP or
opposite-band targets, optional break-even replacement, fees, and
deterministic same-bar stop/target collision handling. Execution and signed
accounting compose Tea's canonical `broker.new`, `portfolio.new`, and
`trade.net` components, which emit the standard
`broker.FillExecuted` event.

## Pinned runnable profile

The checked-in sweep uses the monthly anchor on the pinned Binance BTCUSDT
daily snapshot and runs the publication's two-sided order paths.
`strategy_mode=0` selects trend following and `1` selects mean reversion;
`entry_type=2` selects Band 2 Break for trend mode and Band Reclaim for
mean-reversion mode. The optional confluence selector is pinned to `None` in
this bounded sweep, while the implementation also accepts RSI and EMA modes.

Only presentation controls are omitted. In particular, the inspected public
source does not define an adaptive volatility-of-volatility band switch: its
"adaptive filters" are the independently configurable volume, ATR,
bandwidth, slope/ADX, and RSI/EMA gates implemented here. The historical order
model is explicit: entries fill at the next open, exits use the previously
published bracket, gaps fill at the open, and an ambiguous bar follows
TradingView's nearer-extreme-first OHLC path. It does not claim realtime tick
parity. The runnable profile charges commission and pins slippage to zero,
matching the published backtest settings.

ATR, RSI, and both DMI smoothing stages use strategy-local Pine-compatible
Wilder state: each waits for an SMA seed window before applying the recursive
update. Keeping that state local makes the selected historical contract
auditable alongside the strategy even though the shared `ta` library now uses
the same seed rule.

The dashboard currently labels buys as entries and sells as exits. The signed
portfolio is correct, but short opens/covers therefore appear with reversed
marker labels until the visualization contract carries an explicit open/close
action.

## Measured sweep

Run from the repository root:

```sh
tea execute examples/strategy/vwap-suite/sweep.yaml
```

The 48-scenario JavaScript sweep processes 157,584 rows from 3,283 real daily
bars. On the 2026-08-16 canonical-component parity run, lowering took 16.23 ms
and execution took **80.56 s**. The best
scenario returned **26.90%**, with **2.99%** maximum drawdown and **204** round
trips (`strategy_mode=0`, Band 2 multiplier 1.5, 1% risk, 1.5 ATR stop). The
worst scenario returned **-32.78%**, illustrating that the two-sided
mean-reversion mode is not automatically suitable for this trending crypto
sample. Across the sweep, returns ranged from **-32.78% to 26.90%**, maximum
drawdown from **1.20% to 34.18%**, and round trips from **54 to 211**.

Runtime measurements vary by machine. Results are a compiler/runtime stress
fixture, not investment advice or a claim of TradingView result parity.
