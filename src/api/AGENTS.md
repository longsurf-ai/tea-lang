# api

The JavaScript embedding surface over the canonical `Program`. This directory
owns binding values and Observable composition; compiler and runtime semantics
remain in their existing packages.

## Invariants

- `bindModule(target, assignments)` is the externally immutable public binding
  transition. It
  returns `Effect<BoundModule, BindingError>`, never mutates its `Program` or
  prior `BoundModule`, and never subscribes to an Observable. Passing a
  `Program` creates the first immutable `BoundModule` even when `assignments`
  is empty; a Program with no semantic requirements is ready after that first
  call. Passing a `BoundModule` creates the next immutable snapshot.
- `BoundModule.ready()` means every extracted requirement has a target and the
  owned `JSModule.bind(values)` has produced immutable `JSModuleBinding` facts.
  `ready()` does not mean any source is subscribed, and it does not promise
  that `TeaNode.to()` supports every fact currently representable there.
  `remaining()` preserves Program requirement order.
- Generated code and bind facts are private state associated with the minimal
  public `BoundModule`; callers cannot forge that state. Bind evaluation is
  provider- and subscription-free: it resolves params, bound depths, output
  arguments, activity, and static request pairs/options through the pure module
  binding result. A generated implementation may use the loader-private helper
  and one local abort-only Heap transaction for struct/collection expressions,
  but no Heap, runtime state, evaluator, or subscription is retained or
  transferred into the returned BoundModule.
- `TeaNode` owns DataStream/Observable wiring. Successive `.bind()` calls use
  `bindModule()` synchronously and return new nodes while retaining the row
  Observables attached by earlier steps. Every TeaNode owns exactly one
  always-present `BoundModule`; `tea()` performs the initial empty binding for
  the root and each static request child, and the Program is available only as
  `node.module.program`. `BoundModule` stores individual targets only; it never
  owns row synchronization.
- `.to(sink)` is the currently implemented execution boundary. It creates one
  `JSRuntime`, serializes synchronized rows through `step()`, sends
  `StepResult` values to the sink, and disposes the runtime when the Observable
  terminates. Current TeaNode steps are final (`provisional: false`).
- TeaNode execution currently supports numeric series and parameters only.
  Builtin row construction and static-request child execution fail explicitly
  in `.to()`. Binding may already produce static request facts; do not confuse
  fact readiness with implemented TeaNode request wiring. Dynamic requests fail
  earlier at the noder boundary.
