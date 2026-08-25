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
  `bind()` dispatches only to parameters or streams; keyed request streams fan
  out recursively, and `snapshot()` assembles the complete module tree only
  when exposed or executed. Public methods remain synchronous and mutable.
  The compiler `Program` is consumed during lowering and is retained by neither
  the Node nor JSModule.
- The `tea` tagged template is the deliberate synchronous exception: it only
  performs in-memory compile/load construction and throws `TeaCompileError`.
  Effects remain implementation details of `bind`/`to`/`dispose`.
- Every Node owns one plain `Subject<StepResult>`. The first `.to(sink)` call
  runs internal setup Effects, subscribes the sink, creates one `JSRuntime`,
  connects the RxJS row graph, and returns the Subscription. Later `.to()`
  calls only add sinks for future values. RxJS owns ongoing values/errors/
  completion, and teardown interrupts the current step Effect. `dispose()` is
  synchronous and idempotent. Current steps are final (`provisional: false`).
- Node execution currently supports numeric series and parameters only.
  Builtin row construction and static-request child execution fail explicitly
  in `.to()`. A concrete manifest may already contain static request settings;
  do not confuse readiness with implemented Node request wiring. Dynamic
  requests fail earlier at the noder boundary.
