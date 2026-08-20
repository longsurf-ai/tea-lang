# Strategy catalog

This directory contains runnable Tea strategies, one strategy per directory.
Each example owns its Tea source, execution config, behavioral contract, data
notes, and measured results. Shared immutable market data lives under
[`../data`](../data/).

## TradingView strategy audit

The table records a clean-room audit performed on 2026-08-14. The linked
TradingView pages were used to derive independent behavioral specifications;
no Pine source is copied into this repository. “Converted” means the named
public historical profile is implemented and executed through Tea's ordinary
frontend and runtime. It does not mean every presentation option, realtime
tick behavior, or proprietary broker-emulator detail is reproduced. All
published strategy grids currently use the JavaScript runtime because their
broker, portfolio, and trade state contains struct references.

| Published strategy                                                                                                           | Runnable Tea profile                                                                                            | Stress sweep |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -----------: |
| [Turtle System](https://www.tradingview.com/script/cOv24513-Turtle-System/)                                                  | [Long-only System 1/2, skipped trades, risk units, pyramiding, same-close fills](./turtle-system/)              |           36 |
| [Cluster Breakout Strategy](https://www.tradingview.com/script/DkDNMQsn-Cluster-Breakout-Strategy-v6-Robust/)                | [Pinned v6, two-sided, session/EOD filters disabled](./cluster-breakout-v6/)                                    |           36 |
| [ATR ZigZag Breakout](https://www.tradingview.com/script/Hi0gI790-ATR-ZigZag-Breakout/)                                      | [Two-sided stop entries, cancellation, ATR brackets, deterministic OHLC path](./atr-zigzag-breakout/)           |           36 |
| [Donchian Breakout Strategy](https://www.tradingview.com/script/hyYvFjux-Donchian-Breakout-Strategy/)                        | [Explicit Close mode, long-only, default-disabled request filters omitted](./donchian-close/)                   |          600 |
| [VWAP Suite](https://www.tradingview.com/script/L7P3quUz-VWAP-Suite-Trend-Mean-Reversion-with-Adaptive-Filters/)             | [Monthly-anchor trend/mean-reversion profile with risk sizing and brackets](./vwap-suite/)                      |           48 |
| [BB SPY Mean Reversion](https://www.tradingview.com/script/QJfC4zEj-BB-SPY-Mean-Reversion-Investment-Strategy/)              | [Default long-only profile, adaptive bands, bias/re-arm, monthly ATR exits](./bb-spy-mean-reversion/)           |           16 |
| [Alpha Regime Reversion Pro](https://www.tradingview.com/script/JdCTLj7S-Alpha-Regime-Reversion-Pro-by-Saf/)                 | [Daily Swing Core + Dip, QQQ regime, target allocations, partial reductions](./alpha-regime-reversion/)         |           16 |
| [AliceTears Grid](https://www.tradingview.com/script/6I0p6rPM-AliceTears-Grid/)                                              | [Two-sided intraday grids, per-level lots, pyramiding, reversal and per-lot exits](./alice-grid/)               |            8 |
| [Statistical Arbitrage](https://www.tradingview.com/script/5JVPlEgr/)                                                        | [Accurately named pair-spread signal with fixed-contract chart-symbol execution](./pair-spread-mean-reversion/) |            9 |
| [Multi-Timeframe Parabolic SAR](https://www.tradingview.com/script/iwI9JdEo-Multi-Timeframe-Parabolic-SAR-Strategy-ver-1-0/) | [Inspected v2.0, two-sided close/reverse, all condition-source modes](./mtf-psar/)                              |            9 |
| [AI SuperTrend Strategy](https://www.tradingview.com/script/eaTIyEty-AI-SuperTrend-Strategy-presentTrading/)                 | [Published WMA + Long mode, raw-SuperTrend KNN and persistent stop](./ai-supertrend-knn/)                       |           18 |
| [Cowabunga System](https://www.tradingview.com/script/FydaIIQ7-Cowabunga-System-from-babypips-com/)                          | [Inspected Pine v2, two-sided fixed-quantity reversals and brackets on 15m bars](./cowabunga/)                  |           18 |

Every checked-in grid has been run against real market data. The deliberately
large Donchian config spans six dimensions and evaluates 600 scenarios over
3,283 daily bars (1,969,800 strategy-rows). The individual READMEs report exact
timings, extrema, fill counts, and important interpretation warnings. Results
are runtime fixtures, not parameter recommendations or profitability claims.

## Why these are Tea programs rather than compiler features

All twelve audited profiles compose Tea's shipped broker, portfolio, and trade
components. Each net-position strategy selects only the execution family it
uses:

- `trade.nextOpen(...)` for next-open and optional signal-close execution;
- `trade.ohlc(...)` for unordered OHLC range matching and fixed exits;
- `trade.path(...)` for segment-ordered OHLC replay and trailing exits.

All three families reuse the scalar `BrokerEmulator` + `NetPortfolio`
components. A next-open strategy, for example, is configured and driven as:

```tea
var strat = trade.nextOpen(
    broker = broker.new(
        commission = broker.commissionRate(fee),
        slippage = broker.slippageRate(slippage),
        processOrdersOnClose = false
    ),
    portfolio = portfolio.new(
        initialCash = initial_cash,
        pyramiding = 1,
        marginLong = 100.0,
        marginShort = 100.0
    )
)

strat.begin_bar(open, bar_index)
// Submit entries, closes, or rebalances.
strat.end_bar(close, barstate.islast)
```

The shared scheduled scalar broker supports one pending command; explicit,
all-available-capital, captured percent-of-equity, or fill-time
percent-of-equity entry sizing; rate/percent/tick slippage;
rate/percent/cash commission; signed positions; aggregate same-direction
pyramiding; partial target rebalances; and ordered reversals. `trade.ohlc`
adds stop-touch entries and one atomic fixed stop/target exit.
`trade.path` splits a bar into `begin_bar(...)` and `continue_bar(...)`, so an
intrabar entry's attached fixed or trailing exit inspects only the remaining
path without reusing a pre-entry extreme. All same-direction adds in the
scalar model reuse one entry id; an attached exit closes that aggregate net
position. Both `marginLong` and `marginShort` accept `100` (new exposure plus
fees must fit available capital) or `0` (the gate is disabled). Intermediate
leverage fails closed until the portfolio has true free-margin accounting.

Alice Grid selects `trade.lots(...)` with the separate
`portfolio.lots(...)` policy. It provides an explicit `maxOpenTrades`
capacity, per-entry basis and fees, stable-trade-id lot closes, signed
aggregate reporting, and immediate broker execution through
`strat.entry(...)` / `strat.close_trade(...)`. Capacity overflow is rejected
before a fill is published. The collection-backed lot policy is intentionally
CPU-only today; choosing it does not add collection state to scalar programs.

Nothing in the compiler or runtime recognizes these strategy names, and no
example constructs a fill or maintains a private account engine. The canonical
components compile through the same parser → checker → noder → codegen path
as any other Tea source. The current broker remains an explicitly bounded
scalar matcher rather than a general order book: multiple independent resting
orders, arbitrary OCA groups, general margin calls, and an unbounded fill drain
remain outside this interface.

## Explicit boundaries

- Every canonical strategy reaches struct-backed broker, portfolio, or trade
  state. WGSL compilation therefore stops with
  `struct-reference-lowering-unimplemented`. This is deliberate: Tea does not
  silently fall back to CPU or revive the old inline struct representation.
  Numeric indicators and other programs without struct references may still
  use the current WebGPU subset.
- Historical bars cannot reproduce Pine's realtime `calc_on_every_tick`
  behavior. Session-heavy profiles either use the pinned UTC policy documented
  in their README or select a published session-disabled mode.
- Pair spread, Alpha Regime Reversion, and MTF PSAR use live Yahoo request
  contexts. Their primary CSV is hash-pinned, but their full results can change
  with upstream history. Other measured profiles use only checked-in data.
- MTF PSAR intentionally preserves the inspectable source's
  higher-timeframe `lookahead_on`, despite contradictory publication prose.
  Its extreme result is a lookahead warning, not evidence of performance.
- Cluster's page title still says v6 while the current page serves later v8
  logic; the Tea example pins the original v6 behavior. Cowabunga likewise
  follows the inspectable Pine source where it differs from surrounding prose.
- The dashboard currently infers entry/exit from buy/sell. For two-sided
  examples, a short-open sell and short-cover buy are visually reversed; signed
  position and command IDs remain correct.

`tests/strategy-catalog.test.ts` fail-closes the catalog: all twelve directories
must exist, link their source page, compile, expose the common numeric report
metrics, and resolve exactly the Cartesian count declared by `maxExecutions`.
The test never resolves live request data.
