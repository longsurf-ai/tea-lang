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
- `TeaNode` owns DataStream/Observable wiring. Successive `.bind()` calls use
  `bindModule()` synchronously and return new nodes while retaining the row
  Observables attached by earlier steps. Every TeaNode owns exactly one
  recursive `JSModule`. The compiler `Program` is consumed during lowering and
  is not retained by either value.
- `.to(sink)` is the currently implemented execution boundary. It creates one
  `JSRuntime`, serializes synchronized rows through `step()`, sends
  `StepResult` values to the sink, and disposes the runtime when the Observable
  terminates. Current TeaNode steps are final (`provisional: false`).
- TeaNode execution currently supports numeric series and parameters only.
  Builtin row construction and static-request child execution fail explicitly
  in `.to()`. Generated binding may already produce static request settings;
  do not confuse readiness with implemented TeaNode request wiring. Dynamic
  requests fail earlier at the noder boundary.
