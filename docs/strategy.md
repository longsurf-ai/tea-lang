---
title: Strategy model
---

# Strategy model

A Tea strategy is the entry source plus the policy state it declares. Broker
execution, portfolio accounting, and their sequencing are reusable ordinary Tea
libraries compiled into the same `Program` as the strategy.

For a runnable walkthrough, see
[Backtest your strategy](getting-started/backtest-your-strategy.md).

## Declaration versus trade composition

The first statement declares script metadata:

```tea
strategy("Title", shorttitle="Short", overlay=true)
```

`strategy()` is a native declaration. It tells the host that this source is a
strategy and publishes its title, short title, and overlay preference. It does
not construct an execution object and does not require an import. A source
cannot declare both `strategy()` and `indicator()` or `library()`.

Execution composition comes from a separate ordinary library:

```tea
import broker
import portfolio
import trade
```

There is no `strategy` package. `import trade` binds the selectors used to
construct a coordinator and intentionally avoids confusing script identity
with execution machinery.

## Responsibility boundaries

The entry strategy source owns:

- indicators, signals, sessions, grids, cooldowns, and risk decisions;
- strategy-specific state such as targets, trailing activation and extremes;
- the decision to submit, replace, cancel, rebalance, or close an order.

The broker owns commands, working orders, validation, identifiers, matching
timing and price, commission, slippage, cancellation/replacement, and typed
order/fill effects. The reference `BrokerEmulator` contains its matching
policies directly; another broker could delegate market traversal to a
separate matching engine without moving accounting into that engine.

The portfolio owns the mutable ledger: cash, net positions or lots, entry
basis, fees, marking, realized P&L, drawdown, and reporting. It consumes
`broker.Fill` values but never decides whether, when, or where an order fills.
Its `Account` value is an immutable broker-facing projection, not a mutable
account that each strategy reimplements.

The trade coordinator owns one compatible concrete broker and portfolio value
and sequences:

```text
broker match -> portfolio applies fill -> refreshed account view -> continuation
```

It contains no signal policy and is not a compiler or host lifecycle hook.
Strategy sources do not construct `Order`, `Fill`, or `Account`, emit broker
lifecycle effects, call portfolio apply methods, or choose a matched execution
price.

Tea does not yet have member-level visibility, so helper fields and methods on
a concrete `BrokerEmulator` or portfolio are not technically private. The
supported strategy boundary is the trade coordinator, and catalog ownership
tests reject direct broker/portfolio access, fill construction, accounting
mutation, and lifecycle-effect emission. The narrow interfaces enforce
compatible composition; they do not
pretend to hide every concrete member.

## Direct policy families

There is no universal trade interface or nested strategy wrapper. A source
selects the smallest concrete lifecycle it needs:

| Factory          | Coordinator           | Broker constraint        | Portfolio constraint  | Purpose                                      |
| ---------------- | --------------------- | ------------------------ | --------------------- | -------------------------------------------- |
| `trade.nextOpen` | `NextOpenTrade<B, P>` | `broker.NextOpenBroker`  | `portfolio.NetLedger` | next-open and optional close fills           |
| `trade.ohlc`     | `OhlcTrade<B, P>`     | `broker.OhlcBroker`      | `portfolio.NetLedger` | unordered OHLC-range entries and fixed exits |
| `trade.path`     | `PathTrade<B, P>`     | `broker.PathBroker`      | `portfolio.NetLedger` | ordered intrabar path and trailing exits     |
| `trade.lots`     | `LotTrade<B, P>`      | `broker.ImmediateBroker` | `portfolio.LotLedger` | bounded independently accounted entries      |

Each coordinator stores `B broker` and `P portfolio` directly. Choosing a
narrower family therefore does not retain the methods or state of the other
families. The checker rejects an incompatible pair at construction rather than
relying on `supports_*` probes, stubs, or runtime dispatch.

Tea interfaces here are checker-only structural constraints. Satisfaction
compares receiver mode, positional arity and parameter types, and result type.
Parameter names and default values do not participate. Named/default argument
ergonomics belong to concrete factory and coordinator methods; an interface
does not promise those spellings and never becomes a runtime value or dynamic
dispatch table. Generic specialization is erased before Program IR.

The common scalar composition is explicit:

```tea
var strat = trade.nextOpen(
    broker = broker.new(
        commission = broker.commissionRate(0.0001),
        slippage = broker.slippageRate(0.0001),
        processOrdersOnClose = false
    ),
    portfolio = portfolio.new(
        initialCash = 100000.0,
        pyramiding = 1,
        marginLong = 100.0,
        marginShort = 100.0
    )
)
```

The rooted `var` owns all component state for one Program execution. No package
global or host singleton hides it. Every CPU binding and GPU Program execution
starts with isolated state.

## Next-open lifecycle

```tea
strat.begin_bar(open, bar_index)

if enterLong
    strat.entry("Long", trade.Direction.long)
if exitLong
    strat.close("Long")

expired = strat.end_bar(close, barstate.islast)
```

`begin_bar` matches a command that was already pending at the current open and
applies any fill before signal logic runs. New commands cannot fill at that
same open. `end_bar` optionally processes a close fill when the broker was
configured with `processOrdersOnClose=true`, marks the portfolio, and expires
remaining orders on the last bar without forcing liquidation.

`process_close`, `mark`, and `finish` expose the same end phase separately when
a policy needs an observation between them. `entry` accepts explicit quantity
or `trade.percentOfEquity(...)` / `trade.percentOfEquityAtFill(...)` sizing.
`rebalance` targets a signed quantity or percent of fill-time equity.

## OHLC-range lifecycle

```tea
matches = strat.begin_bar(open, high, low, bar_index)

if enterLong
    strat.entry("Long", trade.Direction.long, stop=entryStop)
if manageLong
    strat.exit("Long exit", fromEntry="Long", stop=stopPrice, target=targetPrice)

expired = strat.end_bar(close, barstate.islast)
```

`begin_bar` first matches the pending primary command, applies it, resolves any
bounded reversal continuation against the refreshed account, and then matches
the attached fixed stop/target against the bar range. This family deliberately
does not claim the chronological order of high and low and does not expose
trailing-path state.

The reference broker has one pending primary command and one atomic attached
exit. Gap matches use the open; intrabar matches use the trigger. If both stop
and target are in range, the extreme nearer the open wins, with ties selecting
the stop. Adverse slippage still applies after matching, so a target is not a
true limit-price guarantee.

## Ordered-path lifecycle

```tea
matches = strat.begin_bar(open, high, low, close, bar_index)

// A primary fill may determine the exit submitted here.
if not na(matches.pending)
    strat.exit("Long exit", fromEntry="Long", stop=derivedStop)

exitFill = strat.continue_bar(open, high, low, close)
expired = strat.end_bar(close, barstate.islast)
```

The broker replays `open -> nearer extreme -> farther extreme -> close`; equal
distances choose the low first. A primary stop entry records its exact cursor,
so `continue_bar` can inspect only the untraversed part of the bar. Fixed exits,
trailing activation, and trailing ratchets therefore preserve post-entry path
causality. `trailPrice` is an absolute activation level and `trailOffset` is an
absolute price distance.

`PathTrade.end_bar` only marks and finalizes. It has no close matcher because
close processing would be a different lifecycle promise.

## Bounded-lot lifecycle

Use the lot family only when entries require independent accounting:

```tea
var strat = trade.lots(
    broker = broker.new(commission = broker.commissionRate(fee)),
    portfolio = portfolio.lots(
        initialCash = initial_cash,
        maxOpenTrades = maximum_open_trades,
        marginLong = 0.0,
        marginShort = 0.0
    )
)
```

The coordinator captures only the current close and bar index at `begin_bar`.
`entry` and `close_trade` express at-close intent. For a conditional exit,
`close_trade_at_stop(..., tradeId, entrySide, open, high, low, stop)` forwards
the expected entry side, market observations, and a stop intent. The broker
decides whether the stop was touched, chooses the stop-or-gap reference, and
applies slippage; the coordinator validates the expected side against the
stable lot before execution. The strategy never selects an execution reference
price. `mark()` then marks the lot portfolio at the captured close.

`LotPortfolio` owns the bounded collection of accounting-only `OpenTrade`
records: trade id, side, quantity, entry basis, and entry fee. Strategy-specific
stop, target, grid, and trailing fields stay in strategy-owned bounded state
keyed by the stable trade id. The broker still owns fill identity, execution
price, commission, rejection, and typed effects; the coordinator applies each
returned fill before continuing a reversal or another lot operation.

Lot capacity is a bind-time policy. Overflow and invalid commands reject before
accounting mutation. The collection-backed lot family is CPU-only under the
current WGSL subset and does not make scalar families collection-backed.

## Reporting and effects

`snapshot()` returns one immutable `portfolio.PortfolioSnapshot` containing
cash, position, equity, P&L, fees, fill counts, and risk statistics:

```tea
metrics = strat.snapshot()
plot(metrics.equity, "Equity")
plot(metrics.realizedPnl, "Realized PnL")
```

Dense per-bar values use ordinary outputs. The broker emits nominal
`OrderSubmitted`, `FillExecuted`, `OrderCancelled`, `OrderExpired`, and
`OrderRejected` payloads through the generic `effect.emit` transport at the
decision point. The host transports those typed values; it does not reconstruct
a strategy-specific journal.

## Compilation, CPU, and GPU

The entry source and every reachable library method form one closed Program:

```text
load -> check -> node -> Program -> JS or WGSL
```

There is no strategy IR, strategy compiler, or host-side broker emulator. Both
backends consume the same Program, and neither recognizes `trade`, `broker`,
`portfolio`, a coordinator type, or a lifecycle method by name.

GPU eligibility is determined only by the reachable generic Program closure.
The catalog test currently pins four of fourteen strategy sources as WGSL
eligible: `atr-zigzag-breakout`, `cpu-gpu-next-open`, `ema-cross`, and
`turtle-system`. Their scalar closures exclude lot collections and unused
matcher families and are guarded by function, frame, state-size, source-size,
and effect-count ceilings. The other ten fail closed on their first unsupported
language/input construct; they do not silently fall back to CPU.

See [Runtime](runtime.md) for host orchestration and
[GPU Lowering](advanced/gpu-lowering.md) for the backend boundary.
