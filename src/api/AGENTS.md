# api

The JavaScript embedding surface over generated `JSModule` values. This
directory owns host binding validation and Observable composition; compiler and
runtime semantics remain in their existing packages.

## Invariants

- `bindModule(module, assignments)` returns
  `Effect<JSModule, BindingError>`. It never mutates its input and never
  subscribes. Parameter assignments store validated Tea values; series
  assignments store only a supplied marker. Observable, DataStream, provider,
  and sink objects never enter a JSModule snapshot.
- Every loaded `JSModule` starts with ordered bindings derived from its
  manifest. `ready()` means that module context has complete input bindings and
  generated `JSModuleBinding` data. `remaining()` reports its missing inputs in
  manifest order; `TeaNode.ready()` checks the recursive request tree.
- Generated binding evaluation is provider- and subscription-free: it resolves
  params, bound depths, output arguments, activity, and static request
  settings. Its loader-private evaluator may use one local abort-only Heap
  transaction for struct/collection expressions, but no Heap, runtime state,
  evaluator, or subscription enters the returned JSModule.
- `TeaNode` owns DataStream/Observable wiring and keeps one stable public
  identity. Successive `.bind()` calls synchronously draft the recursive module
  state and row graph, install both atomically, and return `this`; a failure
  installs neither. Binding after execution starts or after disposal is
  rejected. The compiler `Program` is consumed during lowering and is not
  retained by either TeaNode or JSModule.
- Every TeaNode creates one plain `Subject<StepResult>`. The first `.to(sink)`
  validates execution support, subscribes the sink first, creates and owns one
  `JSRuntime`, then connects the already-built row graph through sequential
  `step()` calls to the Subject. Later `.to()` calls only subscribe sinks to
  that Subject, so late sinks receive future values only and never create a
  second runtime or source subscription. `.to()` returns the sink subscription;
  the node retains the execution connection. `dispose()` idempotently cancels
  that connection, disposes the runtime, and completes the Subject. Current
  TeaNode steps are final (`provisional: false`).
- TeaNode execution currently supports numeric series and parameters only.
  Builtin row construction and static-request child execution fail explicitly
  in `.to()`. Generated binding may already produce static request settings;
  do not confuse readiness with implemented TeaNode request wiring. Dynamic
  requests fail earlier at the noder boundary.
