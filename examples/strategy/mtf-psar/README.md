# Multi-timeframe PSAR — inspected v2.0

Clean-room Tea conversion of the current public source behind TradingView's [Multi-Timeframe Parabolic SAR Strategy](https://www.tradingview.com/script/iwI9JdEo-Multi-Timeframe-Parabolic-SAR-Strategy-ver-1-0/). The inspectable Pine v6 script identifies itself as version 2.0 even though the publication title still says 1.0.

## Pinned behavior and source discrepancies

- Current- and higher-timeframe PSAR are both calculated. The sweep covers all three published condition-source choices: higher, current, and both. The optional lower-timeframe filter remains at its source default, disabled.
- Signals are two-sided. On reversal the source explicitly closes the existing side and then opens a 100%-of-equity position on the other side at the next open. Quantity is calculated from equity marked at that fill-time open, rather than from a stale signal-bar snapshot. Both fills pay the published 0.1% commission; there is no slippage.
- Source defaults are stop loss enabled at 1%, take profit disabled at 2%, and trailing stop disabled at 0.5%. Those exact enable settings are pinned in the sweep; the optional inputs and branches remain directly runnable.
- The source calculates stop/target state before its entry blocks, but then resets all exit state to `na` on every true long or short condition — including redundant same-direction entries rejected by `pyramiding=0`. Under the default higher-only condition one side is normally true on every usable bar, so the nominally enabled stop is usually inert. This Tea code preserves that control-flow bug instead of silently repairing it.
- Enabling the published trailing option also cannot bootstrap its state: the source applies `max(na, candidate)` or `min(na, candidate)`, which remains `na`. Tea preserves this too.
- The publication prose says the higher-timeframe request does not look ahead, while the current source explicitly uses `lookahead_on`. This example pins the source. Its results are therefore a deliberate lookahead-bias warning and runtime stress case, not deployable out-of-sample evidence.

The source is genuinely two-sided. With the current dashboard event contract, a short opening sell appears as an exit marker and a short-cover buy appears as an entry marker; use the signed-position plot to interpret those fills.

The primary instrument is the immutable Binance BTCUSDT daily snapshot. The runtime cannot resample a CSV into the source's requested timeframe, so `BTC-USD` weekly bars come from Yahoo. This introduces both a small USD/USDT venue difference and a live, non-hash-pinned request leg. The source default timeframe is daily; the checked-in weekly override is intentional so a daily primary dataset actually exercises multi-timeframe execution.

## Run

```sh
bun src/main.ts execute examples/strategy/mtf-psar/sweep.yaml
```

## Measured result

Validated on 2026-08-14 with the checked-in 3,283-row BTCUSDT daily snapshot and a live Yahoo `BTC-USD` weekly request:

- 9 bindings / 29,547 evaluated rows
- Tea lowering: 8.36 ms; execution: 11,201.49 ms; reported core total: 11,209.85 ms; process wall time: 11.33 s
- Best total return: 1,496.8417 (149,684.17%), maximum drawdown 46.06%, 33 round trips — binding `condition_source_mode=0` (higher), `sar_start=0.01`
- Worst total return: 0.114852 (11.49%), maximum drawdown 95.32%, 269 round trips — binding `condition_source_mode=1` (current), `sar_start=0.02`
- Largest drawdown: 95.32% — the same worst-return binding above
- Source-default condition/SAR binding (`condition_source_mode=0`, `sar_start=0.02`; with the sweep's weekly timeframe override): total return 633.3424, maximum drawdown 49.17%, 39 round trips

The extreme higher/both-mode results are consistent with the explicitly preserved higher-timeframe lookahead and are not performance claims. A later run can also differ because the Yahoo request leg is live rather than part of the immutable CSV snapshot.
