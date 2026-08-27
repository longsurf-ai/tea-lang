# Multi-timeframe PSAR — inspected v2.0

Clean-room Tea conversion of the current public source behind TradingView's [Multi-Timeframe Parabolic SAR Strategy](https://www.tradingview.com/script/iwI9JdEo-Multi-Timeframe-Parabolic-SAR-Strategy-ver-1-0/). The inspectable Pine v6 script identifies itself as version 2.0 even though the publication title still says 1.0.

## Pinned behavior and source discrepancies

- Current- and higher-timeframe PSAR are both calculated. The sweep covers all three published condition-source choices: higher, current, and both. The optional lower-timeframe filter remains at its source default, disabled.
- Signals are two-sided. On reversal the source explicitly closes the existing side and then opens a 100%-of-equity position on the other side at the next open. Quantity is calculated from equity marked at that fill-time open, rather than from a stale signal-bar snapshot. Both fills pay the published 0.1% commission; there is no slippage.
- Source defaults are stop loss enabled at 1%, take profit disabled at 2%, and trailing stop disabled at 0.5%. Those exact enable settings are pinned in the sweep; the optional inputs and branches remain directly runnable.
- The source calculates stop/target state before its entry blocks, but then resets all exit state to `na` on every true long or short condition — including redundant same-direction entries rejected by `pyramiding=0`. Under the default higher-only condition one side is normally true on every usable bar, so the nominally enabled stop is usually inert. This Tea code preserves that control-flow bug instead of silently repairing it.
- Enabling the published trailing option also cannot bootstrap its state: the source applies `max(na, candidate)` or `min(na, candidate)`, which remains `na`. Tea preserves this too.
- The publication prose says the higher-timeframe request waits for completion, while the current Pine source explicitly uses `lookahead_on`. Tea represents that choice as `availability="start"`. This example pins the source, so its results are a deliberate future-data warning and runtime stress case, not deployable out-of-sample evidence.

Execution and accounting use Tea's canonical `broker.new`, `portfolio.new`,
and `trade.nextOpen` components. Fill-time percent sizing and ordered
reversal continuation let the broker close the old side, apply that fill and
commission to the portfolio, and only then size and open the new side. The
strategy source retains only PSAR signals and the publication's deliberately
buggy exit-state policy.

The primary instrument is the immutable Binance BTCUSDT daily snapshot. The runtime cannot resample a CSV into the source's requested timeframe, so `BTC-USD` weekly bars come from Yahoo. This introduces both a small USD/USDT venue difference and a live, non-hash-pinned request leg. The source default timeframe is daily; the checked-in weekly override is intentional so a daily primary dataset actually exercises multi-timeframe execution.

## Run

Run this request-backed profile from an embedding application that binds both
the primary and higher-timeframe DataStreams by declaration name.

## Measured result

Revalidated on 2026-08-16 with the checked-in 3,283-row BTCUSDT daily snapshot and a live Yahoo `BTC-USD` weekly request:

- 9 bindings / 29,547 evaluated rows
- Tea lowering: 15.18 ms; execution: 18,041.15 ms; reported core total: 18,056.33 ms
- Best total return: 1,496.8417 (149,684.17%), maximum drawdown 46.06%, 33 round trips — binding `condition_source_mode=0` (higher), `sar_start=0.01`
- Worst total return: 0.114852 (11.49%), maximum drawdown 95.32%, 269 round trips — binding `condition_source_mode=1` (current), `sar_start=0.02`
- Largest drawdown: 95.32% — the same worst-return binding above
- Source-default condition/SAR binding (`condition_source_mode=0`, `sar_start=0.02`; with the sweep's weekly timeframe override): total return 633.3424, maximum drawdown 49.17%, 39 round trips

The extreme higher/both-mode results are consistent with start availability for the higher-timeframe interval and are not performance claims. A later run can also differ because the Yahoo request leg is live rather than part of the immutable CSV snapshot.
