# Execute request child streams recursively through `sync`

Status: implemented and verified on 2026-08-26.
Final gates: 113 test files / 1,113 tests, documentation build, and 18 Dawn
integration tests passed under Node 22.

## 1. System map

```text
Tea source
  scalar = request.security(...)           -> scalar T
  window = request.security_lower_tf(...)  -> array<T>
                    |
                    v
Program RequestEdge{name, mode, captureType, resultType, child}
                    |
                    v
Node.bind({scalar: scalarStream, window: windowStream})
                    |
                    v
child DataStream -> child Node -> child JSRuntime -> child result stream
                                                        |
main DataStream ----------------------------------------+-> sync(policy)
                                                             |
                                                             v
                                                parent JSRuntime.step()
                                                             |
                                                             v
                                                  root Subject -> sinks
```

- The request assignment variable, not `symbol`, is the stream-binding
  identity. A request must be the direct initializer of one plain top-level
  declaration; inline, tuple-destructured, nested, block-local, and
  function-owned request calls are compile errors.
- The source-visible result shape is static: `request.security` returns `T`;
  `request.security_lower_tf` returns `array<T>`. Runtime policy selection may
  change synchronization behavior, never the compiled type or layout.
- `sync()` remains the only synchronization primitive. Scalar requests use
  one-to-one. Window requests select count-window, event-time-window, then
  one-to-one-array fallback in that order.
- This plan implements request execution only for public `Node`. The existing
  fixed-history provider adapter keeps its resolved-context/sample-merge
  behavior; it rejects `security_lower_tf` explicitly until that adapter gets
  a separately designed collect path. Builtin row wiring, provisional/final
  live updates, watermarks, and dynamic request contexts remain out of scope.
- No policy class, execution graph interface, timed-datum interface, or
  parallel Node state object is introduced. The representation is existing
  `RequestEdge`/manifest fields, `DataStream`, recursive `TeaNode`, and projector
  functions passed to `sync`.

## 2. Problem

`TeaNode` can recursively bind request-child streams, but it keys them by the
request symbol and `.to()` rejects every request. Symbol identity is ambiguous:
two assignments requesting the same symbol at different clocks need distinct
streams. The current root-only execution path also discards the source `time`
field, creates only one `JSRuntime`, and always sends `requests: []`.

The target is one lazy recursive RxJS execution graph. Each child owns an
independent `JSRuntime`, turns its input data into captured result values, and
uses `sync` to decide when those values make a parent datum executable. The
parent receives request inputs in manifest rid order. One root subscription
owns the complete graph, while the public `Node` API stays synchronous and
mutable and Effects remain internal.

## 3. Implementation

1. **Make every request a named, statically shaped top-level declaration** — `src/checker/check.ts`, `src/checker/info.ts`, `src/checker/catalog.ts`
   - While checking a `DeclStmt`, expose a request-binding context only when
     all of these hold: `mode === none`, the target is one `Name`, the
     declaration is at program top level, and the initializer itself (after
     parentheses) is the request `CallExpr`. `checkRequest()` accepts only that
     exact call object. It reports one user diagnostic for calls in expression
     statements, output arguments, another expression, tuple patterns, blocks,
     functions, methods, or request captures. This deliberately makes nested
     requests unavailable in this slice.
   - Add `bindingName` and `captureType` to the existing `RequestCall` fact;
     retain `resultType` as the source-visible call type. Do not add a parallel
     request map. Restrict captured results to scalar Tea values; structs,
     resources, collections, and tuples fail at the request call rather than
     later conflicting with the single-name declaration rule.
   - Keep `request.security` as scalar: `captureType === resultType === T`.
     Add the currently staged `request.security_lower_tf` catalog intrinsic
     with required `symbol`, `timeframe`, and captured `expression`; its
     `captureType` is `T` and its `resultType` is `array<T>`. Do not expose
     `gaps`/`lookahead` as Node synchronization policy. Existing scalar request
     options remain accepted for fixed-history compatibility but are ignored
     by Node policy selection.
   - Checker tests must pin the accepted direct declarations and diagnostics
     for `plot(request.security(...))`, a bare request, a function-owned
     request, a nested request, tuple destructuring, persistent declarations,
     and local blocks. They must also assert scalar versus array result types.

2. **Carry request identity and both physical layouts through Program and generated ABI** — `src/ir/program.ts`, `src/noder/noder.ts`, `src/codegen/codegen.ts`, `src/runtime/module-abi.ts`
   - Extend `RequestEdge` with `name`, `captureType`, and the existing
     source-visible `resultType`. Node the child `$result` Name and captured
     expression with `captureType`; node the parent `HistRead` with
     `resultType`. Set `MergeMode.Sample` for `security` and
     `MergeMode.Collect` for `security_lower_tf` instead of treating Collect as
     a codegen error.
   - Generate each `RequestSpec` with exact fields:

     ```ts
     {
       name: string; // direct declaration target
       merge: {
         mode: 'sample' | 'collect';
       }
       resultSlot: number; // child root-frame slot
       resultLayout: LayoutId; // child T
       layout: LayoutId; // parent T or array<T>
       depth: DepthSpec;
       dynamic: false;
       context: RequestSpec['context']; // existing concrete pair/options
     }
     ```

     For scalar requests `resultLayout === layout`; for window requests they
     differ. Keep dense rid ordering and the recursive child module array
     unchanged.

   - Bump `RUNTIME_ABI_VERSION` from 6 to 7 because generated manifests change.
     Update clone/freeze/validation projections without creating a second
     binding object or compatibility branch. Portability output remains plain
     ES2015 and deterministic.
   - Noder/codegen tests must assert the source name, mode, child/parent types,
     result slot, and both layouts, including two same-symbol variables with
     different timeframes.

3. **Collapse clock ownership into `DataStream` and preserve event time** — `src/api/clock.ts`, `src/api/stream.ts`, `src/api/node.ts`
   - Keep the branded `Clock` bigint and unit constants, including `i` as the
     irregular/unknown sentinel. Remove unused `Clocked`, `TimeSeries`, and the
     API-level `MergePolicy`. Do not replace them with another class or
     interface.
   - Add one optional constructor value to `DataStream`:

     ```ts
     constructor(schema, subscribe?, public readonly clock: Clock = i)
     ```

     A clock is a regular duration in the existing nanosecond unit system.
     Event time is separately the reserved datum field `time: bigint`, measured
     in Unix epoch seconds. Add one canonical timeframe-to-Clock conversion for
     positive minute strings and `[N]S`, `[N]D`, `[N]W`, `[N]M`; empty or
     unsupported values produce `i`. This conversion is the only interpretation
     of a concrete request timeframe in the Node API.

   - `TeaNode` retains only the minimum metadata needed beside its existing
     Observable: the effective clock and whether the bound schema is a direct
     Zod object with a bigint `time` field. When multiple streams form one Node
     datum, known clocks must agree; otherwise binding fails. When both records
     carry `time`, their times must match before fields combine.
   - Project source values through their existing Zod schema, retain required
     numeric series fields, and preserve `time` as metadata without adding it
     to `seriesNames` or `StepInput.series`. Scalar streams remain legal for a
     single series but cannot select event-time policy.

4. **Bind request streams by variable name and keep parameter changes independent** — `src/api/node.ts`, `src/api/tea.test.ts`
   - Replace recursive symbol collection/matching with `RequestSpec.name`.
     `node.bind({daily, weekly})` binds exactly those request children even if
     both manifests contain symbol `X`; remove symbol fan-out and root/request
     symbol collision behavior. Validate all keys before changing module
     markers or Observable ownership.
   - A concrete symbol change no longer clears a child stream: the assignment
     variable is stable binding identity. Timeframe changes update the
     manifest, and execution setup compares the newly expected request clock
     with the already bound child DataStream clock. A non-`i` mismatch is a
     synchronous `.to()` setup error; no implicit resampling occurs.
   - Retain direct `DataStream` binding for the current Node's remaining series
     and keyed root-series binding. A key matching both a direct series and a
     request name fails as ambiguous rather than mutating both.

5. **Build one recursive execution Observable and synchronize each request edge** — `src/api/node.ts`, `src/api/sync.ts`
   - Replace the request rejection in `.to()` with one private recursive
     execution path. Each Node creates exactly one `JSRuntime`; child Nodes step
     first and expose the captured value read immediately through
     `readResult(resultSlot, resultLayout)`. Only scalar child values cross the
     child Heap boundary. The child result retains its originating datum's
     optional event time without a named public transport type.
   - Fold child result Observables over the main `Datum` in rid order using
     `childOutput.pipe(sync(mainData, projector))`; each projector writes its
     result under `RequestSpec.name`. Before stepping, project those named
     fields back into the ABI's dense rid order. Because `sync` subscribes its
     buffered source before its target, every child graph is subscribed before
     the main source. A main datum may enter `sync`'s FIFO pending queue, but
     the parent runtime does not step until every edge projector emits.
   - Use these exact policies:

     | Request/policy    | Selection                                                         | Ready                                | Output                                                 | Consume                |
     | ----------------- | ----------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ | ---------------------- |
     | scalar one-to-one | every `security` edge                                             | at least 1 child                     | first `T`                                              | 1                      |
     | count window      | collect edge; main/child clocks non-`i`; `main % child === 0`     | at least `N = main / child` children | first `N` as `T[]`                                     | `N`                    |
     | event-time window | collect edge not using count; both schemas declare `time: bigint` | immediately for each main            | children with `previousMain < child.time <= main.time` | late + selected prefix |
     | array one-to-one  | remaining collect edge                                            | at least 1 child                     | `[first]`                                              | 1                      |

     Reject unsafe/zero ratios and ratios above `Number.MAX_SAFE_INTEGER` as
     setup errors. Event-time main values must increase; child values are
     nondecreasing. Values arriving with `child.time <= previousMain` after that
     main window emitted are late: consume and drop them silently. Retain
     buffered future values. The first event window has no lower bound and
     selects `child.time <= main.time`; an empty window emits `[]`.

   - Clarify finite lifecycle in `sync`: subscribe source before target; target
     completion discards unused source values; source errors fail immediately;
     once a completed source cannot satisfy the next pending target, complete
     the synchronized output rather than retaining an impossible wait. Child
     failure terminates the root Subject. Root unsubscribe/dispose tears down
     the entire graph and every runtime once; later sinks still subscribe only
     to future root results.

6. **Materialize collect batches inside the parent Heap transaction** — `src/runtime/state-machine.ts`, `src/runtime/state-update.ts`, `src/runtime/collections/array.ts`
   - Keep `StepInput.requests` as the existing `readonly Value[]`; a collect
     entry arrives as a frozen raw `readonly Value[]`, while its manifest mode
     disambiguates it from scalar input. Scalar-only capture and direct-name
     rules remove variable-length tuple ambiguity.
   - At the beginning of `RuntimeOperations.run()`, after opening the parent
     Heap transaction and before generated `main`, validate every raw element
     against `resultLayout`. For a collect edge call the existing collection
     runtime's `array.from` operation with `spec.layout`, producing the ordinary
     Heap-owned `ArrayValue` expected by generated Tea code. Scalar edges
     validate directly against `layout`.
   - Use the materialized request vector for `ctx.request`, root request
     history, and commit. A failed step aborts the new array allocation; a
     successful final step keeps it through ordinary State root discovery; a
     provisional result discarded by `JSRuntime` becomes unreachable and is
     reclaimed normally. Do not expose the parent Heap to Node or let a child
     `ArrayValue`/`Ref` cross runtimes.
   - Runtime tests must cover empty/single/multiple collect arrays, array
     methods in parent Tea code, request history retaining prior arrays,
     element-layout rejection, transaction abort, and Heap disposal.

7. **Keep other execution adapters fail-closed and replace the authority text** — `src/runtime/fixed-history.ts`, `docs/requests.md`, `docs/runtime.md`, `docs/ir.md`, owning `AGENTS.md`
   - Preserve fixed-history scalar `security` execution and provider context
     resolution. Read child results with `resultLayout`; require Sample mode
     before provider resolution and reject Collect with a precise unsupported
     error. GPU remains fail-closed for requests. No provider, axis, buffer, or
     Program enters public Node.
   - Make `docs/requests.md` the sole detailed Node policy authority. Document
     the four table rows above, policy precedence, clock/time units, window
     boundaries, FIFO waiting, late-drop rule, completion/error/cancellation,
     fixed scalar/array result shapes, variable-name binding, and the
     fixed-history separation. `docs/runtime.md` summarizes the recursive step
     flow and links to it; `docs/ir.md` documents direct declarations and the
     two request types. Remove claims that Node binds by symbol or cannot
     execute requests.
   - Update compiler/runtime/API authority files to forbid inline/function/
     nested requests and to keep policy as `sync` projectors rather than a
     policy object hierarchy. Provisional/final side channels, watermarks,
     resampling, and fixed-history collect execution remain explicitly staged.

## 4. Verification

- [x] `npm test -- src/checker/check.test.ts src/noder/noder.test.ts` proves the
      direct-name restriction, all rejected request placements, scalar-only child
      transport, and `security` `T` versus `security_lower_tf` `array<T>`.
- [x] `npm test -- src/codegen/request-evaluation-order.test.ts src/codegen/portability.test.ts src/api/js-module-binding.test.ts` proves Runtime ABI 7 emits stable request names, Sample/Collect mode, child/result layouts, and unchanged concretization/evaluation order.
- [x] `npm test -- src/api/sync.test.ts` proves source-before-target
      subscription, one-to-one and one-to-N waiting, FIFO pending targets,
      caller-controlled consumption, impossible-wait completion, error propagation,
      and cancellation.
- [x] `npm test -- src/api/tea.test.ts` proves request-variable binding, two
      same-symbol/different-clock streams, child-before-parent execution, scalar
      one-to-one, count window, event windows with empty/single/multiple results,
      silent late drops, array fallback, parameter/timeframe rebinding validation,
      late sinks, and whole-tree disposal.
- [x] `npm test -- src/runtime/js-runtime.test.ts src/runtime/state-update.test.ts src/runtime/aggregate-runtime.test.ts` proves raw collect batches become transaction-owned Tea arrays with correct layout, history, rollback, root tracing, and disposal.
- [x] `npm test -- src/runtime/fixed-history.test.ts src/runtime/fixed-history-integration.test.ts src/runtime/gpu/session.test.ts` proves scalar fixed-history behavior remains unchanged and Collect/GPU paths reject before performing unsupported provider/device work.
- [x] `npm run docs:check && npm run typecheck && npm test` proves generated
      references and authority docs are current, no old symbol-fanout/Node-request
      rejection text remains, and the complete standalone suite passes.
- [x] `npm run test:gpu` passes on a Dawn-capable Node 22 environment, or is
      recorded as environment-skipped only after the CPU/runtime/API gates pass;
      the ABI bump must not silently load an older embedded binding module.
