# Tea output intrinsic and Tea-authored plot library

Status: first `plot` delivery implemented on 2026-08-23 against `cfd0626`.
The generic output intrinsic, contextual argument object, full parameter
qualifier caps, caller-owned output-wrapper elaboration, flattened visual
prelude, and catalog-to-Tea `plot` migration are complete. The mechanical
`effect` -> `kind` manifest rename and migration of the remaining output family
remain follow-up phases in this plan.

This plan replaces catalog-native declarative rendering functions with
Tea-authored wrappers over one compiler intrinsic:

```tea
output(value, kind="plot", args={title: title, color: color})
```

The first delivery migrates `plot`. The infrastructure must be general enough
to migrate `plotshape`, `plotchar`, `bgcolor`, `barcolor`, `alertcondition`,
`hline`, and `fill` without adding another output-specific compiler path.

The current `Program.outputs`, `EmitStmt`, generated-module manifest, and
runtime publication model remain the backend contract during the first
delivery. Frontend changes must lower into that contract rather than create a
parallel output IR or runtime protocol.

## 1. Objective

After this change, the source/compiler boundary is:

```text
plot(...)                         ordinary Tea function resolution
    -> output(value, kind, args)  sole output-declaration intrinsic
    -> OutputDecl + EmitStmt      existing Program representation
    -> JS/WGSL module manifest    existing backend path
    -> OutputSink                 existing runtime publication path
```

The source spelling supports both an ignored result and a declaration
reference:

```tea
plot(close, "Close", color=color.blue, linewidth=2)

pricePlot = plot(close, "Close")
```

The compiler-shipped implementation is ordinary Tea source:

```tea
library("visual")

export plot(
    series,
    const string title = "",
    series color color = na,
    input int linewidth = 1,
    const string style = "line"
) =>
    output(
        series,
        kind="plot",
        args={
            title: title,
            color: color,
            linewidth: linewidth,
            style: style
        }
    )
```

Only `output` remains a catalog intrinsic. The catalog does not own the
`plot` parameter list, defaults, or implementation.

For reference-producing kinds, `output(...)` returns the existing compile-time
declaration reference. Consequently Tea-authored `plot(...)` returns
`PlotType`, and Tea-authored `hline(...)` returns `HlineType`:

```tea
fast = plot(fastEma, "Fast")
slow = plot(slowEma, "Slow")
fill(fast, slow, color=color.blue)
```

Other visual wrappers such as `plotshape` continue to return `void`.

## 2. Non-negotiable boundaries

- Keep one canonical frontend and one canonical `Program`.
- Keep `Program.outputs` as the explicit complete dense-output declaration
  inventory. Backends and runtimes must not rediscover declarations by walking
  function bodies.
- Keep sparse `effect.emit` and `Program.effects` separate. `output` declares
  dense output; it is not a replacement for sparse effects.
- Keep `indicator()` and `strategy()` as script declarations. Migrating those
  headers is outside this plan.
- `plot` must be a real compiler-shipped Tea function checked through the
  ordinary loader/checker pipeline. Do not synthesize a second hidden native
  `plot` signature.
- Preserve the existing `PlotType`, `HlineType`, `OutputRefExpr`, and
  assignment-based declaration-reference behavior. These are compile-time
  declaration handles, not runtime Heap references.
- Each written call of an output-declaring wrapper owns a distinct
  `OutputDecl`. Two calls of the same function specialization must never share
  an output declaration.
- Output declarations remain statically enumerable and unconditional. A loop,
  conditional branch, request capture, persistent initializer, or bind-time
  expression cannot dynamically change the declaration set.
- Preserve source evaluation order and exactly-once evaluation for positional,
  named, and omitted-default arguments.
- Do not make output titles, output kinds, source order, or runtime output ids
  into durable cross-version user identity as part of this change.
- Keep the repository clean-room and standalone. The visual library and every
  new contract are Tea-owned and use relative internal imports.

## 3. Audited baseline

### 3.1 Current source/checker ownership

- `plot`, `hline`, `plotshape`, `plotchar`, `bgcolor`, `barcolor`,
  `alertcondition`, and `fill` are catalog-native functions with
  `Effect.Output` in `src/checker/catalog.ts`.
- `plot` is not a scanner/parser keyword. It is special because its resolved
  native call carries `Effect.Output`.
- `checkPlacement` permits output natives only at script top level.
- Native output parameter definitions currently own type constraints,
  qualifier caps, defaults, and argument names.
- Source-written parameter qualifier caps currently expose only `simple` and
  `series`; Tea source cannot express the current native `const` and `input`
  caps used by `plot` metadata.

### 3.2 Current noder/Program ownership

- `nodeOutputCall` and `partitionOutput` project one native call into one
  `OutputDecl` and optional `EmitStmt`.
- Constants enter `staticArgs`; output references and values known no later
  than input enter `bindArgs`; later values become per-row channels.
- `OutputDecl.effect` currently holds the native function name.
- The current native surface permits `p = plot(...)` and binds the name through
  `OutputRefExpr`. Tea-authored `plot` must preserve this behavior exactly.
- `FunctionInstance` is memoized by type-and-qualifier signature, and noder
  projects one shared `IrFunc` per instance per Program. This is correct for
  computation but cannot by itself give two callers distinct declarations for
  the one `output()` syntax node inside `visual.plot`.

### 3.3 Current syntax/library ownership

- Tea has tuple literals but no `{name: value}` expression.
- Compiler-shipped libraries are real `library("...")` packages.
- `ta` is implicit but namespaced (`ta.ema`). There is no current mechanism
  that flattens a library's exports into the script universe so `plot(...)`
  remains unqualified.

### 3.4 Current backend ownership

- JS and WGSL consume `Program.outputs` and `EmitStmt`.
- The generated manifest publishes output kind through the field currently
  named `effect`, plus static args and named channels.
- Runtime publication uses numeric `outputId` and ordered channel values.
- Sinks and reporting use declaration order as compiled identity and titles
  only as presentation labels.

## 4. Chosen source semantics

### 4.1 `output` signature

The source contract is:

```tea
output(value, kind=<const string>, args={<name>: <expression>, ...})
```

Rules:

1. `value` is required and follows the existing qualifier partition: folded
   constants become static args, at-most-input values become bind args, and
   later values become the primary dense channel. The canonical primary name
   is `series` for `kind="plot"` and `value` for generic kinds.
2. `kind` is required, must fold to a non-empty string, and becomes the output
   declaration kind.
3. `args` is required in the first implementation; `{}` is valid.
4. Argument-object field names are unique and preserve source order.
5. Each argument-object field is classified independently:
   - folded constant -> `staticArgs`;
   - output declaration reference or at-most-input value -> `bindArgs`;
   - simple/series value -> additional per-row channel.
6. Nested argument objects, spreads, computed keys, and shorthand fields are
   outside the first implementation.
7. The argument object is compiler metadata, not a runtime aggregate value.

The first implementation treats `{name: expression}` as a contextual
output-argument object. It is not assignable, returnable, storable,
history-readable, or accepted by ordinary functions:

```tea
args = {title: "Close"} // checker error in V1
```

This prevents the plotting migration from implicitly adding general
structural-record value semantics and physical layouts.

### 4.2 Result and declaration references

The folded `kind` selects the intrinsic's result type:

```text
kind="plot"  -> PlotType,  const-qualified OutputRefExpr
kind="hline" -> HlineType, const-qualified OutputRefExpr
other kinds  -> VoidType,  no source value
```

This preserves the current Tea contract rather than introducing a parallel
generic reference system. `PlotType` and `HlineType` remain special
non-annotatable compiler types. Their expressions point directly to the
caller-owned `OutputDecl`.

The references:

- do not contain the plotted numeric values;
- are not Heap `StorageRef`s or runtime drawing handles;
- never require a Ring, history depth, or per-row publication;
- are lowered to the declaration's numeric `outputId` when a bind-time
  consumer such as `fill` needs them;
- cannot vary across bars or be reassigned to a different declaration.

`fill` retains its two overload families:

```text
fill(PlotType, PlotType, ...) -> void
fill(HlineType, HlineType, ...) -> void
```

Mixing one plot and one hline reference remains a checker error.

### 4.3 Output-declaring Tea functions

An ordinary Tea function is inferred to be an output wrapper when its body is
a direct tail call to `output`:

```tea
export plot(...) => output(...)
```

V1 output wrappers:

- may use parameters, checked defaults, and constants as the primary value,
  kind, or argument-object field values;
- may not contain local statements, mutation, control flow, requests,
  persistent state, sparse effects, or more than one output call;
- are checked as ordinary Tea function templates and retain ordinary overload
  alignment/default checking;
- are elaborated at the caller rather than lowered as a runtime `CallFunc`.

The restriction is deliberate. It lands the compiler-shipped visual wrappers
without pretending the current IR can safely host arbitrary declaration
effects inside shared runtime functions. General multi-output/effectful Tea
functions require a separate call-path/statement-effect design.

### 4.4 Call-site ownership

For:

```tea
a = plot(close, "Close")
b = plot(open, "Open")
```

the checker may reuse one `FunctionInstance` for the common signature, but the
noder elaborates two caller-owned output sites:

```text
caller plot CallExpr 0 -> OutputDecl 0 -> OutputRefExpr 0
caller plot CallExpr 1 -> OutputDecl 1 -> OutputRefExpr 1
```

The output declaration's diagnostic position is the caller's `plot(...)`
position, not the `output(...)` position inside `visual.tea`.

The noder deduplication key is the caller `CallExpr`. It must never use the
library body's `output()` syntax node as Program identity.

### 4.5 Placement

Allowed:

```tea
plot(close)
p = plot(close)
output(close, kind="metric", args={title: "Close"})
```

Rejected:

```tea
if close > open
    plot(close)

for i = 0 to 3
    plot(close)

request.security("X", "D", plot(close))
```

Placement checks follow the transitive function call. A direct `output()`
inside `visual.plot` is legal; invoking `visual.plot` from an illegal caller
context is not.

### 4.6 Source-level qualifier caps

Extend function parameter annotations to admit the full existing qualifier
ordering in parameter position:

```tea
const string title
input int linewidth
simple string label
series color color
```

This is a parameter-cap surface only. `const` at declaration start remains a
persistence/declaration mode.

The checker continues to compare the caller's actual qualifier against the
written cap. Parameters retain the caller's actual qualifier inside a concrete
function instance, so output argument classification remains precise:

```text
literal title       -> const static arg
input-backed width  -> input bind arg
series color        -> row channel
```

`plot` keeps its primary `series` parameter unannotated so int and float
channels preserve their checked types. The `output` kind contract validates at
the caller that `kind="plot"` receives a numeric primary; this is semantic
validation of the declared output kind, not a compiler branch on the wrapper
function's source spelling.

## 5. Semantic contracts

### 5.1 Syntax facts

Add:

```ts
NodeKind.ArgumentObjectExpr;
NodeKind.ArgumentObjectField;
```

Suggested shape:

```ts
interface ArgumentObjectExpr extends Node {
  readonly kind: typeof NodeKind.ArgumentObjectExpr;
  readonly fields: readonly ArgumentObjectField[];
}

interface ArgumentObjectField extends Node {
  readonly kind: typeof NodeKind.ArgumentObjectField;
  readonly name: Name;
  readonly value: Expr;
}
```

The syntax tree records only what was written. It does not call the object an
output object; contextual admission belongs to the checker.

### 5.2 Checker facts

Add one discriminated resolution:

```ts
CallKind.Output;

interface OutputArgument {
  readonly name: string;
  readonly value: CheckedExpression;
}

interface OutputCall {
  readonly kind: typeof CallKind.Output;
  readonly outputKind: string;
  readonly value: CheckedExpression;
  readonly args: readonly OutputArgument[];
  readonly resultType: Type;
}
```

The checker derives `resultType` from the folded kind: `PlotType` for `plot`,
`HlineType` for `hline`, and `VoidType` for non-reference-producing output
kinds. Reference-producing results are const-qualified and lower through the
existing `OutputRefExpr` path.

`CallResolution` becomes:

```text
NativeCall | FunctionCall | ConstructorCall | RequestCall | OutputCall
```

An output wrapper owns an immutable semantic template:

```ts
interface OutputTemplate {
  readonly call: OutputCall;
  readonly parameterUses: readonly OutputTemplateParameterUse[];
}
```

The exact representation may use canonical parameter identities rather than
indices, but it must retain:

- the primary value source;
- the folded kind;
- source-ordered argument fields;
- parameter/default/constant provenance;
- the wrapper body `Info`;
- enough information to instantiate each operand at the caller without
  re-checking syntax.

`FunctionInstance` owns `outputTemplate: OutputTemplate | null`. This is a
semantic fact about that checked instance, not a Program or noder object.

### 5.3 Program facts

Keep `OutputDecl` and `EmitStmt`, with these vocabulary changes:

```ts
interface OutputDecl {
  readonly kind: string;
  readonly sourcePosition: Pos;
  readonly staticArgs: ...;
  readonly bindArgs: ...;
  readonly bindArgumentEvaluationOrder: readonly number[];
  readonly channels: readonly {name: string; type: Type}[];
}
```

- Rename `OutputDecl.effect` to `kind` in the same implementation once the new
  frontend tests pass.
- Add `sourcePosition` because a wrapper's declaration identity and diagnostics
  belong to the caller.
- Retain object identity and Program order as the current compiled identity.
- Do not add a durable visual key in this change.

The runtime `OutputSpec.effect` field is renamed to `kind` in the corresponding
mechanical ABI update. The runtime ABI is pre-release and evolves in place; no
compatibility branch is added.

## 6. Implementation sequence

### Phase 0: Lock the contract with failing tests

Add focused tests before implementation:

- parser shape for empty and populated argument objects;
- parser recovery for missing colon/value/brace;
- checker rejection outside `output`;
- checker rejection for duplicate fields and dynamic `kind`;
- direct top-level `output` partitioning;
- two calls to one output wrapper produce two declarations;
- wrapper invocation placement errors are anchored at the caller;
- named caller arguments preserve exactly-once source order;
- `p = plot(...)` and `h = hline(...)` bind directly to their caller-owned
  declarations;
- non-reference-producing output wrappers remain void in value position;
- `fill` accepts two plot refs or two hline refs and rejects mixed kinds;
- ordinary non-output functions remain shared by signature.

### Phase 1: Add contextual argument-object syntax

Files:

- `src/syntax/tokens.ts`
- `src/syntax/scanner.ts`
- `src/syntax/nodes.ts`
- `src/syntax/parser.ts`
- `src/syntax/dumper.ts`
- syntax traversal/testing helpers
- `src/syntax/{scanner,parser,indent}.test.ts`
- `editors/vscode/scripts/generate-syntax.ts`
- editor syntax tests and generated grammar

Work:

1. Add `{` and `}` tokens and include them in scanner grouping-depth logic.
2. Parse `{name: expr, ...}` in primary-expression position.
3. Preserve field order and leftmost positions.
4. Add exhaustive traversal/dumper cases.
5. Keep empty objects legal and trailing-comma policy consistent with calls and
   tuples.

Exit gate:

- syntax tests and editor grammar checks pass;
- no semantic meaning has yet been assigned outside checker tests.

### Phase 2: Add full parameter qualifier caps

Files:

- `src/ir/type.ts`
- `src/syntax/parser.ts`
- `src/checker/check.ts`
- checker function/interface tests
- docs/reference generation and editor grammar

Work:

1. Admit `const`, `input`, `simple`, and `series` as function-parameter caps.
2. Keep declaration-leading `const` behavior unchanged.
3. Validate actual qualifier <= declared cap for ordinary and library
   functions.
4. Preserve the actual qualifier on the instantiated parameter object.
5. Add diagnostics for misplaced qualifier tokens.

Exit gate:

- ordinary Tea functions can express the metadata contracts required by
  `plot` without a catalog sidecar.

### Phase 3: Add the `output` intrinsic and semantic resolution

Files:

- `src/checker/catalog.ts`
- `src/checker/info.ts`
- `src/checker/check.ts`
- `src/checker/effects.test.ts` or a new `output.test.ts`
- `src/ir/type.ts`
- `src/checker/type-catalog.ts`

Work:

1. Add only `output` as `Effect.Output` in the catalog.
2. Resolve it through a dedicated `checkOutput` path before ordinary overload
   matching tries to type the contextual argument object as a runtime value.
3. Validate value, folded kind, argument object, field uniqueness, supported
   field value types, and placement.
4. Publish exactly one `OutputCall` in the active `Info`.
5. Map reference-producing kinds to the existing `PlotType`/`HlineType` and
   every other kind to `VoidType`.
6. Generalize transitive effect inspection so a `FunctionCall` can be known to
   declare output.

Exit gate:

- direct top-level `output(...)` checks successfully;
- invalid uses fail in the checker and never reach noder.

### Phase 4: Add output-wrapper inference and caller placement

Files:

- `src/checker/object.ts`
- `src/checker/info.ts`
- `src/checker/check.ts`
- library/function boundary tests

Work:

1. When instantiating a function, recognize the direct-tail-output body shape.
2. Record `OutputTemplate` on the `FunctionInstance`.
3. Permit `output` while checking that wrapper body.
4. Reject output in every other function-body shape in V1.
5. Apply placement restrictions at every caller of an output wrapper.
6. Propagate the output-declaration effect transitively through wrapper calls
   only if a later phase deliberately permits wrapper-to-wrapper composition.
   Direct wrappers are sufficient for the first plot migration.

Exit gate:

- wrapper source checks through the ordinary package/function pipeline;
- illegal caller contexts report at caller positions.

### Phase 5: Elaborate output wrappers per caller in the noder

Files:

- `src/noder/noder.ts`
- `src/noder/AGENTS.md`
- `src/noder/noder.test.ts`
- `src/ir/program.ts`
- `src/ir/node.ts`
- `src/ir/dumper.ts`
- `src/ir/visit.ts`

Work:

1. Add `nodeOutput` for direct `OutputCall` facts.
2. Add `nodeOutputTemplate` for caller-specific function elaboration.
3. Align actual arguments/defaults using the existing `FunctionCall` facts.
4. Preserve caller argument evaluation order while assembling canonical
   primary and argument-field positions.
5. Create one fresh `OutputDecl` per caller `CallExpr` and dedupe repeat noding
   of that same call only.
6. Return the existing `OutputRefExpr` for `plot`/`hline` output wrappers;
   non-reference-producing wrappers remain statement-only and produce no
   runtime return value.
7. Partition the primary value and argument fields into the existing static,
   bind, and row-channel representation. A row-varying primary value is channel
   zero, named `series` for plot and `value` for generic kinds.
8. Preserve `p = plot(...)`/`h = hline(...)` direct reference binding so no
   runtime `Name` is allocated; reject void output wrappers in value position.
9. Rename Program output vocabulary from `effect` to `kind` and add caller
   source position.

Exactly-once rule:

- Noder must instantiate parameter operands from canonical checked facts, not
  naïvely splice and recursively node the same actual syntax more than once.
- V1 rejects an output template that consumes one parameter in more than one
  output position unless the implementation introduces one caller-owned
  capture Name and preserves its source evaluation position.

Exit gate:

- two same-signature wrapper calls create distinct declarations and refs;
- named argument side effects occur exactly once in source order;
- non-output functions retain current shared `IrFunc` behavior.

### Phase 6: Add the compiler-shipped visual library

Files:

- `src/tea-lib/visual.tea`
- new focused visual-library tests
- `src/loader/loader.ts`
- `src/loader/loader.test.ts`
- `src/checker/check.ts`
- package/library tests

Work:

1. Add `visual` to the compiler-shipped registry.
2. Add a distinct flattened-prelude exposure list; do not change namespaced
   `ta` semantics.
3. Elaborate and declaration-check `visual` through the ordinary importer and
   checker.
4. Insert each exported visual prelude object into the universe by its
   canonical library-owned identity.
5. Reject collisions among native roots, flattened prelude exports, and user
   declarations deterministically.
6. Implement Tea-authored `plot` with the current public defaults and argument
   names, subject to the intentional numeric normalization described above.
7. First test it as `visual.plot`; enable flattened `plot(...)` only after the
   explicit form passes checker/noder/runtime parity.

Exit gate:

- `plot` resolves as `CallKind.Function`, not `CallKind.Native`;
- its body resolves `output` as `CallKind.Output`;
- the resulting Program matches the output declaration contract.

### Phase 7: Remove catalog-native `plot`

Files:

- `src/checker/catalog.ts`
- checker catalog/reference tests
- noder and IR goldens
- examples and execution fixtures only where expected Program text changes

Work:

1. Remove native `plot` overloads and their `Effect.Output` classification.
2. Keep native `fill` temporarily and prove that Tea-authored `plot` returns
   the same `PlotType`/`OutputRefExpr` contract it already consumes.
3. Keep only the Tea prelude export under the unqualified `plot` name.
4. Update diagnostics to name the Tea function at the caller while preserving
   precise intrinsic diagnostics for malformed `output` inside compiler-owned
   source.
5. Verify no parser, checker, noder, codegen, or runtime branch recognizes the
   source spelling `plot`.

Exit gate:

```text
rg for plot-specific compiler branches -> no semantic special case
all examples compile
JS output behavior matches
WGSL eligibility remains unchanged or fails only for pre-existing reasons
```

### Phase 8: Update backend/runtime vocabulary

Files:

- `src/codegen/codegen.ts`
- `src/codegen/lower.ts`
- `src/codegen/wgsl/*`
- `src/runtime/module-abi.ts`
- output sinks/reporting/trajectory code
- `src/api/binding.ts`
- runtime and GPU tests

Work:

1. Rename manifest `OutputSpec.effect` to `kind`.
2. Preserve the kind-owned primary channel name (`series` for plot, `value`
   generically) and additional dynamic argument field names.
3. Keep numeric `outputId` as compiled runtime identity.
4. Update binding extraction to use `OutputDecl.kind` while retaining its
   `[inputs, outputs]` result.
5. Update sinks to use kind only as presentation metadata, never durable
   identity.

Exit gate:

- generated JS and WGSL manifests agree with runtime validation;
- dense emissions retain output id/channel cardinality invariants.

### Phase 9: Migrate the remaining output family

Migration order:

1. `plotshape`, `plotchar`, `bgcolor`, `barcolor`, `alertcondition`;
2. `hline` using declaration-only output support;
3. `fill` using the preserved plot/hline declaration-reference types;
4. remove every remaining source-facing native `Effect.Output` entry except
   `output`.

Before `hline`, extend `output` with an explicit declaration-only overload
rather than inventing a dummy primary value:

```tea
output(kind="hline", args={price: price, ...})
```

This overload still creates an `OutputDecl` but no primary row channel.

Tea-authored `hline` returns the resulting `HlineType` reference. Before
migrating `fill`, add Tea source parameter support for the existing
non-annotatable plot/hline reference types or a narrowly equivalent generic
constraint. The wrapper must preserve the current two-overload rule: both
references are plots or both are hlines. Its output call returns void, and its
two declaration references enter `bindArgs`, never row channels.

## 7. Verification matrix

### Syntax

- Empty, single-field, and multiline argument objects.
- Nested calls and conditional expressions as field values.
- Duplicate fields, missing colon, missing value, missing brace, bad comma.
- Braces participate in line continuation/group-depth rules.
- Editor grammar and syntax vocabulary stay generated from current sources.

### Checker

- `output` value/kind/args contract.
- Kind folding and empty-string rejection.
- Contextual object rejected everywhere else.
- Per-field type and qualifier facts.
- Full const/input/simple/series parameter caps.
- Output wrapper recognition and rejection of non-transparent bodies.
- Caller-owned top-level placement, including transitive negative cases.
- `plot`/`hline` reference result types and void results for other kinds.
- Same-kind `fill` acceptance and mixed-kind rejection.
- `plot` is a `FunctionCall`; `output` is an `OutputCall`.

### Noder/IR

- Primary value is channel zero.
- Constant, bind, and channel fields partition correctly.
- Source evaluation order survives canonical field storage.
- Two caller sites produce two `OutputDecl` object identities.
- Caller positions survive into Program diagnostics/dumps.
- `p = plot(...)` binds directly to one `OutputDecl` with no runtime Name.
- Ordinary function instantiations remain shared.
- Direct `output` and Tea-wrapped `plot` produce equivalent Programs modulo
  caller position and the planned `value` channel rename.

### Codegen/runtime

- JS manifest declaration and per-row emission.
- Bind-argument failure order.
- Plot/hline references lower to the existing output ids for `fill`.
- WGSL result-cell mapping and output schema validation.
- CPU/GPU channel count/type parity.
- Sink declaration/publication validation.
- Binding extraction returns the new output names/types.

### Repository-wide

- Rebuild IR/token/AST goldens deliberately; no blind golden rewrite.
- Compile every example and every execution-conformance source.
- Regenerate checker-owned reference docs so `plot` is sourced from the visual
  prelude inventory rather than `CATALOG.funcs`.
- Extend the reference-doc workflow to inventory flattened prelude exports.
- Update `docs/ir.md`, runtime manifest documentation, language reference,
  visual examples, and owning `AGENTS.md` files.

Commands:

```text
npm run typecheck
npm test -- src/syntax
npm test -- src/checker
npm test -- src/noder
npm test -- src/codegen
npm test -- src/runtime
npm test
npm run docs:check
git diff --check
```

## 8. Delivery slices

Keep commits reviewable and independently green:

1. `syntax: add contextual argument-object literals`
2. `checker: expose full function parameter qualifier caps`
3. `checker: add generic output call resolution and reference results`
4. `checker: infer direct output wrappers and caller placement`
5. `noder: elaborate output wrappers per caller`
6. `tea-lib: add visual plot wrapper`
7. `refactor: remove catalog-native plot`
8. `refactor: rename output effect metadata to kind`
9. `docs: publish output intrinsic and Tea-authored plot`

Do not combine the syntax feature, call-site elaboration, library migration,
and backend vocabulary rename into one unreviewable patch.

## 9. Explicitly deferred work

- General first-class structural records.
- Arbitrary output declarations inside multi-statement functions.
- Conditional or loop-created output declarations.
- Runtime-dynamic output kinds.
- Multiple primary values; use additional named dynamic args until separately
  designed.
- Durable visual identity across source revisions.
- Renderer plugin registration or UI configuration for previously unknown
  output kinds.
- Migrating script declarations (`indicator`, `strategy`) to `output`.
- Replacing sparse `effect.emit`.

## 10. Definition of done

- `plot` has no native catalog entry and no spelling-based compiler branch.
- `plot` is loaded from compiler-shipped Tea source and resolves as an
  ordinary function.
- `output` is the sole primitive that declares dense outputs.
- Every written `plot`/output-wrapper call owns a distinct `OutputDecl`.
- Direct output and wrapper calls preserve exactly-once source evaluation.
- `plot(...)` and `hline(...)` return their existing compile-time declaration
  references; non-reference-producing output kinds return void.
- `fill(...)` consumes two same-kind declaration references and returns void.
- The Program remains the sole backend contract; JS and WGSL consume the same
  output declarations.
- Existing plot-reference and fill examples and execution fixtures compile and
  run without changing their source-level relationship model.
- Focused, repository-wide, documentation, editor, and standalone checks pass.
- The worktree contains no unrelated edits in the resulting commits.
