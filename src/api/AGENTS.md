# api

The JavaScript embedding surface over generated `JSModule` values. This
directory owns host binding validation and Observable composition; compiler and
runtime semantics remain in their existing packages.

`tea.ts` owns only synchronous tagged-template compile/load construction;
`node.ts` owns the public `Node` interface and its private class implementation.

## Invariants

- `bindModule(module, assignments)` returns
  `Effect<JSModule, BindingError>`. It never mutates its input and never
  subscribes. Parameter values and series-supplied markers are the only module
  binding forms. Observable, DataStream, provider, and sink objects never enter
  a JSModule snapshot.
- Binding deep-copies the recursive manifest tree, writes the assignment, runs
  each generated direct `concretize()` method on its caller-owned copy, freezes
  the result, and returns a new snapshot. Old module and manifest references
  remain unchanged; code and layouts may be shared.
- `ready()` and ordered `remaining()` facts are derived from manifest parameter
  values, series markers, concrete depths, activity, output arguments, and
  request contexts; public `Node.ready()` checks the recursive request tree. There
  is no parallel parameter vector or binding-result object.
- Concretization is provider- and subscription-free in the public API and is
  restricted to non-allocating const/input/simple expressions. It never owns a
  frame, Heap, runtime state, evaluator, or subscription.
- Public `Node` is an interface; file-private `TeaNode` owns one module context,
  its RxJS data, and recursive request-child Nodes directly. There is no
  parallel `TeaNodeState` or continuously reattached parent module tree.
  `bind()` dispatches only to parameters or streams. A request stream is keyed
  by the direct top-level request declaration's variable name, not its symbol;
  it binds exactly that child, and a key shared with a root series is
  ambiguous. All keys validate before mutation. `snapshot()` assembles the
  complete module tree only when exposed or executed. Public methods remain
  synchronous and mutable. The compiler `Program` is consumed during lowering
  and is retained by neither the Node nor JSModule.
- The `tea` tagged template is the deliberate synchronous exception: it only
  performs in-memory compile/load construction and throws `TeaCompileError`.
  Effects remain implementation details of `bind`/`to`/`dispose`.
- Every Node owns one plain `Subject<StepResult>`. The first `.to(sink)` call
  runs internal setup Effects, subscribes the sink, creates one `JSRuntime`,
  recursively constructs child execution streams, folds their results into the
  parent through `sync()` in request-id order, and returns the Subscription.
  That Subscription controls only its sink; later `.to()` calls add sinks for
  future values without reconnecting execution. RxJS owns ongoing
  values/errors/completion. Node-owned connection teardown interrupts the
  current step Effect and whole child graph. `dispose()` is synchronous and
  idempotent. Current steps are final (`provisional: false`).
- Node execution supports numeric series, parameters, scalar `security`
  requests, and `security_lower_tf` arrays. Scalar requests consume one child
  result per parent datum. Collect requests select count-window,
  event-time-window, then one-to-one-array synchronization in that order; the
  exact clock, boundary, completion, error, and cancellation policies belong to
  `docs/requests.md`. Collect batches cross the API/runtime seam only as frozen
  scalar arrays and become ordinary Tea arrays inside the parent Heap
  transaction. This collect path is Node-only. Builtin row construction remains
  unsupported, and dynamic requests fail earlier at the noder boundary.
