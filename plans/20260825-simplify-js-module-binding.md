# Simplify JavaScript module binding around concrete manifests

Status: implemented and verified on 2026-08-25.

## 1. System map

```text
CURRENT
generated JS --> evaluateBinding callback --> ModuleBindEvaluation
                                              | frame + temporary Heap
                                              v
                                       JSModuleBinding
                                              v
                                      configured JSModule

TARGET
generated JSModule + binding assignment
          | parameter value or series-supplied marker
          v
deep-copy manifest --> direct generated concretization --> frozen JSModule snapshot
                                                            |
                                                            v
                                          JSRuntime owns State/history/Heap
```

- `Program` remains the compiler source of truth; manifest ids and layouts
  remain the runtime source of truth.
- Binding has two public forms: parameter value or series/DataStream. The
  module stores the value/marker; public `Node` owns the Observable through
  its private TeaNode implementation.
- Binding is immutable: reuse code/layouts, deep-copy and freeze the recursive
  manifest tree, and leave old module references unchanged.
- `JSRuntime` remains the sole owner of mutable history, frame state, and Heap.
  Parameter replacement is allowed before execution starts; binding remains
  rejected after the first `.to()` creates the runtime.
- Pre-runtime configuration expressions are restricted to non-allocating
  const/input/simple expressions. Struct/collection allocation must not keep a
  second frame-and-Heap evaluator alive merely to configure a module.

The existing data moves into the concrete manifest instead of a parallel
`JSModuleBinding`:

| Current owner | Concrete-manifest owner |
| --- | --- |
| `bindings[].parameter.value`, `parameterValues` | `manifest.params[pid].value` |
| `bindings[].series.supplied` | `manifest.series[sid].supplied` |
| `binding.retention` | each manifest `depth` field |
| `binding.activeParams` | `manifest.params[pid].active` |
| `binding.outputs` | `manifest.outputs[oid].boundArgs` |
| `binding.requests` | `manifest.requests[rid].context` |

## 2. Problem

The current ABI calls generated `evaluateBinding(values)` back through
loader-injected `$evaluate`, provisions `ModuleBindEvaluation` with a temporary
frame and Heap, accumulates `JSModuleBinding`, and copies the result into a
module snapshot. This conflates host input binding with depth, UI state, output
declarations, and request configuration; static facts make the same round trip.

Progressive binding should produce ordinary immutable code plus a new concrete
manifest snapshot which CPU or GPU execution consumes directly. Streams,
providers, buffers, runtime state, and compiler `Program` objects stay outside
the module; no second compiler or runtime path is added.

## 3. Implementation

1. **Make the manifest the complete binding snapshot** — `src/runtime/module-abi.ts`, `src/runtime/schema.ts`, `src/runtime/output.ts`
   - Add current parameter value/activity, series supplied state, output bound
     arguments, and concrete request context/options to their existing specs.
   - Keep `DepthSpec.bound` only on incomplete snapshots; a ready module has no
     unresolved depth. Remove `ModuleInputBinding`, `JSModuleBinding`,
     `parameterValues`, `binding`, and `evaluateBinding` from `JSModule`.
     Replace the latter with one direct generated
     `concretize(manifest, contextConstants?)` method that mutates only the
     caller's fresh manifest copy.
   - Bump `RUNTIME_ABI_VERSION` for the incompatible generated shape; reject
     stale artifacts without a compatibility branch.

2. **Emit direct manifest concretization** — `src/codegen/codegen.ts`, `src/codegen/lower.ts`, `src/runtime/load.ts`
   - Emit static depth, activity, output, and request values directly in the
     manifest. Emit ordinary ES2015 assignments only for facts that actually
     depend on parameters or permitted context constants.
   - The concretizer reads parameter values from the cloned manifest and writes
     concrete fields directly. It never calls an injected callback or receives
     `RuntimeContext`.
   - Load raw recursive modules without `$evaluate`/`$module`; preserve the
     portability parse gate and deterministic generation.

3. **Make binding one immutable manifest update** — `src/api/binding.ts`, `src/api/tea.ts`
   - Validate an assignment, deep-copy the module/request manifests,
     write the parameter value or series marker, run direct concretization when
     dependencies are present, freeze, and return a new module tree.
   - Derive readiness/missing inputs from manifest fields. Allow a parameter to
     replace an earlier value before execution; keep streams Node-owned and fan
     keyed request streams recursively through child Nodes.
   - Propagate compilation-global parameter values into request-child manifest
     snapshots so each child `ctx.param(pid)` reads its own current module.

4. **Consume the concrete manifest directly on CPU** — `src/runtime/js-runtime.ts`, `src/runtime/state-update.ts`, `src/runtime/fixed-history.ts`
   - Implement `ctx.param(pid)` from `module.manifest.params[pid].value`; remove
     the separate parameter-vector constructor path.
   - Size runtime histories and fixed-width accounting from concrete manifest
     depths; declare outputs and resolve static requests from their manifest
     fields. Buffers remain in `JSRuntime.State`, so rebinding never migrates
     execution state before runtime creation.

5. **Use the same snapshots for GPU bindings** — `src/runtime/gpu/session.ts`, `src/gpu/contract.ts`
   - For each `BindInputs` element, apply parameters and permitted provider
     context constants to the ordinary generated module, then read frame/input
     capacities from its concrete manifest.
   - Remove the binding-sidecar result contract while preserving one shared
     WGSL artifact and per-binding sizing; add no GPU-specific evaluator.

6. **Delete the parallel evaluator and update authorities** — `src/runtime/module-binding.ts`, `docs/runtime.md`, `docs/ir.md`, `docs/requests.md`, owning `AGENTS.md` files
   - Remove `ModuleBindEvaluation`, `BindFrame`, abort-only binding Heap logic,
     shape validation for `JSModuleBinding`, and obsolete configure helpers.
   - Reject aggregate/Heap-dependent configuration expressions during checking
     or noding with a user-facing diagnostic. Update docs and invariants to name
     the manifest snapshot, not generated binding evaluation, as the boundary.

## 4. Verification

- [x] `npm test -- src/api/js-module-binding.test.ts src/api/tea.test.ts` proves partial binding, pre-start parameter replacement, recursive readiness, and preservation of old module/manifest references.
- [x] `npm test -- src/codegen/portability.test.ts src/codegen/request-evaluation-order.test.ts src/codegen/output-bind-evaluation-order.test.ts` proves deterministic ES2015 output, direct static facts, and preserved source evaluation order; aggregate configuration now fails at the declared frontend boundary.
- [x] `npm test -- src/runtime/js-runtime.test.ts src/runtime/fixed-history.test.ts src/runtime/fixed-history-integration.test.ts` proves `ctx.param` reads manifest values and runtime-owned histories use concrete depths, outputs, and requests.
- [x] `npm test -- src/runtime/gpu/session.test.ts src/testing/execution-conformance.test.ts` proves CPU/GPU binding metadata and the hash-pinned compile-load-bind-execute path remain consistent.
- [x] `npm run typecheck && npm test` passes the complete standalone suite with no runtime/generated `JSModuleBinding`, `evaluateBinding`, `$evaluate`, or `ModuleBindEvaluation` surface; the portability deny-list still names forbidden legacy tokens.
- [x] `npm run test:gpu` passes on the Dawn-capable environment, demonstrating that different parameter bindings still share one shader while receiving distinct concrete manifest capacities.
