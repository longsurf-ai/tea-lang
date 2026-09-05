# recipe

A Recipe is a saved, common way of using Tea's public `Node` API. It chooses the
Node's inputs and output observer, calls the same `bind()` and `to()` operations
an embedding user would call, and waits for that run to finish. It is not a
second executor. The only shared abstraction is the minimal Recipe interface;
there is no base class, registry, loader, or generic factory.

## Invariants

- `recipe.ts` owns the one shared contract: `Recipe<R>` is a configured
  Tea run with `execute(): Promise<R>`. Finite indices, provisional attempts,
  commit, inputs, and disposal are concrete Recipe details, not part of that
  interface.
- Production Recipe code composes `Node`, `BindingInput`, `DataStream`, and
  ordinary RxJS observers from `src/api/`. It does not import `Context`,
  runtime module binding, request merge, layout, state, Heap, or runtime output
  contracts. Missing public behavior is added to Node before Recipe uses it.
- `batch/index.ts` is the complete production Batch implementation. It accepts
  only a public `Node`, `BindingInput[]`, and `Observer<Datum>`; `execute()` may
  only bind, subscribe, await Node completion, await the observer's public
  `completion` Promise when it exposes one, count Node-owned indices, and dispose.
- Keep the Recipe interface and `BatchRecipe` methods documented with ownership,
  lifecycle, and concrete examples at the level of `src/api/node.ts`.
- Node owns runtime state, request-child execution, history, Heap, and output.
  A Recipe must not reproduce or wrap those mechanics.
- Parameters and series remain the only binding forms. Contextual builtin values
  currently come from the statically linked Pine Extension and never enter a
  binding union.
- External data acquisition is application machinery, not Tea semantics. Do
  not recreate source registries, plans, jobs, or lifecycle wrappers.
