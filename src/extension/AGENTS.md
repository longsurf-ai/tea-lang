# extension

Concrete domain vocabulary and contextual execution facts layered over generic
Tea. An Extension starts as one file; there is no Extension interface, registry,
loader, selection framework, or dynamic loading.

## Invariants

- `pine.ts` owns Pine contextual builtin evaluation from the Node's committed
  index, finite DataStream extent, and current input datum. It never owns an
  Observable, Node, JSRuntime, subscription, or external data source.
- Parameters and series remain the only binding forms. An Extension supplies the
  module's typed builtin inputs directly to execution.
- Pine remains statically enabled while it is the only Extension. Move more of
  the compile-time Pine vocabulary here only with a concrete, tested ownership
  change; do not invent a general extension catalog first.
