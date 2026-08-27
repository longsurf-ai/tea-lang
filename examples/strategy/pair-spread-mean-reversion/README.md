# Pair-spread mean reversion

This is a clean-room Tea implementation of the behavior exposed by TradingView's open-source [Statistical Arbitrage](https://www.tradingview.com/script/5JVPlEgr/) strategy.

Despite the original title, its public behavior is not a market-neutral two-leg arbitrage. Two requested instruments form a close-price spread and its rolling mean and standard deviation. A lower-band break submits a long order for the chart instrument; a move above the spread mean closes that position. This example preserves that single-instrument behavior. The source defaults use Yahoo's resolvable `YM=F` and `ES=F` equivalents of the published continuous-index-future pair. The supplied sweep deliberately overrides them with `BTC-USD` and `ETH-USD`, so its signal and its checked-in Binance BTCUSDT primary instrument all belong to the crypto market rather than presenting a futures signal over BTC as if it were the original strategy's performance.

The strategy uses `trade.nextOpen` to coordinate Tea's canonical broker and portfolio components with the published historical-bar execution settings:

- one fixed contract by default;
- market orders filled at the next primary bar's open;
- one primary-instrument tick of adverse slippage;
- USD 0.05 commission per filled contract; and
- a USD 30,000 initial account.

The configured `tick_size` is `0.01`, matching the BTCUSDT fixture. The published Pine v5 strategy has zero long margin, so `portfolio.new(..., marginLong = 0.0)` does not gate the fixed-size entry on available cash. This can make portfolio cash negative; it is a compatibility choice, not realistic risk management. The example targets the JavaScript runtime because `request.security` contexts are not supported by the current WebGPU runtime.

Run this pair profile from an embedding application that binds the chart and
comparison-symbol DataStreams explicitly.

## Observed reference run

On 2026-08-16, after migrating the strategy to `trade.nextOpen` with the canonical broker and portfolio components, the bounded sweep completed all 9 bindings and 29,547 primary rows on the CPU runtime. The engine reported 7.59 ms of lowering, 39,224.17 ms of execution, and 39,231.76 ms total. Its returns, drawdowns, fill counts, and round-trip counts matched the prior local-broker reference run.

- Best total return: binding 3 (`mean_length=20`, `entry_deviations=1.5`), +50.5834%, with 54.6385% maximum drawdown and 72 round trips.
- Worst total return: binding 2 (`mean_length=10`, `entry_deviations=2.5`), -89.5488%, with 109.3452% maximum drawdown and 22 round trips.
- The largest maximum drawdown in the grid was the same binding 2 at 109.3452%. A drawdown above 100% is possible because faithfully preserving the published zero-margin setting permits negative equity.

The primary BTC bars are hash-pinned in the config. The requested `BTC-USD` and `ETH-USD` child contexts are resolved from Yahoo at execution time, however, so the complete result is not reproducible or available offline: upstream history can be revised, and the request can fail or be rate-limited. These symbols and the primary BTCUSDT feed also come from different venues. The published strategy's `calc_on_every_tick` setting has no historical-bar distinction here; this is a deterministic bar-close/backtest conversion, not a claim of realtime tick parity or trading performance.
