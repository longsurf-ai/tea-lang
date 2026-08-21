# Trade component decoupling

Status: implemented and verified.

Implementation note (2026-08-16): `src/tea-lib/strategy.tea` has been replaced by
`src/tea-lib/trade.tea`; the universal `trade.net` and broad broker/portfolio
supersets are gone. The shipped direct families are `trade.nextOpen`,
`trade.ohlc`, `trade.path`, and `trade.lots`, each storing its compatible
concrete broker and portfolio values directly. All fourteen examples use those
families, and the WGSL boundary remains exactly four eligible sources. The
`trade.net` examples below record the accepted design stage and are superseded
by those direct factories.

## Objective

Strategy source owns only trading policy and policy state. Compiler-shipped Tea
components own reusable execution and accounting behavior. Adding another
broker, matcher, or portfolio implementation must not require an example
strategy to implement an account, construct a fill, or emit execution effects.

The refactor must preserve every existing execution result and must not make a
currently WGSL-eligible Program ineligible. Static abstraction must not enlarge
the reachable scalar GPU closure with lot collections, book state, or unused
path machinery.

## Ownership

- The entry strategy package owns indicators, signals, session/grid/cooldown
  state, risk policy, and the decision to create, replace, cancel, or close an
  order.
- A broker owns commands and working orders, identifiers, validation,
  cancellation/replacement/OCA state, execution timing, commission, slippage,
  canonical order/fill effects, and conversion of a match into a fill.
- A matching policy, when separated from a broker, owns only market traversal,
  trigger priority, and a resumable market cursor. It returns match decisions;
  it never emits effects or mutates an account or portfolio.
- A portfolio owns its mutable account ledger, cash and margin state,
  positions/lots, basis, fill application, marking, PnL, and reports. It never
  decides whether, when, or where an order fills.
- A Tea-authored coordinator owns one compatible broker and portfolio value and
  sequences broker decision -> portfolio apply -> refreshed account view ->
  continuation. It contains no strategy-specific policy and is not a host or
  compiler lifecycle hook.

An account view is an immutable execution projection produced by a portfolio
and consumed by a broker. A separate mutable Account component is deferred
until multi-account behavior justifies it; no strategy may implement one in
the meantime.

## Public shape

The concrete entry script is the strategy. A universal runtime `Strategy`
value is not required. The current `strategy` library is execution composition
and will move to the `trade` package after its replacement API stabilizes.

The intended source roots are policy-specific concrete values, for example:

```tea
var trading = trade.net(
    broker = broker.new(...),
    portfolio = portfolio.net(...)
)

var trading = trade.lots(
    broker = broker.book(...),
    portfolio = portfolio.lots(...)
)
```

Tea interfaces remain checker-only static constraints. Distinct execution
families may use distinct broker, portfolio, result, and coordinator
interfaces. Unsupported combinations must fail during checking; they must not
be represented by `supports_*` probes, unrelated stub methods, or runtime
rejections.

Ordinary bar execution uses a resumable, policy-neutral protocol. A broker may
return one fixed execution step, the coordinator applies its fill, then asks
the broker to resume with a fresh account view. The concrete broker determines
whether that means next-open, OHLC, ordered-path, or close processing. Simple
brokers must compile without reachable path or collection code.

Lot execution is explicitly bounded at bind time. Until WGSL collection layout
and bind-dependent effect capacity are supported, the lot family remains
fail-closed for GPU without contaminating the scalar family.

## Strategy-state boundary

Per-strategy exit policy is not portfolio state. In particular, target, stop,
trailing activation/extreme/distance, grid tags, and similar policy fields move
out of `portfolio.OpenTrade`. The strategy may retain them in its own bounded
state keyed by a stable trade identifier. Submitted working-order state belongs
to the broker. Portfolio open-trade records retain only accounting identity,
side, quantity, entry basis, and fees.

Strategies submit commands or intents. They do not pass an execution reference
price, call `portfolio.apply`, mutate open-trade accounting records, construct
`broker.Order`/`broker.Fill`, or emit broker lifecycle effects.

## Migration

1. Freeze full lifecycle journals, metrics, GPU eligibility, reachable closure,
   and isolated performance baselines.
2. Add semantic ownership tests and policy-specific positive/negative checker
   pairing tests.
3. Add immutable account views, normalized execution steps, and new concrete
   net coordinator/broker/portfolio contracts beside compatibility APIs.
4. Migrate next-open and ordinary scalar strategies, then close-processing and
   bracket strategies, proving same-profile parity after each batch.
5. Migrate ordered-path strategies while preserving post-entry path causality
   and a scalar GPU closure.
6. Add the bounded lot/book family, move Alice policy state into its strategy,
   and remove immediate reference-price and mutable-open-trade escape hatches.
7. Delete universal broker/portfolio supersets, capability probes, stubs, and
   obsolete lifecycle methods.
8. Rename `src/tea-lib/strategy.tea` and `library("strategy")` to `trade` in one
   isolated breaking commit after the API shape is stable. Update all source
   closure hashes deliberately.

## Acceptance gates

- All fourteen example strategies compile and retain their existing full
  execution semantics. Exact lifecycle journals include submissions,
  replacements, cancellations, rejections, expirations, fills, identifiers,
  quantities, prices, fees, and ordering.
- Existing final metrics and full configured sweep extrema/counts remain
  unchanged within their established numeric profiles.
- The current WGSL-eligible set remains eligible. Representative Program
  closure tests prove that scalar paths contain no lot collections, immediate
  execution code, or unused matcher families.
- Real Dawn CPU/GPU differential tests cover next-open, close, bracket,
  reversal, path cursor, bind-sized history, multi-binding, and multi-chunk
  execution.
- Interfaces erase before Program IR; codegen/runtime contain no dispatch on
  strategy, broker, matcher, portfolio, or package names.
- Bind-time capacities remain resource bounds rather than arbitrary source
  loop limits. Overflow and unsupported GPU capacity fail before publication.
- Isolated warmed sweep measurements must not regress materially solely due to
  abstraction. Reachable call-graph/state-size checks are the deterministic
  primary guard; timing is the release gate.
