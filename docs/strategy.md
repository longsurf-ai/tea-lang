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
- `portfolio` owns the static `Portfolio` interface and the deterministic
  `NetPortfolio` accounting implementation;
- `strategy` owns `Strategy<B, P>` and the strategy-facing calls.

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

`Strategy` stores the concrete broker and portfolio values. The checker uses
the interfaces only to verify their method sets, specializes the generic type
for those concrete implementations, and erases the interfaces before Program
IR. There is no dynamic dispatch, hidden strategy singleton, or host-side
matching/accounting state.

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
one pending market-or-buy-stop command, fills it at an eligible later open or
intrabar stop touch, or optionally at the signal bar's close, and applies the
configured commission and adverse slippage. `strat.entry` accepts an explicit
positive `qty`; omitting it (the `na` default) uses the commission-aware
all-available-cash quantity. A `strategy.percentOfEquity(percent)` sizing value
instead snapshots a cash notional from the portfolio's last marked equity when
the entry is submitted, then resolves quantity from the eventual fill price.
Passing `commissionIncluded=true` treats that snapshot as a cash budget whose
commission is included rather than charged outside the requested allocation.
`NetPortfolio` is a long-only net account. It aggregates up to `pyramiding`
open entries, reports their quantity and weighted-average price, and
`strat.close` closes the whole net position.

For a long strategy that needs one persistent stop/target exit, use the richer
bar entry point and attach the exit to its entry id:

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
first and then tests the attached exit against the updated position. A buy stop
gaps at the open or otherwise uses its trigger as the reference price. An exit
gap uses the open; an intrabar touch uses the selected stop or target. If both
levels are touched, the extreme nearer the open is treated as first, with ties
selecting the stop. The configured adverse sell slippage still applies after a
target touch, so `target` is not a true limit-price guarantee.

Calling `entry` again with the same id replaces a resting buy stop; calling
`exit` again with the same exit id replaces the atomic attached order. Skipping
either call leaves the prior order live. `strat.cancel(id)` explicitly cancels
a matching primary or exit order. When pyramiding under one attached exit,
every add must reuse the same entry id; the exit closes the resulting aggregate
net position. A different entry id fails closed while that aggregate position
is open, whether or not an exit is currently attached. This fixed two-stage
path can produce a primary fill and attached exit on the same bar without a
strategy-local account or matcher.

`end(close, isLast)` remains the normal close-phase convenience. Strategies
whose policy requires an observation between close-time fills may explicitly
sequence `process_close(close)`, `mark(close)`, and `finish(isLast)` instead.
Close processing sees only the close point; it never retroactively inspects the
completed bar's high or low.

This first slice accepts exactly two margin policies: `marginLong=100` requires
the full notional plus fees to fit in current cash, while `marginLong=0`
disables that capital gate for compatibility profiles. Intermediate leverage
values fail closed until the portfolio publishes true free-margin accounting.
`marginShort` is validated against the same `0`/`100` set and retained for
forward compatibility, but is not otherwise used because this implementation
does not open short positions. Default quantity remains all-available-cash
sizing rather than leveraged sizing.

This slice does not provide per-entry lots, partial closes, short positions,
general margin accounting or margin calls, multiple independent exits, true
limit orders, general OCA groups, or segment-by-segment OHLC path replay. Its
one primary slot and one atomic attached-exit slot form a scalar,
at-most-two-fill boundary. A general order book will require an explicit
bounded fill-drain revision rather than pretending an arbitrary number of fills
fits this interface. That future component remains ordinary Tea source and
does not require compiler/runtime dispatch by strategy name.

## Observables and effects

Dense per-bar values remain ordinary reads and plots:

```tea
plot(strat.equity(), "Equity")
plot(strat.realized_pnl(), "Realized PnL")
```

The canonical broker package also owns nominal order, fill, cancellation,
expiry, and rejection event payloads. `broker.BrokerEmulator` emits those
values at the point where it makes the corresponding execution decision; the
generic `Strategy<B, P>` does not guess why an arbitrary broker accepted or
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
