# Tea strategy composition, effects, and resumable execution

Status: superseded by
[`20260816-trade-component-decoupling.md`](20260816-trade-component-decoupling.md).
The historical `strategy.configure` shape below was replaced by direct
`trade.nextOpen`, `trade.ohlc`, `trade.path`, and `trade.lots` coordinators.

## 1. Objective

Build the strategy surface entirely from ordinary Tea values and calls while
keeping compilation and execution generic:

```text
source + Tea libraries
        |
        v
load -> check -> node -> Program
                      /       \
                     v         v
                    JS        WGSL
                     |         |
                     v         v
             generic runtime   generic GPU runtime
```

No checker, noder, code generator, or runtime may recognize a strategy
component by package, type, variable, or method name. The only privileged
strategy syntax remains the script metadata declaration `strategy(...)`.

The first complete source shape is:

```tea
strategy("EMA crossover", overlay=true)

import broker
import portfolio
import strategy

var strat = strategy.configure(
    broker = broker.basic(...),
    portfolio = portfolio.basic(...)
)

strat.begin(open, bar_index)

if longCondition
    strat.entry("Long", strategy.long)

strat.end(close, barstate.islast)

plot(strat.equity(), "Equity")
```

`configure`, `begin`, `entry`, and `end` are ordinary Tea calls. The checker
checks their types, not their lifecycle order. Calling them zero times, twice,
conditionally, or in the wrong order is valid Tea and has only the behavior
defined by those functions.

## 2. Decisions and non-goals

### Decisions

- Rename the execution emulator package from `market` to `broker` so market
  data and order execution are not conflated.
- Add method-only static interfaces with implicit satisfaction, modeled after
  Go's source-level method-set relation.
- Interfaces are compile-time constraints, never runtime values.
- Store configured components in a concrete, statically specialized
  `strategy.Strategy<B, P>` value rooted by the script's `var strat`.
- Add imported-package runtime globals as a general Tea capability, but do not
  use hidden package state for the strategy object.
- Model non-column results with the generic `effect.emit(value)` intrinsic.
- Keep `plot` and other row-aligned results on the existing dense-output path.
- Replace the mandatory batch Journal with caller-supplied execution sinks.
- A sweep is a list of complete bindings, not a parameter-specific job type.
- Make GPU execution resumable: persistent lane state stays on-device while
  bounded chunks of dense results and sparse effects are read back.
- The pre-launch JavaScript Runtime ABI is version `1`. It has one current
  schema and no compatibility or migration branches.

### Explicit non-goals for this plan

- First-class interface values, dynamic dispatch, witness/itab tables, type
  assertions, reflection, interface embedding, pointer method sets, or
  heterogeneous interface collections.
- Checker enforcement of strategy lifecycle, order policy, or method names.
- A process-wide package singleton like a linked Go executable.
- Hidden broker or portfolio state, host-side matching, or host-side
  accounting.
- Unbounded GPU effect allocation or host callbacks during a dispatch.
- Full WGSL support for every existing Program construct. Unsupported generic
  constructs continue to fail closed.

## 3. Language layer: static interfaces and concrete generic storage

### 3.1 Source syntax

Add top-level interface declarations:

```tea
export interface Broker
    bool has_pending() const
    Order submit(string commandId, Side side, int signalBarIndex)
    Fill on_open(float price, float buyingPower, float quantity, int barIndex)
    Order finish()
```

Interface bodies contain method signatures only. Every parameter and result is
explicitly typed. A trailing `const` is part of the required receiver mode.
Interfaces have no fields, implementations, defaults, inheritance, or
`implements` clause.

Add constrained type parameters to user-type declarations:

```tea
export type Strategy<B: broker.Broker, P: portfolio.Portfolio>
    B broker
    P portfolio
    // ordinary fields and methods
```

The first slice does not add generic-function declaration syntax. Existing
free-function stenciling specializes the unannotated `configure` function at
each concrete call, and the generic constructor infers `B` and `P` from its
field arguments:

```tea
export configure(broker, portfolio) =>
    Strategy.new(broker, portfolio)
```

### 3.2 Checker model

Add checker-owned semantic declarations:

- `InterfaceObject`: canonical package/name identity and ordered required
  methods;
- `InterfaceMethod`: name, receiver mode, concrete parameter types, and
  result type;
- `TypeParameterObject`: declaration-local name and interface constraint;
- `GenericUserTypeObject`: source template;
- one cached concrete `UserTypeObject` per template and ordered concrete type
  tuple.

Every concrete tuple owns one canonical
`GenericInstantiation {template, typeArgs, object, info}`. Its substituted
methods/functions and all expression, selection, constructor, and call facts
live in that instance's `Info`; they never overwrite the template/package
`Info` shared by another instantiation. Noder always consumes the concrete
instance and its matching facts.

Interface and type-parameter types remain checker-only. They must not be added
as runtime `TypeKind`s. A generic template is checked symbolically against its
constraints; construction substitutes concrete Program types and creates the
ordinary canonical `UserType`, fields, methods, and method instances already
consumed by noder.

A concrete type satisfies an interface when every required method resolves
directly with exactly the same name, arity, parameter types, result type, and
receiver mode. Extra methods are allowed. V1 performs no parameter/result
variance.

The checker records only the canonical concrete generic instantiation needed
by each type/constructor occurrence. It does not record runtime witnesses and
does not inspect strategy lifecycle calls.

### 3.3 Noder and backend boundary

Interfaces and generic templates node to nothing. Before Program publication,
noder asserts that every value type is concrete. Existing IR remains
sufficient:

- `Strategy<Basic, Basic>.new(...)` -> `NewUserValue`;
- `strat.begin()` -> `CallMutableMethod`;
- constraint-resolved component calls -> concrete direct method calls;
- `var strat` -> the existing persistent root and initializer.

JS and WGSL therefore receive only ordinary concrete UDT layouts and calls.
There is no interface IR or runtime dispatch representation.

### 3.4 Acceptance gates

- Parser/dumper: exported and private interfaces, qualified constraints,
  constrained generic UDTs, malformed signatures, and duplicate methods.
- Checker: implicit satisfaction, extra methods, every mismatch class,
  inaccessible constraints, arity, constructor inference, canonical instance
  identity, different instantiations, substituted defaults, and recursive
  layout rejection.
- Template validation: an invalid unused generic method still fails checking;
  a type parameter can call only methods in its constraint.
- Noder golden: no interface/type-parameter reaches Program.
- JS/WGSL differential: two distinct component pairs lower to concrete calls
  and retain isolated state.
- A deliberately misordered lifecycle script still compiles, proving there is
  no lifecycle policing.

## 4. Imported package runtime globals

### 4.1 Semantic identity

Allow a library root to contain private `var` declarations in addition to the
currently allowed declarations and `const`s. Exported mutable globals and
package `varip` are staged; packages expose state through ordinary exported
functions and types in V1.

Each package-level variable becomes a canonical `VariableObject` carrying its
owning `Package`, declaration, source order, storage, type, and initializer
facts. Package Scope remains the declaration namespace; `Package.exports`
remains public API only and never becomes a list of runtime globals.

Functions may mutate variables owned by their own package. They may read but
may not mutate globals owned by another package or the entry script. This is a
package-ownership rule, not a spelling or scope-depth heuristic.

### 4.2 Initialization

Checker computes and cycle-checks initializer dependencies:

1. imported packages before importers;
2. dependencies before dependents within a package;
3. source order for otherwise independent declarations.

Dependencies include globals referenced transitively through called
functions. V1 initializers must be deterministic Tea expressions and cannot
emit outputs/effects, make requests, or perform host operations.

The checked result publishes each package's exact initializer expression,
`Info`, and dependency order to noder. Noder projects only the transitive
package-state closure reachable from the root Program, deduplicated by
canonical `VariableObject` identity.

Each projected package global uses the existing rollback-aware `Name.init`
thunk plus explicit package-initializer order. `Program.init` remains the
separate bind-time/frame-free phase and is not repurposed for runtime state.
Frame reach order must never become an accidental initializer schedule. Both
targets execute package `Name.init` work inside the context's first row
transaction:

- successful row commit persists the initialized bit and values;
- suspension/error/rollback discards the whole init transaction and retries it;
- a zero-row binding does not execute it, matching ordinary Tea `var`;
- init code cannot observe current-row values or publish outputs/effects.

### 4.3 Runtime identity

```text
one semantic Package/Object graph
        -> one Name projection per Program context
        -> fresh physical storage per binding
```

- Two aliases and a diamond import share one state instance within a Program
  context.
- Every CPU binding gets fresh package state.
- Every request-child Program context gets fresh package state.
- Every GPU lane gets fresh package state.
- Re-execution and suspension use the ordinary provisional/commit rollback
  rules; failed first-row transactions rerun state initialization.

This deliberately differs from Go's once-per-process linked package storage.

### 4.4 Acceptance gates

- Private global read/write through exported functions.
- Alias and diamond imports share state.
- Independent bindings, request children, and GPU lanes do not share state.
- Transitive initialization, stable source-order tie breaking, and cycle
  diagnostics.
- Initializer rollback/retry and zero-row behavior match ordinary Tea `var`.
- Forbidden cross-package writes, `varip`, effects, requests, and host work
  fail in the checker.
- CPU/WGSL parity for a scalar package-global fixture.

## 5. Generic effects

### 5.1 Semantic split

```text
dense row-aligned value  -> Program.outputs / EmitStmt
sparse zero-or-many event -> Program.effects / EmitEffectStmt
```

Add the intrinsic:

```tea
effect.emit(OrderEvent.new(...))
effect.emit(FillEvent.new(...))
effect.emit(AlertEvent.new(...))
effect.emit(LabelCreate.new(...))
```

It accepts one typed transportable value and returns `void`. Every source call
site owns one stable `EffectDecl` id and payload schema. Calls may occur in
functions, library methods, and row-time control flow; repeated executions of
one call site append distinct records in source execution order.

The source checker accepts primitives, enums, strings/colors, and recursively
fixed user values. Resource handles, output references, collections, and tuples
remain rejected until their ownership/serialization contracts exist. WGSL
transports the same fixed payload shapes, including interned literal strings;
payloads requiring dynamic allocation continue to fail closed.

Effects are forbidden in bind/initializer contexts and request children for
V1. This is a generic context rule, not strategy policy.

### 5.2 Program and ABI

Add:

- `Program.effects: readonly EffectDecl[]`;
- `EffectDecl {payloadType, sourcePosition}`;
- `EmitEffectStmt {effect, payload}`;
- manifest effect schemas with exact runtime layout ids;
- `Runtime.emitEffect(eid, payload)`;
- an execution sink declaration and append operation alongside dense output.

`effect` is a checker-owned predeclared builtin namespace. `emit<T>(T): void`
is its intrinsic selection; it is not a Tea source library and is not tied to
strategy. The builtin root cannot be redeclared or shadowed, following the
same rule as other native roots. No implicit import is involved.

The manifest is the only runtime schema source. Human type spelling is never
reparsed as a machine type.

### 5.3 CPU transaction semantics

The JS runtime buffers effects inside the existing row transaction. Suspension,
error, and rollback discard the buffer. Dense writes and sparse effects form
one publication unit:

```ts
OutputSink.publish({row, outputs, effects, provisional});
```

The runtime validates and prepares that unit before its non-throwing internal
state commit, then delivers it once after commit. A sink exception makes that
binding terminal-failed; committed state is never retried, so the runtime
cannot duplicate an effect. The runtime does not interpret payloads or know
which are orders, fills, alerts, or drawings. A sink that needs chunk- or
whole-run atomicity exposes an explicit transaction of its own.

Replace the mandatory bounded journal with optional sinks under
`src/providers/sinks/`:

- `MemorySink` for unbounded structured capture in examples/tests;
- existing table/trace sinks extended only where their product contract needs
  effects.

Capacity, retention, serialization, and whole-run atomicity are sink policies,
not mandatory runtime semantics.

### 5.4 Acceptance gates

- Zero, one, and multiple same-row effects, including repeated execution of
  the same call site.
- Nested UDF/library emission and stable cross-call ordering.
- Suspension retry, provisional execution, error, rollback, and disposal
  produce no duplicate or leaked effects.
- Nominal schemas distinguish identically named types from different
  packages.
- Source-valid but target-unsupported payloads fail WGSL eligibility cleanly.
- Dense plots retain their current behavior and are not routed through the
  sparse effect buffer.

## 6. Generic multi-binding runtime

Delete the separate plan/job types, parameter-only metadata, and
backend-specific job wrappers. The backend-neutral batch input is simply:

```ts
readonly BindInputs[]
```

Each binding already owns all sweep dimensions: parameters, provider,
symbol, timeframe, deterministic clock, limits, and sink. Caller array order
is canonical identity and result order. Empty arrays are valid.

The CPU helper becomes:

```ts
runCpuBatch(module, bindings) -> BindingRun[]
```

It performs ordinary `bind()` / `runAll()` / `dispose()` once per element and
returns only generic execution summaries. It does not capture results or
assign job ids; sinks own results and callers own business metadata.

The GPU runtime accepts the same ordered `readonly BindInputs[]` through
`createGpuExecution(device, artifact, bindings, options)`. It resolves provider
contexts asynchronously and materializes only artifact-required inputs into
private packed buffers. Array order is lane identity; no job id,
parameter-specific sweep wrapper, caller-materialized series object, or
caller-owned dense capacity enters the API.

Acceptance gates cover mixed providers, symbols, timeframes and parameters;
empty batches; array-order determinism; fresh state; disposal on success and
failure; and independent per-binding sinks.

## 7. Broker, portfolio, and strategy libraries

### 7.1 `broker.tea`

Owns canonical order/execution vocabulary, the `Broker` interface, and the
first deterministic `Basic` implementation. V1 keeps the current deliberately
small semantics:

- long-only, flat-or-long account view;
- one pending market order;
- next-open eligibility;
- all-in/all-out sizing;
- deterministic adverse slippage and taker fee;
- final pending-order expiry.

The concrete broker owns the lifecycle effects produced by its own decisions:
`Basic` emits submission, fill, rejection, and expiry values directly. The
generic strategy layer never infers a rejection reason from an opaque return
value.

Its interface uses canonical `broker.Order`, `broker.Fill`, and `broker.Side`
values so alternative deterministic or probabilistic implementations satisfy
the same contract without changing Strategy storage or dispatch.

### 7.2 `portfolio.tea`

Owns the `Portfolio` interface and first `Basic` implementation: cash,
position, fill application, realized PnL, fees, mark-to-market equity, peak,
drawdown, and observable getters. It consumes `broker.Fill` but never decides
whether or where an order fills.

### 7.3 `strategy.tea`

Owns:

- `Strategy<B: broker.Broker, P: portfolio.Portfolio>`;
- `configure(broker, portfolio)`;
- ordinary `begin`, command, `end`, and observable methods;
- canonical strategy command/status enums.

`begin` processes prior eligible work and applies fills before user signals.
`entry`/`close` submit commands. `end` marks the portfolio and performs the
chosen final-bar policy. These are library semantics only. The language does
not enforce or inject them.

### 7.4 Header/package name coexistence

`strategy(...)` remains the first-statement script metadata syntax, while
later `strategy.configure` resolves the imported package. Checker elaborates
the header as declaration syntax before ordinary package-name binding and does
not reinterpret later package selectors as declarations. No runtime sees the
header call.

### 7.5 Acceptance gates

- Existing hand-derived next-open accounting fixture is migrated to
  `var strat` over `broker.Basic` and `portfolio.Basic`.
- Two alternative conforming component types prove implicit interface
  satisfaction and concrete specialization.
- Calls in intentionally wrong lifecycle order compile.
- Order/fill/rejection/expiry records are emitted by the concrete Tea broker,
  never reconstructed by Strategy or a host journal.
- JS and WGSL agree under the declared numeric tolerance.

## 8. Resumable chunked GPU execution

### 8.1 Public runtime

The public GPU runtime is an asynchronous session:

```ts
createGpuExecution(device, artifact, bindings, options)
    -> Promise<GpuExecution>

GpuExecution.runChunk() -> Promise<GpuChunkResult>
GpuExecution.runAll()   -> Promise<GpuRunSummary>
GpuExecution.dispose()
```

Options are physical resource policy, such as `maxRowsPerChunk`,
`effectRecordsPerLane`, and `maxGpuBytes`. Callers do not specify dense-result
capacity; it is exact from lane count, chunk rows, and artifact schema.

### 8.2 Persistent lane state

WGSL moves the artifact's complete cross-row execution state out of
function-local variables into a read-write state buffer. Each lane has a
disjoint state block containing every target-supported persistent slot,
history/ring cell and cursor, package global, initialization bit, supported
request-child temporal state, and control fields such as `nextRow`. Only
per-row temporaries and reusable chunk result buffers remain outside it.
Constructs whose temporal state has no physical representation continue to
fail WGSL eligibility; chunking may never silently drop such state.

Each dispatch:

1. loads one lane's state;
2. initializes it exactly once;
3. executes absolute rows
   `[nextRow, min(nextRow + chunkRows, totalRows))` sequentially;
4. writes persistent state and the next cursor back;
5. exposes only bounded dense/effect result buffers for readback.

State remains GPU-resident between chunks. `bar_index`, `isfirst`, `islast`,
and result row ids use the absolute row and total binding extent, never the
chunk-local index.

### 8.3 Dense and sparse buffers

Dense storage is reusable and exact:

```text
[lane][chunk-local row][dense scalar cell]
```

Sparse storage is fixed per lane:

```text
status: {count, overflow, firstOverflowRow, firstOverflowEffect}
records[effectRecordsPerLane]: {absoluteRow, effectId, typed payload}
```

All supported effect payloads use artifact-owned aligned physical layouts and
a uniform record stride. One invocation owns one lane and advances it
sequentially, so lane-local append needs no atomics.

Codegen computes a conservative maximum effects per row from the closed call
graph with fixed rules:

- one `effect.emit` contributes one;
- sequential composition sums;
- mutually exclusive branches take their maximum;
- a call contributes its callee's bound;
- a statically bounded loop contributes `bound * body`;
- effect-reachable recursion/SCCs, data-dependent loop bounds, or any
  expansion that cannot be proven fail closed.

The runtime chooses a chunk size whose static maximum fits the configured
region; overflow status remains a defensive invariant check.

### 8.4 Readback and failure

After every dispatch the executor copies dense results, effect status, and the
bounded effect regions into MAP_READ staging buffers. V1 may copy the complete
small per-chunk region and decode only `[0, count)`; a later two-step status and
prefix copy is an optimization.

Decoded dense/effect rows are delivered through the sink's chunk publication
contract, and the chunk result reports absolute row ranges. All overflow and
decode validation happens before publication. A sink exception makes the
session terminal-failed; the already advanced device state is never retried.
Buffers and cursors are cleared for the next chunk only after successful
publication, while semantic lane state remains untouched.

An overflow publishes none of the current chunk, marks the session failed,
and requires a new execution with a larger resource budget. It never silently
truncates. Results from earlier completed chunks remain valid; callers that
need whole-run atomicity provide a transactional sink.

### 8.5 Acceptance gates

- Dawn: multiple lanes and multiple chunks preserve strategy/package state.
- CPU/GPU equality for absolute rows, final-bar behavior, dense values, sparse
  payloads, and effect ordering.
- Final short chunk, zero-effect chunks, different row counts, and already
  completed lanes.
- Exact buffer layouts, resource-ceiling failures, automatic chunk sizing,
  and cleanup after partial failure.
- Defensive overflow publishes no current chunk.
- One-chunk execution remains a valid special case of the same session.

## 9. ABI and migration cleanup

Define one shared JavaScript Runtime constant:

```ts
export const RUNTIME_ABI_VERSION = 1 as const;
```

Generated modules emit that value, `TeaModule.abi` uses its literal type, and
the runtime validates against it. Replace all hand-written ABI literals in
tests and documentation. Do not retain versions 4/5, migration code, or
conditional schema readers.

The WebGPU physical contract is a separate target contract and also remains at
its sole current version `1`; it is not a second source-language compilation
path.

Delete obsolete surfaces only after their replacement path and every caller
are green: the old batch journal/plan, retired GPU entry points, bespoke
example orchestration, and stale docs describing host-owned strategy lifecycle
events.

## 10. Execution stages and gates

The implementation proceeds in dependency order. Each stage lands only after
its focused tests, typecheck, formatting, and diff check pass.

1. **ABI 1 and generic binding baseline**
   - one ABI constant;
   - `runCpuBatch(module, readonly BindInputs[])` with caller-owned sinks;
   - add `MemorySink` as optional unbounded capture and migrate dense-result
     consumers;
   - establish ordered `BindInputs[]` as the shared logical CPU/GPU job shape.
2. **Static interfaces and constrained generic UDTs**
   - parser/checker semantic model;
   - concrete specialization and noder boundary;
   - JS and WGSL direct-call proof.
3. **Package runtime globals**
   - package-owned variables, dependency order, reachable projection;
   - JS/request/GPU isolation and rollback.
4. **Generic effects**
   - source intrinsic, Program/manifest, JS transactional delivery;
   - unified row publication contract;
   - fixed WGSL payload layouts and effect-bound analysis;
   - migrate any remaining Journal consumer to ordinary sinks.
5. **Tea component libraries**
   - `broker`, `portfolio`, `strategy` interfaces and Basic types;
   - migrated source fixture and human example.
6. **Resumable GPU runtime**
   - external lane state, chunk buffers, provider-based bindings, readback,
     resume, overflow, and cleanup.
7. **Documentation and removal pass**
   - language/reference/runtime/strategy/GPU docs and generated editor/docs;
   - remove superseded journal and GPU entry points plus stale terminology only
     after repository-wide caller migration is complete.
8. **Final verification**
   - `npm run typecheck`;
   - `npm test`;
   - generated docs/editor checks;
   - Node 22 Dawn multi-chunk integration;
   - repository-wide stale-name and strategy-special-case audit.

9. **Public execution and CLI**
   - expose `executeProgram(program, bindings, backend)` as the one generic
     CPU/GPU host harness;
   - parse source-declared parameter flags after the fixed CLI options;
   - make `tea run` print system, parameter, dense, and typed-effect sections;
   - make `tea sweep` expand bounded Cartesian bindings, default to GPU, and
     retain only final dense values plus effect counts;
   - run Dawn only in the isolated Node integration process;
   - delete the bespoke example runner.

## 11. Final invariants

- One frontend pipeline produces one Program for every target.
- Interface satisfaction disappears before Program.
- Configured strategy state is the explicit `var strat`, never hidden state.
- Package globals are isolated per Program binding/lane, not process-wide.
- Strategy lifecycle consists only of ordinary user-visible calls.
- The checker never validates lifecycle order.
- Tea code owns broker, portfolio, lifecycle, and event payload semantics.
- Runtime owns only generic chronology, transactionality, binding, buffers,
  dispatch, readback, and sink delivery.
- Dense outputs and sparse effects have distinct generic contracts.
- GPU execution is bounded, resumable, deterministic, and fail-closed.
- ABI version is `1`, with exactly one current schema.
