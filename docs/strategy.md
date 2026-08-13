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
  the deterministic `Basic` execution policy;
- `portfolio` owns the static `Portfolio` interface and deterministic `Basic`
  accounting implementation;
- `strategy` owns `Strategy<B, P>` and the strategy-facing calls.

Configure one rooted value per scenario:

```tea
var strat = strategy.configure(
    broker = broker.basic(0.0001, 0.0001),
    portfolio = portfolio.basic(100000.0)
)
```

`Strategy` stores the concrete broker and portfolio values. The checker uses
the interfaces only to verify their method sets, specializes the generic type
for those concrete implementations, and erases the interfaces before Program
IR. There is no dynamic dispatch, hidden strategy singleton, or host-side
matching/accounting state.

## Ordinary lifecycle calls

The source explicitly sequences a bar:

```tea
strat.begin(open, bar_index)

if enterLong
    strat.entry("Long", strategy.Direction.long)
if exitLong
    strat.close("Long")

expired = strat.end(close, barstate.islast)
```

The deterministic reference behavior is:

1. `begin(open, bar_index)` gives the broker the current open, applies any
   eligible fill to the portfolio, and records the current bar index.
2. Signal logic may submit an `entry` or `close` command.
3. `end(close, isLast)` marks the portfolio at the close and, on the final
   bar, expires an unfilled pending order without forcing liquidation.

The calls are not compiler lifecycle hooks. Tea checks their ordinary argument
and result types, but does not require them, insert them, or enforce their
order. Calling `end` before `begin`, calling either twice, or calling one
conditionally is valid Tea with the behavior defined by the library source.

The first `broker.BasicBroker` is deliberately small: long-only, flat-or-long,
one pending market order, next-open eligibility, all-in/all-out sizing, fixed
adverse slippage, and fixed taker fees. Alternative deterministic or
probabilistic types can satisfy the same interfaces without changing Strategy
storage or compiler/runtime dispatch.

## Observables and effects

Dense per-bar values remain ordinary reads and plots:

```tea
plot(strat.equity(), "Equity")
plot(strat.realized_pnl(), "Realized PnL")
```

The canonical broker package also owns nominal order, fill, expiry, and
rejection event payloads. `broker.BasicBroker` emits those values at the point where
it makes the corresponding execution decision; the generic `Strategy<B, P>`
does not guess why an arbitrary broker accepted or rejected a command. Sparse,
non-column records use the generic `effect.emit(value)` path; the host
transports typed Tea values and does not reconstruct strategy events in a
bespoke journal.

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
