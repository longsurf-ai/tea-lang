# api

The JavaScript embedding surface over generated `Module` values. This
directory owns host binding validation and Observable composition; compiler and
runtime semantics remain in their existing packages.

`tea.ts` owns only synchronous tagged-template compile/load construction;
`node.ts` owns the public `Node` interface and its private class implementation.

## Invariants

- `Module.bind(values, context?)` is the sole synchronous parameter-binding operation. It mutates and returns the same module; Node keeps that stable module tree and owns stream connections in its own state. Module readiness covers configuration; Node readiness adds root and child streams.
- Modules contain real Arrow schemas, parameter/context values and execution descriptions, never Observables or supplied flags. Each request entry carries its child module. Node exposes its existing module directly. Failed binding leaves the tree unchanged; execution start closes binding.
- Default preparation uses loadModule(...).bind(); late calculations remain private. Missing fixed context leaves explicit unresolved facts. Rebinding cannot preserve stale facts or silently alter another context.
- Public `Node` is an interface; file-private `TeaNode` owns one module context,
  its RxJS data, and recursive request-child Nodes directly. There is no
  parallel `TeaNodeState` or continuously reattached parent module tree.
  `bind()` dispatches only to parameters or streams. A request stream is keyed
  by the direct top-level request declaration's variable name, not its symbol;
  it binds exactly that child, and a key shared with a root series is
  ambiguous. All keys validate before mutation. Root and child module identities
  remain stable through binding and inspection. Public methods remain
  synchronous and mutable. The compiler `Program` is consumed during lowering
  and is retained by neither the Node nor Module.
- The `tea` tagged template is the deliberate synchronous exception: it only
  performs in-memory compile/load construction and throws `TeaCompileError`.
  Binding and stepping are synchronous; RxJS owns stream delivery and teardown.
- Every Node owns one plain `Subject<Datum>`. The first `.to(sink)` call
  subscribes the sink, creates one `Context`,
  recursively constructs child execution streams, folds their results into the
  parent through `sync()` in request-id order, and returns the Subscription.
  That Subscription controls only its sink; later `.to()` calls add sinks for
  future values without reconnecting execution. RxJS owns ongoing
  values/errors/completion. Node-owned connection teardown stops the complete child graph between synchronous steps. `dispose()` is synchronous and
  idempotent. Current steps are final (`provisional: false`).
- `Context` keeps `StepResult` internal to Node. Node adds its successful-step
  index and exact source time, then publishes one lossless Arrow-schema row:
  source-named set fields contain nullable raw values, append fields contain
  raw lists in per-column execution order, numeric `NaN` remains `NaN`,
  absence and an explicit null output share null, and provisional state is explicit. A thrown
  observer `next()` callback terminates the shared execution and reaches every
  observer through `error()`.
- `DataStream` owns one Arrow schema validation per emission plus optional
  Clock metadata. Schemas are genuine Arrow `Schema` objects, copied at
  construction and exposed through defensive copies. Sources decode bytes and
  perform format-specific scalar coercion; domain refinements use ordinary RxJS
  composition. A one-field schema may validate scalar emissions directly. `CSVSink` uses conventional `a`/`w`
  modes with optional schemas; `StdoutSink` prints generic Datums immediately
  without owning a completion Promise. JSON/CSV conversion belongs to those
  sinks and never rewrites the in-memory Datum.
- `Node.to()` accepts an ordinary RxJS Observer; there is no parallel Sink
  interface. Each synchronized input value produces exactly one runtime step
  through ordinary RxJS `map`. Do not add queue or capacity policy unless a
  runtime step gains a real asynchronous boundary.
- WebSocket source/sink adapters accept final JSON text datums only and require
  caller-supplied Arrow schemas. They do not reconnect or invent provisional state.
  Source subscription owns socket connection/teardown; sink completion waits
  for its bounded send queue and `bufferedAmount` to drain.
- Node execution supports numeric series, parameters, scalar `security`
  requests, and `security_lower_tf` arrays. Untimed scalar requests consume one
  child result per parent input; timed scalar requests apply the request's
  `availability` and `fill` policies. Collect requests select
  contained-interval, event-time-window, count-window, then one-to-one-array
  synchronization in that order; the exact clock, boundary, completion, error, and cancellation
  policies belong to `docs/requests.md`. Collect batches cross the API/runtime seam only as frozen
  scalar arrays and become ordinary Tea arrays inside the parent Heap
  transaction. This collect path is Node-only. The statically enabled Pine
  Extension derives contextual builtins from Node index, `DataStream.indices`,
  and current input time; dynamic requests fail earlier at the noder boundary.

- Parameters, input requirements, state descriptions, and one output schema live directly on the module. Both set and append results use one cell array; Node adds coordinates without rebuilding a payload language. Live streams stay in Node.
