---
title: Strategy model
---

# Strategy model

Tea strategies compose ordinary Tea libraries and explicit state. For a
runnable walkthrough, see
[Backtest your strategy](getting-started/backtest-your-strategy.md).

## Declaration and package

The first statement declares script metadata:

```tea
strategy("Title", shorttitle="Short", overlay=true)
```

Only `title`, `shorttitle`, and `overlay` belong here. A strategy cannot also
declare `indicator()` or `library()`.

The declaration and the `strategy` package intentionally share a spelling:

```tea
strategy("Title")

import broker
import portfolio
import strategy
```

The first call is contextual declaration syntax. Later selectors such as
`strategy.configure` resolve the imported package normally.

## Explicit composition

Tea ships three ordinary, explicitly imported source packages:

- `broker` owns `Side`, `Order`, `Fill`, the static `Broker` interface, and
  the deterministic `BrokerEmulator` execution policy;
- `portfolio` owns the static `Portfolio` interface, the scalar
  `NetPortfolio`, and the explicitly bounded per-entry `LotPortfolio`;
- `strategy` owns the static `Strategy` interface, the concrete
  `ConfiguredStrategy<B, P>` composition, and the strategy-facing calls.

Configure one rooted value per scenario:

```tea
var strat = strategy.configure(
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

`ConfiguredStrategy` stores the concrete broker and portfolio values and
implicitly satisfies the exported `Strategy` method set. `configure()` still
returns that inferred concrete specialization; Tea interfaces are static
checker contracts, not runtime values. Interface satisfaction compares the
receiver mode and the full-arity ordered parameter and result types. Parameter
names and defaults do not participate. The concrete `ConfiguredStrategy`
methods therefore own the ergonomic defaults and the names used by named
arguments at ordinary call sites. The checker specializes the generic type for
the concrete implementations and erases all three interfaces before Program
IR. There is no dynamic dispatch, hidden strategy singleton, or host-side
matching/accounting state.

The `Strategy` method set is intentionally smaller than the concrete type. It
contains common order-command shapes and read-only position, snapshot, and
pending-order observations. Those command signatures do not establish a bar
lifecycle or promise that every broker/portfolio pair will accept them. The
caller must first use the lifecycle appropriate to the configured execution
policy, and a command may fail closed for an incompatible configuration; in
particular, the scheduled aggregate commands reject `LotPortfolio` today.

The remaining open-only, high/low, ordered-path, immediate-lot, and per-lot
methods stay outside the structural method set. Their presence on
`ConfiguredStrategy` is not a statically checked capability claim: the current
`Broker` and `Portfolio` interfaces are themselves supersets, and some method
combinations reject at runtime. A policy-neutral lifecycle requires a separate
redesign of those component contracts rather than a larger `Strategy`
interface.

The policy values are nominal. Commission can be expressed as a decimal rate,
percentage points, cash per contract, or cash per order with
`commissionRate`, `commissionPercent`, `commissionCashPerContract`, or
`commissionCashPerOrder`. Slippage can be a decimal rate, percentage points,
or a tick count plus tick size with `slippageRate`, `slippagePercent`, or
`slippageTicks`. The compatibility helpers `broker.basic` and
`portfolio.basic` remain available, but new strategies should make their
policy explicit through `broker.new` and `portfolio.new`.

## Ordinary lifecycle calls

The source explicitly sequences a bar:

```tea
strat.begin(open, bar_index)

if enterLong
    strat.entry("Long", strategy.Direction.long)
if exitLong
    strat.close("Long")

finished = strat.end(close, barstate.islast)
```

The deterministic reference behavior is:

1. `begin(open, bar_index)` gives the broker the current open, applies any
   eligible fill to the portfolio, and records the current bar index.
2. Signal logic may submit an `entry` or `close` command.
3. `end(close, isLast)` gives a broker configured with
   `processOrdersOnClose=true` an opportunity to fill a pending command at that
   close, applies the fill, and then marks the portfolio.
4. On the final bar, `end` expires any command still pending without forcing
   liquidation. Its fixed `FinishResult` reports the pending primary-order and
   attached-exit slots separately; the corresponding `OrderExpired` effects
   are the exhaustive terminal journal.

The calls are not compiler lifecycle hooks. Tea checks their ordinary argument
and result types, but does not require them, insert them, or enforce their
order. Calling `end` before `begin`, calling either twice, or calling one
conditionally is valid Tea with the behavior defined by the library source.

The current canonical pair is deliberately bounded. `BrokerEmulator` accepts
one pending market-or-directional-stop command, fills it at an eligible later
open or intrabar stop touch, or optionally at the signal bar's close, and
applies the configured commission and adverse slippage. `strat.entry` accepts an explicit
positive `qty`; omitting it (the `na` default) uses the commission-aware
all-available-cash quantity. A `strategy.percentOfEquity(percent)` sizing value
instead snapshots a cash notional from the portfolio's last marked equity when
the entry is submitted, then resolves quantity from the eventual fill price.
Passing `commissionIncluded=true` treats that snapshot as a cash budget whose
commission is included rather than charged outside the requested allocation.
`strategy.percentOfEquityAtFill(percent)` resolves the equity budget at the
actual fill phase. `NetPortfolio` is a signed net account. It aggregates
same-direction adds at weighted-average cost, applies partial reductions,
records full closes and reversals, and reports the signed quantity and average
price. `strat.close` closes the whole net position, while `strat.rebalance`
targets either a signed quantity or a signed percent of fill-time equity.

For a strategy that needs one persistent stop/target exit, use the richer bar
entry point and attach the exit to its entry id:

```tea
strat.begin_bar(open, high, low, bar_index)

if enterLong
    strat.entry(
        "Long",
        strategy.Direction.long,
        sizing = strategy.percentOfEquity(10.0)
    )
if updateStop
    strat.exit(
        "Long bracket",
        fromEntry = "Long",
        stop = stopPrice,
        target = targetPrice,
        activateOnEntryBar = true
    )

strat.end(close, barstate.islast)
```

The broker keeps one scalar atomic stop/target exit, including while its
matching entry is pending. `begin_bar` applies an eligible pending primary fill
first and then tests the attached exit against the updated position. Buy and
sell stops gap at the open or otherwise use their trigger as the reference
price. Long and short exits mirror one another. An exit gap uses the open; an
intrabar touch uses the selected stop or target. If both levels are touched,
the extreme nearer the open is treated as first, with ties selecting the stop.
Configured adverse slippage still applies after a target touch, so `target` is
not a true limit-price guarantee.

`begin_bar` is the ordinary composition of `begin_primary` followed by
`process_exit`. A strategy may call those two phases explicitly when the
primary fill determines the stop or target it must attach before the same
bar's exit check. The portfolio is updated between the phases, so the exit
always sees the filled quantity and average price; calling the split phases
does not expose or move matching into the host runtime.

Strategies whose result depends on the order of intrabar crossings use the
path-preserving variants:

```tea
primary = strat.begin_path_primary(open, high, low, close, bar_index)
// A fill-derived exit may be attached here.
strat.process_path_exit(open, high, low, close)
```

`begin_path(...)` is the corresponding convenience call. The broker replays
`open -> nearer extreme -> farther extreme -> close`; equal distances choose
the low first. A stop entry records its exact path cursor, so an attached exit
can inspect only the untraversed part of the bar rather than using a low or high
that occurred before the entry. Trailing activation and ratcheting likewise
advance segment by segment; `trailPrice` is the absolute activation level and
`trailOffset` is an absolute price distance. Supplying either trailing field
therefore requires this path lifecycle; the ordinary high/low-only lifecycle
fails closed instead of silently approximating a trail.

Calling `entry` again with the same id replaces a resting directional stop; calling
`exit` again with the same exit id replaces the atomic attached order. Skipping
either call leaves the prior order live. `strat.cancel(id)` explicitly cancels
a matching primary or exit order. When pyramiding under one attached exit,
every add must reuse the same entry id; the exit closes the resulting aggregate
net position. A different id in the same direction fails closed while that
aggregate position is open. An opposite-direction entry performs an ordered
close fill, applies it to the portfolio, and then sizes and fills the new side;
this is distinct from a one-fill target rebalance. This fixed path can produce
at most two fills on one bar without a strategy-local account or matcher. An
ordered close-then-open reversal consumes both slots, so an attached exit cannot
also fill on that bar.

`end(close, isLast)` remains the normal close-phase convenience. Strategies
whose policy requires an observation between close-time fills may explicitly
sequence `process_close(close)`, `mark(close)`, and `finish(isLast)` instead.
Close processing sees only the close point; it never retroactively inspects the
completed bar's high or low.

This slice accepts exactly two policies independently for `marginLong` and
`marginShort`: `100` requires newly opened exposure plus fees to fit the
available capital, while `0` disables that capital gate for compatibility
profiles. Intermediate leverage values fail closed until the portfolio
publishes true free-margin accounting. Default quantity remains
all-available-capital sizing rather than leveraged sizing.

For strategies that genuinely need independently accounted entries, select the
bounded lot policy explicitly:

```tea
var strat = strategy.configure(
    broker = broker.new(commission = broker.commissionRate(fee)),
    portfolio = portfolio.lots(
        initialCash = initial_cash,
        maxOpenTrades = maximum_open_trades,
        marginLong = 0.0,
        marginShort = 0.0
    )
)
```

`LotPortfolio` owns the fixed-capacity collection of `OpenTrade` records,
per-entry basis and fees, newest-first removal, realized P&L, and aggregate
reporting. An immediate-only strategy calls `begin_immediate(bar_index)`,
`entry_now(...)`, and `close_trade(...)`; the broker still owns the execution
price, commission, fill identity, rejection, and typed effects. Capacity is a
bind-time policy and overflow is rejected before any `FillExecuted` event.
Immediate-entry size is validated before any opposite lot is closed, and a
failed close prevents the remaining reversal work and new entry, so an invalid
immediate command cannot silently liquidate the portfolio first.
`snapshot()` returns one immutable reporting value so a strategy does not need
to cross the component boundary once per plotted metric.

The scalar scheduled-order calls and the immediate lot calls deliberately fail
closed when used with the wrong portfolio policy. `portfolio.lots` is
collection-backed and therefore CPU-only under today's WGSL subset;
`portfolio.new` remains scalar and GPU-lowerable.

The shipped components still do not pretend to be a general order book. The
scalar broker has one primary slot and one atomic attached exit, while the lot
policy executes explicitly selected entries immediately rather than holding
many independent pending orders. General margin calls, multiple independent
resting exits, arbitrary OCA groups, and an unbounded fill drain require a
separate explicitly bounded revision. That future component remains ordinary
Tea source and does not require compiler/runtime dispatch by strategy name.

## Observables and effects

Dense per-bar values remain ordinary reads and plots:

```tea
plot(strat.equity(), "Equity")
plot(strat.realized_pnl(), "Realized PnL")
```

The canonical broker package also owns nominal order, fill, cancellation,
expiry, and rejection event payloads. `broker.BrokerEmulator` emits those
values at the point where it makes the corresponding execution decision; the
generic `ConfiguredStrategy<B, P>` does not guess why an arbitrary broker accepted or
rejected a command. Sparse, non-column records use the generic
`effect.emit(value)` path; the host transports typed Tea values and does not
reconstruct strategy events in a bespoke journal.

## Compilation and execution

The entry source and every reachable library method form one closed `Program`:

```text
load -> check -> node -> Program -> JS or WGSL
```

There is no simulation compiler or strategy IR. CPU batching repeatedly binds
one generated JS module to caller-ordered isolated inputs. GPU execution binds
one reusable WGSL artifact to independent Program executions. Neither codegen
nor runtime recognizes `broker`, `portfolio`, `Strategy`, `begin`, or `entry`
by name.

Each CPU binding, request child, and GPU Program execution owns fresh runtime
state. Imported package globals use that same execution-context lifetime when a
general Tea library needs them, but `strategy.configure` deliberately returns
explicit state instead of hiding a strategy in a package global.

See [Runtime](runtime.md) for host orchestration and
[GPU Lowering](advanced/gpu-lowering.md) for the fail-closed target boundary.
