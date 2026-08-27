# Tea synchronous trading kernel RFC

Status: proposed on 2026-08-20 against `f456f50`.

This RFC defines a JavaScript-first, synchronous trading kernel built from
Tea's current reference-valued structs. Its responsibility boundaries are
inspired by NautilusTrader at local commit `91d057f7a0`, but the contracts,
terminology, implementation, and tests remain Tea-owned clean-room work.

This RFC supersedes the trading architecture in
[`20260816-trade-component-decoupling.md`](20260816-trade-component-decoupling.md)
and the coordinator-preservation requirements in the untracked
`20260820-tea-pine-strategy-completion.md` draft. It does not supersede that
draft's generic compiler, offline-data, or conformance backlog. WGSL work is
outside this RFC until the JavaScript domain model is stable.

## 1. Objective

Build one deterministic trading kernel whose components have the same
responsibilities in backtest and, eventually, live execution:

```text
market evidence
    -> simulated venue and matching
    -> canonical order events
    -> OMS, positions, account, portfolio
    -> strategy source
    -> order commands
    -> risk, execution routing, venue admission
    -> drain until quiescent
```

The kernel must support high-fidelity backtesting without making bar fidelity,
position accounting, or strategy convenience methods into separate broker,
portfolio, or coordinator type families.

The first executable slice is deliberately smaller than the final model. It
proves component ownership, causal ordering, exact accounting, event reduction,
and transactional execution before broader order types or market-data fidelity
are added.

## 2. Current foundation and obsolete assumptions

Tea now has the reference semantics required for long-lived trading services:

- every nominal struct value is `StorageRef | na`;
- assignment, arguments, returns, fields, tuples, collections, and history copy
  the reference;
- mutable methods change shared Heap storage directly;
- rebinding one Name does not rebind another alias;
- one Heap transaction journals in-place field mutation, restores it on abort,
  atomically commits reachable state, traces cycles, and reclaims unreachable
  storage;
- struct history retains prior references, never implicit body snapshots.

This is call-by-sharing, not an `inout` parameter model. A callee can mutate a
shared struct body but cannot rebind the caller's Name.

No source pointer type is required for `Order`, `ExecutionEngine`,
`MatchingEngine`, `Account`, `Position`, or `Portfolio`.

The existing trading surface predates this model and is not retained as an
architectural constraint:

- `NextOpenTrade`, `OhlcTrade`, `PathTrade`, and `LotTrade` project matching and
  accounting policies into strategy-facing lifecycle types;
- `NextOpenBroker`, `OhlcBroker`, `PathBroker`, and `ImmediateBroker` are static
  views over one `BrokerEmulator`, not independent venue implementations;
- `NetLedger` and `LotLedger` turn an OMS position policy into separate
  portfolio/coordinator hierarchies;
- `Command` and `Order` are tagged records with many unrelated nullable fields;
- `BrokerEmulator` combines order state, risk checks, matching, synthetic bar
  traversal, commission, slippage, reversal, trailing, and lifecycle effects;
- strategy sources manually select `begin_bar`, `continue_bar`, `process_close`,
  `mark`, and `finish` protocols;
- `currentBroker = this.broker` followed by `this.broker := currentBroker` now
  copies and reassigns the same reference and is redundant.

Existing examples remain behavioral evidence during migration. Their concrete
factories, generic specialization names, and call graphs are not public design
requirements.

## 3. Design principles

1. **One writer per canonical state.** The OMS writes order state; position
   reducers write positions; account reducers write balances and margin;
   matching engines write only venue/matching state; portfolio code writes only
   its projection.
2. **Reference structs for state, immutable messages for facts.** Engines,
   stores, orders, accounts, positions, and portfolios are reference structs.
   Commands, events, match facts, and journal records are logically immutable
   write-once payloads.
3. **Events reduce state.** A matching engine never edits an `Order`, account,
   position, or portfolio. It produces facts that the owning reducers apply.
4. **One deterministic sequencer.** Components enqueue facts and commands; they
   do not recursively call partially reduced downstream state.
5. **Causality is explicit.** An order may consume only market evidence at or
   after its activation cursor. It cannot retroactively inspect a bar range the
   strategy has already observed.
6. **Market fidelity is configuration and evidence.** Bar, quote, trade, L2,
   and L3 inputs do not produce different Broker or Trade types.
7. **OMS policy is configuration.** Netting and hedging do not produce separate
   Portfolio or Ledger classes.
8. **The entry source remains the strategy.** It owns indicators, signals,
   sessions, sizing decisions, and persistent policy state. There is no
   universal runtime `Strategy` value.
9. **The compiler and runtime remain generic.** No checker, noder, codegen, or
   runtime branch may recognize a trading package, type, or method name.
10. **Business rejection is data.** A denied, rejected, canceled, or expired
    order is a canonical event. A language/runtime invariant failure aborts the
    current Tea transaction.

## 4. Logical architecture

```text
Backtest execution
├── JSRuntime row transaction and market-data provider
├── strategy entry source and persistent policy state
└── TradingKernel
    ├── DeterministicSequencer
    ├── InstrumentStore
    ├── OrderFactory
    ├── RiskEngine
    │   └── ReservationStore
    ├── ExecutionEngine / OMS
    │   ├── OrderStore
    │   ├── PositionIdPolicy
    │   └── execution-client routing
    ├── BacktestExecutionClient
    │   └── SimulatedExchange
    │       ├── venue working-order state
    │       ├── MatchingEngine[instrument]
    │       ├── FillModel
    │       ├── FeeModel
    │       └── optional LatencyModel
    ├── AccountStore
    ├── PositionStore
    ├── Portfolio
    └── committed Journal transport
```

`JSRuntime` remains the generic physical row/transaction host. `TradingKernel`
is ordinary Tea code rooted by the strategy Program. The runtime does not know
that the value is a trading kernel.

For the first slice, the source obtains one opaque current-row context by
delivering the current bar through one stable method. There are no
policy-specific begin/continue/end lifecycles:

```tea
var kernel = backtest.new(...)

ctx = kernel.process_bar()

if longSignal
    build = ctx.orders().market(instrumentId, order.Side.buy, quantity)
    switch build
        OrderBuild.Built(spec) => ctx.submit(spec)
        OrderBuild.InvalidOrder(orderId, reason) => na

view = ctx.portfolio().snapshot()
plot(view.equity, "Equity")
```

The exact package and method spellings are not accepted by this RFC; the
responsibility boundary is.

For the single-instrument first slice, `process_bar` reads row identity, OHLC,
and timestamps directly from trusted runtime/provider builtins; strategy code
cannot construct or override them. A bar carries distinct `tsOpen` and
`tsClose`. `process_bar` validates the current `bar_index`, both timestamps,
and monotonic kernel generation. It
rejects duplicate, skipped, and out-of-order bar processing. The returned
context has package-private fields and is valid only while its generation and
row match the current runtime `bar_index`. All command and state-query APIs are
available only on that context, so omitting `process_bar` leaves no usable
current-row trading facade; no post-body hook is needed to detect an otherwise
unused kernel.
`submit`, `modify`, and `cancel` are exposed through that context, not directly
on the public kernel. A retained context from a prior row cannot submit.

Each command method synchronously enqueues and drains its causal queue to
quiescence before returning. The strategy therefore observes either the fully
reduced denial/rejection/acceptance/cancellation result or a transaction
failure. There is no hidden post-body hook and no required final drain call.
Any nested `OrderApi`, `ExecutionApi`, or `PortfolioApi` facade returned from a
context carries the same opaque generation and independently validates it on
every call. Retaining a nested facade cannot bypass stale-context rejection.

## 5. Component ownership

| Component                | Sole responsibility                                                                                              | Must not do                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `DeterministicSequencer` | total order, clock advancement, timers, queues, fixed-point draining                                             | price orders or calculate P&L                                       |
| `InstrumentStore`        | immutable canonical instrument definitions and venue/currency lookup                                             | orders, matching state, or accounting                               |
| Strategy entry source    | signals, sizing policy, strategy state, submit/modify/cancel decisions                                           | own account, working-order, fill, or matching state                 |
| `OrderFactory`           | IDs and immutable order-spec shape validation results                                                            | create canonical mutable orders, risk, route, match, or account     |
| `RiskEngine`             | pre-trade checks and its own reservation ledger against read-only instrument, order, position, and account views | mutate orders, match, or book fills                                 |
| `ExecutionEngine`        | canonical order store and reducer, routing, OMS mode, position-ID assignment                                     | inspect OHLC paths or choose fill prices                            |
| `ExecutionClient`        | environment-specific command boundary                                                                            | strategy policy or accounting                                       |
| `SimulatedExchange`      | venue admission, working orders, TIF/expiry, venue rules, fill/fee/latency models                                | portfolio projection                                                |
| `MatchingEngine`         | one instrument's market state, evidence cursor, triggers, priority, match facts                                  | mutate OMS, account, position, or portfolio                         |
| `AccountStore`           | settled balances, commissions, venue margin/account state                                                        | match orders or own local pre-trade reservations                    |
| `PositionStore`          | quantity, basis, realized P&L by `PositionId`                                                                    | admit orders                                                        |
| `Portfolio`              | marks, exposure, equity, realized/unrealized P&L, strategy read views                                            | own order lifecycle or matching                                     |
| `Journal` transport      | immutable committed snapshots of commands and events                                                             | retain live mutable references or accumulate an unbounded Tea array |

An optional `OrderEmulator` may later own locally emulated conditional
triggers and release normalized submit commands. It is not the venue matching
engine and never produces fills directly.

## 6. Canonical domain model

The notation in this section is semantic. The tagged-union and visibility
language RFCs own final Tea syntax.

### 6.1 Domain identifiers and numeric values

The model distinguishes at least:

```text
TraderId
StrategyId
AccountId
VenueId
InstrumentId
ClientOrderId
VenueOrderId
PositionId
TradeId
CommandId
EventId
```

IDs are carried explicitly across every command and event. Strategy strings
such as entry labels are metadata, not canonical ownership keys.

Every order and market event names one immutable Instrument definition:

```text
Instrument {
    instrumentId
    venueId
    baseCurrency
    quoteCurrency
    pricePrecision
    tickSize
    quantityPrecision
    lotSize
    contractMultiplier
}
```

`tickSize`, `lotSize`, and `contractMultiplier` are exact integer/rational
metadata. They define every conversion among market decimals, price ticks,
quantity units, and quote-currency minor units.

The JavaScript first slice uses checked safe-integer physical units:

- price in instrument ticks;
- quantity in instrument lots or atomic units;
- money in account-currency minor units;
- time in exact epoch milliseconds;
- rates as checked integer numerator/denominator pairs with an explicit
  rounding rule.

The exact domain is bounded by `MAX_EXACT_INT = 2^53 - 1` and smaller
configuration-specific maxima for price, quantity, balance, event count, and
sequence. Every arithmetic path uses checked add/subtract and checked
multiply-divide. Multiplication proves `abs(a) <= floor(MAX / abs(b))` before
evaluating the product; rational operations reduce factors before multiplying
and apply one documented rounding rule. The first slice requires instrument
conversion to produce an integral quote-minor notional; a remainder is invalid
configuration. Its non-negative commission model rounds half-up once to quote
minor units after calculating exact rational commission. Tick slippage is an
integral signed tick adjustment. Overflow is an invariant transaction failure
for committed internal state. Invalid factory input produces `InvalidOrder`;
a valid order exceeding risk limits produces `Denied`; venue refusal produces
`Rejected`.

Market ingress quantizes provider decimals to instrument ticks before matching.
The first conformance fixture supplies already integral tick values and rejects
non-integral, unsafe, or off-tick inputs. Broader decimal-provider ingestion
requires a separately tested deterministic parser/quantizer; silently
truncating `open`, `high`, `low`, or `close` is forbidden.

Factories validate precision, range, integrality, and conversion before a
message enters the kernel, but reducers repeat checked arithmetic at every
state transition. Matching and accounting never compare or accumulate
binary-decimal prices. Nominal scalar/newtype syntax may improve type safety
later, but it is not required to prove the first slice. Stores use canonical
primitive raw ID/unit keys internally because reference structs are neither
identity-comparable nor map keys.

### 6.2 Order specification

```text
OrderKind =
    Market
  | Limit(limitPrice)
  | StopMarket(triggerPrice, triggerType)
  | StopLimit(triggerPrice, limitPrice, triggerType)

OrderSpec {
    clientOrderId
    strategyId
    accountId?
    executionClientId?
    instrumentId
    side
    quantity
    kind
    timeInForce
    expireTime?
    reduceOnly
    positionId?
}
```

A target is an ordinary limit order. A stop-loss is an ordinary stop order. A
bracket is an order list plus explicit contingency relationships; it is not a
pseudo `OrderType` with one ID.

Missing quantity never means implicit all-in sizing. Percent-of-equity,
rebalance, and fill-time sizing are strategy/execution-algorithm adapters that
produce explicit-quantity orders.

### 6.3 Commands

```text
OrderCommand =
    SubmitOrder(commandId, orderSpec, accountId?, executionClientId?)
  | ModifyOrder(commandId, clientOrderId,
                quantity?, limitPrice?, triggerPrice?)
  | CancelOrder(commandId, clientOrderId)

CommandResult =
    CommandAdmitted(commandId, clientOrderId)
  | CommandRejected(commandId, clientOrderId?, reason)
```

Command timestamps, sequence numbers, and causation IDs are minted by the
kernel from the current trusted row context. Strategy code never supplies
`tsInit` or an activation frontier.

Command admission runs before any lifecycle mutation:

- submitting an already registered `ClientOrderId` produces
  `CommandRejected(duplicateOrder)` and does not apply `Initialized` again;
- canceling or modifying an unknown or terminal order produces
  `CommandRejected(invalidOrderState)` and does not apply a pending event;
- only an admitted command may author an `OrderEvent`;
- an impossible `OrderEvent` that nevertheless reaches the reducer remains an
  invariant transaction failure.

Command results are immutable journal facts. An admitted submit may still
produce a later `Denied` or `Rejected` order event during its synchronous
drain.

`OrderFactory` returns a specific immutable build union:

```text
OrderBuild = Built(OrderSpec) | InvalidOrder(ClientOrderId, reason)
```

It never creates the canonical mutable `Order` aggregate. Malformed shape,
precision, or range input produces `InvalidOrder` and never enters the order
lifecycle. Strategy code handles that result before submission.
`ExecutionEngine` creates and registers the canonical aggregate only for a
built spec when submission begins. A successful `submit` returns its
`CommandResult`; later commands and queries use the `ClientOrderId` carried by
its admitted variant. Opaque order views are obtained separately through
`ExecutionApi.order(clientOrderId)`.
`Denied` is reserved for a valid initialized order refused by routing, risk, or
local trading state.

At least one modifiable field is required by `ModifyOrder`. Whether a venue
models modification as an in-place update or cancel/re-submit is an explicit
venue capability. Batch commands, cancel-all, order lists, and query commands
extend this algebra later without changing reducers.

Route/risk normalization produces one immutable fact before execution-client
routing:

```text
RiskDecision =
    RiskDenied(clientOrderId, reason)
  | RiskAccepted(clientOrderId, accountId, executionClientId,
                 reservationId, reservedMoney, reservedQuantity,
                 minExecutionPrice?, maxExecutionPrice?)

ExecutionSubmit {
    OrderSpec spec
    accountId
    executionClientId
    reservationId
    minExecutionPrice?
    maxExecutionPrice?
    activationCursor
}
```

`ExecutionSubmit` is the only submit message accepted by a simulated exchange.
The exchange and `FillModel` enforce its collar but never inspect Account or
Risk state. Risk decisions, reservation creation/consumption/release, and the
normalized submit are canonical journal facts so replay can prove that an
authoritative fill was preauthorized.

### 6.4 Events

```text
OrderEvent =
    Initialized(order snapshot)
  | Denied(reason)
  | Submitted(accountId)
  | Accepted(venueOrderId)
  | Rejected(reason)
  | Triggered(triggerPrice)
  | PendingUpdate
  | Updated(quantity?, limitPrice?, triggerPrice?)
  | ModifyRejected(reason)
  | PendingCancel
  | Canceled(reason?)
  | CancelRejected(reason)
  | Filled(tradeId, venueOrderId, positionId,
           lastQuantity, lastPrice, commission, liquiditySide)
  | Expired
```

Every event envelope also carries:

```text
eventId
clientOrderId
tsEvent
tsInit
sequence
causationId
```

`Denied` is a local validation or risk refusal before venue submission.
`Rejected` is an authoritative simulated/external venue refusal after
submission. A timeout is neither.

One `Filled` variant represents both partial and full executions. The order
reducer derives `PartiallyFilled` versus `Filled` from cumulative filled and
leaves quantities.

Commands and events are immutable logical facts. They contain IDs and payload
snapshots, never mutable service references. The journal owns a serialized
snapshot, not a live struct alias.

The exchange does not directly create this canonical union. It creates a
venue fact without OMS-owned fields:

```text
VenueFact =
    VenueAccepted(clientOrderId, venueOrderId)
  | VenueRejected(clientOrderId, reason)
  | VenueTriggered(clientOrderId, triggerPrice)
  | VenueUpdated(clientOrderId, ...)
  | VenueCanceled(clientOrderId, reason?)
  | VenueCancelRejected(clientOrderId, reason)
  | VenueModifyRejected(clientOrderId, reason)
  | VenueFill(clientOrderId, venueOrderId, tradeId,
              lastQuantity, lastPrice, commission, liquiditySide)
  | VenueExpired(clientOrderId)
```

`ExecutionEngine` validates the route and current aggregate, resolves the
canonical `PositionId` under the OMS policy, and then authors the corresponding
`OrderEvent`. This makes it the only producer of canonical order-state facts
after `Initialized`/`Denied`.

## 7. Canonical order aggregate and state machine

`ExecutionEngine` owns one canonical mutable `Order` aggregate per
`ClientOrderId`. No other component writes its status, filled quantity, leaves
quantity, average price, timestamps, or idempotence state. The committed
Journal is the event history; an `Order` does not retain a duplicate unbounded
event array.

```text
Initialized
├── Denied
└── Submitted
    ├── Rejected
    ├── Accepted
    └── PartiallyFilled | Filled
```

The target transition table is:

| Prior status                                            | Event                  | Next status / rule                                     |
| ------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `Initialized`                                           | `Denied`               | `Denied`                                               |
| `Initialized`                                           | `Submitted`            | `Submitted`                                            |
| `Submitted`                                             | `Accepted`             | `Accepted`                                             |
| `Submitted`                                             | `Rejected`             | `Rejected`                                             |
| `Submitted`                                             | `Filled`               | `PartiallyFilled` or `Filled` from cumulative quantity |
| `Accepted`                                              | first `Triggered`      | `Triggered`; persist trigger time/price                |
| `Accepted`, `Triggered`, `PartiallyFilled`              | `Filled`               | recompute `PartiallyFilled` or `Filled`                |
| any working status                                      | `PendingUpdate`        | `PendingUpdate`; save exact prior working status       |
| `PendingUpdate`                                         | `Updated`              | restore saved working status after applying fields     |
| `PendingUpdate`                                         | `ModifyRejected`       | restore saved working status unchanged                 |
| any working status                                      | `PendingCancel`        | `PendingCancel`; save exact prior working status       |
| `PendingCancel`                                         | `Canceled`             | `Canceled`                                             |
| `PendingCancel`                                         | `CancelRejected`       | restore saved working status unchanged                 |
| `Submitted`, `Accepted`, `Triggered`, `PartiallyFilled` | unsolicited `Canceled` | `Canceled`                                             |
| `Submitted`, `Accepted`, `Triggered`, `PartiallyFilled` | `Expired`              | `Expired`                                              |

`working` means `Submitted`, `Accepted`, `Triggered`, or `PartiallyFilled` for
the relevant command. A second `Triggered` is invalid even if status later
became `PartiallyFilled`; trigger state is retained separately. The target
table rejects late
fills while pending update/cancel and every ordinary event after a terminal
state. A later reconciliation RFC may add those races explicitly.

`Submitted -> Filled` exists only for a future execution route whose venue can
authoritatively fill before a separate acceptance acknowledgement. The first
slice always emits `Accepted` before any fill and does not exercise that edge.

The first executable slice implements only this subset:

| Prior status    | Event                       | Next status        |
| --------------- | --------------------------- | ------------------ |
| `Initialized`   | `Denied`                    | `Denied`           |
| `Initialized`   | `Submitted`                 | `Submitted`        |
| `Submitted`     | `Accepted`                  | `Accepted`         |
| `Submitted`     | `Rejected`                  | `Rejected`         |
| `Accepted`      | full `Filled`               | `Filled`           |
| `Accepted`      | `PendingCancel`             | `PendingCancel`    |
| `PendingCancel` | `Canceled`                  | `Canceled`         |
| `PendingCancel` | `CancelRejected`            | restore `Accepted` |
| `Accepted`      | `Canceled(PriceProtection)` | `Canceled`         |

Triggered, update, partial-fill, and unsolicited terminal transitions become
executable only in the expansion phase that implements them.

The complete transition table is part of the executable specification. In
particular:

- `Initialized` cannot be applied twice;
- event and order IDs must match;
- duplicate `EventId` and `TradeId` values are idempotence violations;
- cumulative filled quantity cannot exceed order quantity;
- a limit fill cannot be worse than its limit;
- only triggerable order kinds with no prior trigger accept `Triggered`;
- terminal orders reject ordinary later transitions;
- rejected update/cancel requests restore the prior working state;
- fill voids, busts, late fills, and reconciliation corrections require
  separately specified events and are not silently accepted in V1.

Synchronous cancel follows one fixed causal path:

```text
CancelOrder
    -> validate canonical working state
    -> PendingCancel
    -> route to execution client
    -> exchange removes or retains its working representation
    -> Canceled | CancelRejected
    -> release reservation, or restore prior working state
```

`ctx.cancel()` drains this path before returning. Modify follows the analogous
`PendingUpdate -> Updated | ModifyRejected` path once modification enters the
implemented slice.

Invalid state transitions are kernel invariant failures. Malformed order
construction returns `InvalidOrder`; risk limits and venue rules become
`Denied` or `Rejected` events. Before the kernel slice lands, Tea adds one
minimal source-callable invariant primitive
whose failure raises a stable execution error and aborts the current Heap/row
transaction. It is not used for business rejection or recoverable control
flow.

## 8. Deterministic sequencing and causality

Every queued item has a total-order key:

```text
(timestamp, sourceOrdinal, causalWave, phaseOrdinal, enqueueSequence)
```

`causalWave` increases whenever processing one item creates downstream work.
It permits a later command to produce a venue fact and canonical event whose
phase ordinal is lower than the command's without moving that fact before its
cause. Within one wave, V1 uses these phase ordinals:

```text
0 timer
1 market evidence
2 venue fact
3 canonical order event and order reduction
4 position transition
5 risk reservation or account transition
6 portfolio projection/mark
7 strategy evaluation boundary
8 strategy command
9 route and risk decision
10 execution-client/venue command
```

Items with the same complete key prefix are FIFO by `enqueueSequence`. The
sequencer never globally re-sorts a derived lower phase into an earlier causal
wave.

For one bar in the first slice, `process_bar` performs only the pre-strategy
half of the turn:

1. Advance the clock and fire due timers in
   `(deadline, registrationSequence)` order.
2. Advance the clock to `tsOpen` and give the trusted bar evidence to
   `SimulatedExchange`.
3. Traverse each configured evidence frontier in order. At each frontier:
   - update market state;
   - match orders whose activation cursor is eligible;
   - convert matches into venue facts;
   - drain each fact fully through canonical order, position, account, and
     portfolio reduction before advancing to the next frontier.
4. Fire timers whose deadlines occur before the next frontier. A bar model must
   state what intermediate times it can represent.
5. Advance the clock to `tsClose`, apply the close evidence, drain it, and mark
   positions and portfolio.
6. Mint and return the current-row strategy context. The source now observes
   fully reduced state.

Each later context command performs its own synchronous turn before returning.

`ctx.submit(Built(spec))`:

1. enqueue `SubmitOrder` with a kernel-minted timestamp and sequence;
2. admit the command or return `CommandRejected` without lifecycle mutation;
3. create/register the canonical `Order` and apply `Initialized`;
4. resolve execution route, client, and `AccountId`;
5. run risk and reservation checks;
6. author `Denied`, or reserve resources and author `Submitted`;
7. route through the execution client;
8. exchange admission creates a venue fact;
9. `ExecutionEngine` authors `Accepted` or `Rejected`;
10. retain the reservation on acceptance or release it on rejection;
11. drain all causally produced work to quiescence and return
    `CommandAdmitted`.

`ctx.cancel(orderId)` follows the `PendingCancel` path in section 7. It creates
no new reservation and no `Submitted` event. Command admission rejects an
unknown or terminal ID before `PendingCancel`. `ctx.modify` follows the
analogous `PendingUpdate` path once that capability is implemented; it adjusts
an existing reservation only after the modification is accepted.

Newly accepted orders receive an activation cursor strictly after all evidence
already traversed by `process_bar`. The outer Tea row transaction commits only
after the complete source body succeeds; only then are journal/effect snapshots
published. There is no implicit work left for a post-body hook.

Multiple market records at one timestamp preserve provider order through
`sourceOrdinal`. A future multi-source provider contract must make that order
explicit rather than depend on object iteration order.

### 8.1 No re-entrant partial state

A component appends outputs to the sequencer. It does not synchronously invoke
a strategy handler while another reducer is half-applied.

If fill-triggered strategy handlers are added later, a handler runs only after
the fill has updated order, position, account, and portfolio state. Commands it
creates are appended after that complete causal chain. An order event must not
advance ordinary bar-series history.

The first slice has no order-event callback surface.

### 8.2 Evidence eligibility

Each market datum owns an evidence sequence. Each admitted order owns an
activation cursor.

- Existing orders may consume evidence at or after their cursor.
- A strategy-created order may not inspect earlier open/high/low evidence from
  the bar that caused the strategy evaluation.
- The bar strategy decision timestamp is `tsClose`. A normal order created
  after that decision cannot fill at that already-observed close. A future
  market-on-close order must be submitted before its documented cutoff and is
  a distinct order policy.
- For quote/trade-driven execution, a later explicit model may permit execution
  against a still-current top of book after the callback; that contract does
  not retroactively consume earlier evidence.
- A bar matcher may use one configured synthetic intrabar path only when the
  input lacks finer evidence. The model and limitation must be reported.
- Unsupported fidelity fails setup. An L2/L3 model never silently degrades to
  OHLC behavior.

This causal cursor replaces NextOpen/OHLC/Path Trade families.

### 8.3 End of data

Stopping a backtest is not a venue event:

- an open position remains open and is marked at the final available price;
- a working GTC order remains working;
- no order is expired, canceled, or filled merely because input ended;
- forced liquidation, cancel-on-stop, or DAY/GTD expiry requires an explicit
  policy/event and timestamp.

## 9. Venue and matching model

`SimulatedExchange` owns one `MatchingEngine` per instrument. A matching engine
stores current market evidence and venue working-order representations keyed by
canonical IDs. It does not own the canonical OMS `Order` object.

The matching engine produces a match fact such as:

```text
Match {
    clientOrderId
    venueOrderId
    referencePrice
    executableQuantity
    liquiditySide
    evidenceCursor
}
```

The exchange combines the match with `FillModel` and `FeeModel` to create an
authoritative `VenueFill` fact without a canonical `PositionId`.
`ExecutionEngine` resolves the OMS position identity, authors `Filled`, applies
the Order reducer, obtains `PositionTransition`, consumes/releases the matching
Risk reservation, and then sequences Account and Portfolio reduction exactly
once:

```text
Order reducer
    -> Position reducer / PositionTransition
    -> Risk reservation consumption or release
    -> Account reducer
    -> Portfolio projection
```

Matching invariants include:

- trigger and execution are separate facts;
- stop-market triggers become market execution eligibility;
- stop-limit triggers become limit execution eligibility;
- limit execution never violates the limit price;
- partial liquidity creates multiple `Filled` events with unique `TradeId`s;
- price/time priority is deterministic within one venue/instrument;
- OCO sibling cancellation is ordered before strategy code can observe the
  winning fill;
- matching never performs balance, margin, position, or P&L mutation.

Bar traversal, current top of book, queue position, probabilistic fill, and
latency are replaceable models under one exchange boundary. They are not
separate brokers.

## 10. OMS, positions, accounts, and portfolio

### 10.1 OMS mode

`OmsType` is route/account configuration.

**Netting**

- one canonical position per `(accountId, instrumentId)`;
- same-side fills increase it;
- opposite-side fills reduce, close, or flip it;
- a flip realizes the old exposure and opens the remainder at the fill price.

**Hedging**

- multiple positions may exist for one instrument;
- a new entry receives a new `PositionId`;
- a reducing/closing order targets an explicit `PositionId`;
- a venue-provided position ID takes precedence; otherwise the OMS generates
  one deterministically.

The matching engine emits execution facts without knowing either policy.
`ExecutionEngine` attaches the canonical `PositionId` before reducers apply the
fill.

`NetPortfolio`, `LotPortfolio`, `NetLedger`, and `LotLedger` disappear.
Independently tracked lots are hedged positions. Pyramiding is a strategy/risk
constraint, not a Portfolio class.

### 10.2 Route resolution and risk reservations

Execution routing resolves `ExecutionClientId`, venue, and `AccountId` before
risk evaluates an order. An explicitly supplied route must agree with the
instrument and account; otherwise the order is denied.

`RiskEngine` owns a reservation ledger keyed by `ClientOrderId`. It reads but
does not mutate Account or Position stores. An accepted order reserves the
resources that competing orders must no longer treat as available:

- buy/open orders reserve maximum quote-currency spend including commission;
- reduce/close orders reserve reducible position quantity;
- other policies reserve the documented margin or inventory resource.

The first slice admits a cash-account market order only with a deterministic
price-protection collar derived from the last eligible mark and configured
maximum adverse ticks. Risk reserves against the worst permitted fill plus
commission. `FillModel` cannot execute outside that collar. If the next market
price is outside it, the accepted order produces an explicit price-protection
terminal event rather than an unaffordable fill.

Reservations are created before `Submitted`, retained while the order is
working, consumed pro rata by fills, and released on denial, venue rejection,
cancel, expiry, or full fill. A canonical fill is therefore always bookable;
Account is never asked to reject an authoritative execution after matching.

### 10.3 Position reducer

The Position store alone owns:

- signed/open quantity;
- exact open cost/proceeds and quantity basis;
- realized P&L;
- opening and closing timestamps;
- fill/trade membership;
- open, closed, and flipped status.

It consumes canonical fills already associated with a `PositionId`. It returns
an immutable `PositionTransition` containing old/new quantity and basis,
opened/closed quantity, and gross realized-P&L delta. It never chooses fill
price, checks buying power, or routes orders.

Authoritative net-position basis is never a rounded average price. For a long
position, the reducer stores exact gross open cost in quote minor units plus
open quantity; same-side fills add both integers. An average entry price is a
derived rational/display view only and is never fed back into P&L. When partial
reductions land, closed cost is allocated by a specified integer
multiply-divide rule, every remainder stays with the open position, and the
final close consumes the full residual. Short proceeds and flip transitions
receive the symmetric explicit rule before those capabilities are admitted.
This preserves accounting identities without fractional tick basis.

### 10.4 Account reducer

The Account store alone owns:

- cash and currency balances;
- commissions;
- venue-reported locked balances;
- initial and maintenance margin;
- settled leverage/account state;
- account type and venue association.

Local pre-trade holds belong only to `RiskEngine.ReservationStore`. Risk derives
available buying power or reducible quantity from the immutable settled
Account/Position views minus its existing reservations; Account does not mirror
those reservations in a second mutable field. Matching reads neither view.

For a fill, Account consumes the authoritative execution fact, commission,
risk-reservation consumption, and `PositionTransition`. It does not recompute
position closure or realized P&L independently.

### 10.5 Portfolio projection

Portfolio projects Account, Position, and current mark state into:

- net and gross exposure;
- realized and unrealized P&L;
- equity;
- margin utilization;
- strategy-facing position and account views.

Position P&L is gross of commissions. Portfolio exposes total commissions and
derives `netPnl = grossRealizedPnl + grossUnrealizedPnl - totalCommissions`.
Entry, reduction, close, and reversal fees are never independently subtracted
again by Position or Portfolio.

Win rate, profit factor, drawdown, and report-only trade statistics belong to a
separate analyzer unless they are required for live risk decisions.

## 11. Strategy-facing API

The following is the target API after the corresponding order capabilities
land; the first slice exposes only market construction, submit, cancel, and
read queries. Strategies receive narrow facades over the same shared reference
state:

```tea
build = ctx.orders().limit(
    instrumentId,
    order.Side.buy,
    quantity,
    limitPrice
)

switch build
    OrderBuild.Built(spec) =>
        submitResult = ctx.submit(spec)
        switch submitResult
            CommandResult.CommandAdmitted(commandId, orderId) =>
                ctx.modify(orderId, limitPrice = replacementPrice)
                ctx.cancel(orderId)
            CommandResult.CommandRejected(commandId, orderId, reason) => na
    OrderBuild.InvalidOrder(invalidId, reason) => na

position = ctx.portfolio().position(instrumentId)
equity = ctx.portfolio().equity(accountId)
working = ctx.execution().open_orders(instrumentId)
```

The public contract is:

- `OrderApi` creates `OrderBuild` results with fresh `ClientOrderId`s; a built
  variant carries the validated immutable specification, and it never creates
  the canonical mutable `Order` aggregate;
- `ExecutionApi` submits, modifies, and cancels canonical orders;
- `ExecutionApi` exposes opaque order/open-order views;
- `PortfolioApi` exposes immutable account, position, exposure, and valuation
  snapshots with no mutable child references;
- convenience helpers such as `entry`, `close`, `rebalance`,
  percent-of-equity sizing, and bracket construction are optional libraries
  implemented on top of primitives;
- source code never calls matching, applies fills, selects a fill reference
  price, or coordinates broker/portfolio phases.

There is one exactly-once `process_bar` market-ingress call in the first source
slice, not a family-specific execution lifecycle. Package visibility prevents
direct access to the kernel's internal command methods; only a valid current-row
context can submit. A later standard strategy-program ABI may remove even that
call, but this RFC does not add a host-recognized Strategy object or a second
compiler/runtime path.

## 12. Tea language and runtime prerequisites

### 12.1 Already implemented

- nominal reference-valued structs;
- aliasing across fields, calls, collections, and history;
- direct mutable methods without receiver copy-out;
- recursive/cyclic storage graphs;
- transactional allocation and in-place field mutation;
- abort, suspension retry, commit, reachability, and deterministic Heap limits;
- collection headers with value/history semantics.

### 12.2 Required before the accepted vertical slice

#### Tagged unions and exhaustive payload matching

The kernel requires heterogeneous command/event queues without an enum tag plus
many unrelated `na` fields. Add a storable immutable union type and exhaustive
payload matching. Illustrative syntax:

```tea
export union OrderCommand
    Submit(OrderSpec order)
    Modify(ClientOrderId orderId, Quantity quantity, Price price)
    Cancel(ClientOrderId orderId)

switch command
    OrderCommand.Submit(order) => ...
    OrderCommand.Modify(orderId, quantity, price) => ...
    OrderCommand.Cancel(orderId) => ...
```

The language RFC must define nullability, history, payload evaluation order,
exhaustiveness, duplicate arms, storage layout, and transaction behavior.
Copying a union copies each payload using its ordinary Tea semantics, so a
struct payload would still be a live reference. Trading command/event unions
therefore admit only snapshot-safe inline primitives, enums, nested unions, and
fixed inline payload records defined by the union feature; they never contain a
mutable `StorageRef` or a collection that can reach one.
`OrderSpec` is represented by immutable union variants containing its complete
snapshot fields, not by embedding a mutable struct reference. Union equality,
map-key support, recursive unions, and generic unions may defer.

The same RFC extends `effect.emit` schemas, Runtime ABI encoding, and
`TraceSink` serialization to unions. Variant tag and payload ordering are
stable artifact facts. The kernel retains only bounded row outbox state plus
sequence/count; committed command/event snapshots stream through the ordinary
buffered effect transport after transaction commit. `TraceSink` hashes the
canonical serialized bytes outside Tea. The kernel never grows an unbounded
`array<OrderEvent>` inside Tea.

#### Package-level struct member visibility

Strategies must not mutate Order, OMS, Account, Position, Exchange, or
MatchingEngine internals. Struct fields and methods should be package-private
unless exported. An exported struct with private fields must not expose a raw
field-wise constructor outside its package.

Components with distinct write ownership live in distinct packages, even while
each experimental package is one source file. Package-private visibility must
not be defeated by placing every service in one broad `trading` package. This
is a checker and documentation feature; it needs no runtime representation.

#### Transactional invariant failure

Add one minimal universally source-callable invariant primitive. A false
invariant raises a stable execution error after evaluating its condition and
message once; the current Heap/Ring/emission transaction aborts. It is not
catchable in V1 and must not represent denial, rejection, cancellation, or any
other business outcome. The checker does not special-case compiler-shipped
package provenance.

### 12.3 Required domain contract without a new language type

The first slice uses checked safe-integer units, explicit instrument metadata,
and checked add/subtract/multiply-divide helpers for Price, Quantity, Money,
Time, rates, and IDs. It defines all maxima, tick/lot/multiplier conversions,
rounding points, and overflow outcomes before implementation. A later
nominal-scalar/newtype proposal may improve allocation and type safety, but the
trading kernel must first prove the required operations and conversion rules.

The first slice also requires one trusted bar-ingress adapter. `process_bar`
reads the configured instrument plus current `bar_index`, `time`, `time_close`,
`open`, `high`, `low`, and `close` directly; no caller-provided timestamp or
evidence cursor enters the kernel. It validates/quantizes that evidence before
advancing the sequencer. Multi-instrument and non-bar execution require a later
canonical typed market-event provider contract.

### 12.4 Required before broad order-book scale

Current collection implementations preserve the desired source semantics but
copy flat backing eagerly. Before broad multi-order or multi-instrument claims:

- arrays need persistent chunked-vector/deque backing;
- maps need indexed persistent lookup while retaining specified iteration
  order;
- matching needs an ordered price map and FIFO queues;
- mutation must share unchanged pages and preserve abort/GC semantics;
- deterministic allocation/logical-byte tests must reject quadratic growth.

Do not make ordinary collections reference-semantic for performance.

### 12.5 Can defer

- runtime interface values and dynamic dispatch;
- first-class callbacks and a generic message bus;
- inheritance, interface defaults, and associated types;
- generic `Result<T, E>` and user exceptions;
- multi-file library packages for the experimental first slice;
- exact decimal/newtype language support;
- GPU reference, collection, queue, or trading-kernel lowering.

Concrete reference structs and static generic specialization are sufficient for
the first kernel. Multi-file packages become mandatory before the trading
libraries expand beyond a reviewable experimental slice.

## 13. First executable vertical slice

The first slice proves the architecture with intentionally bounded behavior:

- one venue;
- one account;
- one instrument;
- one base/account currency;
- cash account with no borrowing or margin;
- netting OMS;
- long entry and full-position sell close only; no short sale, partial
  reduction, or reversal;
- confirmed historical bars with trusted `barIndex`, `tsOpen`, and `tsClose` as
  market evidence;
- explicit-quantity market orders only;
- synchronous submit, risk denial, exchange acceptance/rejection, and cancel;
- full fill at the next eligible bar open;
- one explicit market price-protection collar and cash/quantity reservations;
- deterministic tick slippage and per-fill commission;
- close marking;
- cash, signed quantity, average basis, realized/unrealized P&L, and equity;
- canonical immutable command/event journal;
- JavaScript execution only.

An order submitted after strategy evaluation on bar N becomes eligible at bar
N+1 open. It cannot consume bar N open/high/low. This is the slice's central
causality invariant.

The slice uses small declared queue/order bounds while collection backing is
still eager. Configuration includes maximum live orders, row-outbox records,
causal waves, and total drain steps. A bound overflow is an explicit setup or
execution failure, never truncation.

Realtime/provisional multi-update bars are outside the slice. `process_bar`
requires `barstate.isconfirmed` and transactionally fails on an unconfirmed or
realtime update. `process_bar` accepts each confirmed row exactly once;
transaction abort restores its generation so retry remains legal without
duplicating the turn.

### 13.1 Independently derived acceptance scenarios

1. Submit on bar 0, synchronously accept, fill exactly once at bar 1 open.
2. Cancel after acceptance and before bar 1; produce no fill, fee, or position.
3. Enter and later exit with hand-derived slippage, commission, cash, basis,
   realized P&L, unrealized P&L, and equity.
4. Risk denial occurs before `Submitted`; venue rejection occurs after it.
5. Duplicate submit, unknown cancel, and cancel-after-terminal produce
   `CommandRejected` without an invalid lifecycle event or state mutation.
6. Two accepted orders cannot spend the same reserved cash or close the same
   reserved quantity.
7. A gap beyond the accepted market collar produces
   `Canceled(PriceProtection)` and releases its reservation, never an
   unaffordable fill.
8. Two kernels created from identical configuration remain fully isolated.
9. End of data with an open position marks but does not liquidate it.
10. End of data with a working GTC order does not expire or cancel it.
11. Duplicate, skipped, or out-of-order `process_bar`, and use of a stale row
    context, fail transactionally; commands and queries are unavailable without
    a current context.
12. An aborted or suspended row produces no duplicate command, event, fill,
    commission, ID allocation, or mutation on retry.
13. Replaying the same market tape and commands produces a byte-identical
    canonical journal.

For every committed row:

```text
position quantity = sum(signed filled quantities)
total commissions = sum(fill commissions)
cash + marked position value = equity
equity - initial equity = gross realized P&L + gross unrealized P&L
                          - total commissions
Filled-event count = committed venue-fill count = position/account applications
```

## 14. Expansion after the first slice

1. Add working limit, stop-market, and stop-limit orders.
2. Add modification, DAY/GTD expiry, and full transition-table coverage.
3. Add deterministic partial fills and liquidity constraints.
4. Add order lists and OCO/OTO/OUO contingency relationships.
5. Add configurable bar paths while preserving activation cursors.
6. Add short positions, partial reductions, reversals, and margin models.
7. Add multiple instruments, venues, accounts, and currencies.
8. Add hedging OMS and migrate independently tracked lot strategies.
9. Add quote, trade, L2, and L3 evidence models.
10. Add latency, local order emulation, funding, settlement, liquidation, and
    reconciliation as separate components.

Each step extends the same command/event/reducer boundaries. It must not create
another Trade, Broker, Ledger, or Portfolio family.

## 15. Legacy behavior is not automatically inherited

The following current behaviors require an explicit compatibility or model
decision. They are not kernel defaults:

- end-of-data automatically expires pending orders;
- one pending order plus one attached exit;
- at most two fills per bar;
- pyramiding ownership keyed by an entry string;
- brackets represented as one pseudo-order;
- a target fill may be worse than its limit after adverse slippage;
- ambiguous OHLC bars always use nearer-extreme ordering with stop-winning
  ties;
- every bar uses `open -> nearer extreme -> farther extreme -> close`;
- reversal is a two-fill continuation with post-close rescaling;
- an order submitted after seeing a close can consume the already-seen bar
  range;
- missing quantity implies all-in sizing;
- margin is restricted to 0% or 100%;
- Portfolio produces the authoritative account snapshot for matching;
- replacement, contingency, or position ownership is keyed by strategy labels.

Useful Pine-compatible behavior may return as explicitly named sizing,
bar-path, contingency, or compatibility policies on top of the kernel.

## 16. Migration and conformance

### 16.1 Classify existing tests

Every existing trading test is classified before migration:

- `spec`: portable domain/accounting/causality invariant;
- `legacy-compatibility`: intentional Pine/reference-emulator behavior;
- `obsolete-shape`: assertion about a Trade factory, interface, specialization,
  method name, closure name, or old lifecycle.

The useful current evidence includes:

- the 44 compile-through cases in
  `src/testing/strategy-components-e2e.test.ts`;
- the hash-pinned strategy-components execution fixture;
- EMA final metrics and effect count;
- BB final metrics and normalized fill tape;
- Alice default/trailing metrics and fill/lifecycle hashes.

These are kept in a separate legacy-economic ledger. They are not independent
specification truth: the strategy-components fixture includes implicit sizing
and final expiry; EMA depends on legacy sizing; BB encodes the old OHLC/bracket
model; Alice encodes immediate per-lot behavior. The new specification ledger
contains only independently derived command/event/accounting scenarios.

Checker tests pinning `NextOpenTrade`, `OhlcTrade`, `PathTrade`, `LotTrade`,
`NetLedger`, `LotLedger`, or their exact concrete functions are migration tests,
not behavioral oracles.

### 16.2 Migration sequence

1. Freeze and classify the existing tests and normalized economic tapes.
2. Land tagged unions, union effect transport, member visibility, and the
   invariant primitive with independent language tests.
3. Land trusted bar ingress, a deterministic decimal-text-to-ticks provider
   adapter for real catalog CSVs, checked tick/lot/money conversion, and exact
   arithmetic probes. No catalog migration may quantize through an unchecked
   binary float.
4. Build the market-order kernel beside the legacy libraries.
5. Add one hand-derived, hash-pinned execution fixture through the real
   load/check/node/codegen/bind/run/TraceSink path.
6. Migrate one minimal explicit-quantity strategy, then simple next-open
   examples.
7. Add order kinds and matching fidelity in causal order: limit, stop,
   stop-limit, TIF/modify, contingency, partial fills, path/trailing.
8. Add short/netting transitions, then hedging and Alice last.
9. Before final acceptance, migrate every runnable catalog profile. A profile
   still blocked on a named capability is quarantined from the runnable catalog
   rather than left on a legacy family indefinitely.
10. Add a separate analyzer before migrating profiles whose published outputs
    require drawdown, win rate, profit factor, or round-trip statistics.
11. Delete all old families, shape tests, and catalog/docs references.
12. Rewrite `docs/strategy.md` around the kernel and mark the old decoupling plan
    historical.
13. Start a separate GPU RFC only after JavaScript semantics and journals are
    stable.

Economic parity compares stable facts:

```text
timestamp, instrument, side, quantity, execution price,
commission, position/account transition
```

Legacy generated IDs, pseudo-order shapes, and exact old lifecycle hashes do
not constrain the new event algebra. A model-specific reference price may be
compared only when both models declare the same evidence contract. Every
reviewed deviation records the first divergent event and rationale; no oracle
is automatically regenerated.

## 17. Acceptance gates

### Architecture

- Strategy source declares no account, broker, matching, fill, or portfolio
  implementation.
- Matching never mutates OMS, account, position, or portfolio state.
- A fill updates order, position, reservation, account, and portfolio exactly
  once and in that order.
- Route and `AccountId` resolve before risk; reservations prevent competing
  accepted orders from spending the same resource.
- Netting and hedging are OMS configuration, not class families.
- Market fidelity is evidence/configuration, not a Trade/Broker family.
- No compiler/runtime stage recognizes a trading package/type/method name.

### Determinism and causality

- Every queued item has a stable total-order key.
- Same-timestamp journals are exact and hash-pinned.
- New orders cannot consume already-traversed evidence.
- `process_bar` is exactly once and monotonic; command methods require a valid
  current-row context and drain synchronously before returning.
- Unsupported fidelity fails setup.
- Replay over identical bindings is byte-identical.

### Order state

- Every transition admitted by the current implementation phase has a positive
  test; its target-table expansion is reviewed before code lands.
- Every forbidden transition in the current phase has a fail-closed test.
- Invalid commands are rejected before they can create an invalid lifecycle
  event.
- Risk denial, venue rejection, cancellation, expiry, fill, and backtest stop
  remain distinct.
- Duplicate event/trade IDs cannot double-apply state.

### Accounting

- Hand-derived cash, quantity, basis, commission, realized/unrealized P&L, and
  equity identities hold after every fill and mark.
- Partial reduction, close, and reversal fee allocation rules are explicit
  before those capabilities land.
- Portfolio reporting cannot change execution state.

### Transactions and storage

- Error/suspension aborts all kernel mutations and buffered journal records.
- Retry does not consume IDs twice or duplicate commands/events/fills.
- Commands/events published outside the transaction are immutable snapshots.
- The kernel streams committed journal records and retains no unbounded
  in-Program journal collection.
- First-slice bounded storage fails explicitly; broad matching does not ship
  with whole-store copying per mutation.

### Repository

- New conformance fixtures use repository-local, independently derived data.
- `npm run typecheck`, `npm test`, and `npm run docs:check` pass.
- No automatic golden/oracle rewrite path exists.
- Final migration has zero runnable catalog, library, test, or documentation
  references to `NextOpenTrade`, `OhlcTrade`, `PathTrade`, `LotTrade`,
  `NextOpenBroker`, `OhlcBroker`, `PathBroker`, `ImmediateBroker`,
  `BrokerEmulator`, `NetLedger`, `LotLedger`, `NetPortfolio`, or
  `LotPortfolio`.

## 18. Intentional V1 deviations from NautilusTrader

- synchronous direct dispatch instead of reproducing its complete message-bus
  topology;
- one explicit Tea kernel root rather than a Rust service graph;
- bar-only evidence and full-fill market execution in the first slice;
- one venue, instrument, account, and currency;
- no live execution client, reconciliation, persistence, or recovery;
- no latency, funding, settlement, liquidation, corporate actions, or L2/L3
  queue simulation;
- no order-event strategy callbacks in the first slice;
- no runtime interface values or plugin loading;
- no GPU lowering in this RFC.

These are staged omissions, not alternative component boundaries.

## 19. Deferred questions

- the final source spelling of tagged unions and exhaustive matching;
- the final exported/package-private member syntax and constructor rules;
- whether exact financial scalars become nominal primitive newtypes;
- the persistent ordered-map/deque representation and complexity contract;
- the standard ABI, if any, for strategy order-event handlers;
- live reconciliation, external order claims, and unknown command outcomes;
- checkpoint/replay APIs beyond the canonical journal;
- the separate GPU physical representation for reference structs, queues,
  unions, and bounded working orders.

None of these questions changes the ownership, event, causality, or reducer
contracts established above.
