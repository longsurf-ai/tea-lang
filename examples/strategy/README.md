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
tick behavior, or proprietary broker-emulator detail is reproduced. Turtle's
default grid targets WebGPU and includes an equivalent JS/f64 oracle config;
the other profiles currently target JS/f64.

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

Tea's shipped `BrokerEmulator` and `NetPortfolio` provide a reusable canonical
path for the common long-only case:

```tea
var strat = strategy.configure(
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
```

That path supports one pending market-or-buy-stop command; explicit,
all-available-cash, or captured percent-of-equity entry sizing (with commission
either inside or outside that allocation); next-open, intrabar stop-touch, or
process-on-close execution; rate/percent/tick slippage; rate/percent/cash
commission; and aggregate long-position pyramiding with weighted-average cost.
It also supports one scalar atomic stop/target exit attached to a pending or
open long entry, explicit cancellation, and bounded primary-then-exit matching
through `strat.begin_bar(...)`. All pyramided adds in this scalar model reuse
one entry id; the attached exit closes that aggregate net position, and a
different id fails closed while it remains open. This slice accepts only
`marginLong=100` (full notional plus fees must fit in cash) or `marginLong=0`
(the gate is disabled). Intermediate leverage fails closed until the portfolio
has true free-margin accounting. `marginShort` is validated against the same
two values but otherwise reserved in the current long-only implementation.

The canonical path does not yet cover short positions, per-entry lots, partial
closes, general margin accounting, multiple independent exits, true limit
orders, general OCA groups, or segment-by-segment intrabar paths. Examples that
need those behaviors still demonstrate the broader CPU surface with ordinary
Tea-authored components and state:

- signed and quantity-aware positions;
- weighted cost and target allocation;
- pyramiding and independent per-entry lots;
- pending stop orders, cancellation, replacement, and reversal;
- partial reductions and per-lot exits;
- deterministic same-bar stop/target matching; and
- typed `broker.FillExecuted` effects through the normal output contract.

Nothing in the compiler or runtime recognizes these strategy names. Their
canonical or strategy-specific components compile through the same parser →
checker → noder → codegen path as any other Tea source. The current canonical
`Broker` is explicitly a scalar, at-most-two-fill interface; a general order
book will use a bounded fill-drain revision rather than forcing many fills
through this shape.

## Explicit boundaries

- Turtle's default config targets `webgpu`/`wgsl-f32-i32`; its numeric range
  loops, core math calls, and bind-sized channel history now lower generically.
  It also ships `sweep-cpu.yaml` for JS/f64 verification. The remaining eleven
  configs target `javascript`/`js-f64`: their collections, requests, while
  loops, or advanced dynamic effect multiplicity still fall outside today's
  fail-closed WGSL subset. There is no silent CPU fallback.
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
