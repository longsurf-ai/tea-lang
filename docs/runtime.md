---
title: 'Runtime and public execution'
sidebarTitle: Runtime
---

Tea has one Program, one public CPU graph, and one target-specific GPU session.
The public Node/Recipe path owns CPU stream orchestration. The standalone
`tea/runtime` library also runs typed programs directly when a host already owns
synchronized steps. It imports neither the Tea frontend nor the Node API.

## Architecture

```text
Tea source
    │ compileToProgram()
    ▼
 Program
    ├─ generate TypeScript ─▶ tea/runtime ─▶ Node ─▶ Datum observer
    └─ lower WGSL ─▶ createGpuExecution(GpuBinding[]) ─▶ Datum callback
```

Applications own data acquisition. CSV files, WebSockets, arrays, databases,
and network APIs become DataStreams before Tea sees them. Request children are
ordinary named DataStream bindings. The GPU receives already materialized
numeric arrays.

## Public Node execution

`tea` creates one mutable Node owning one recursive `Module` tree.
Node owns:

- the RxJS input graph;
- one child Node per static request;
- one typed `Context` per Node;
- synchronization and copied request buffers;
- committed index progression;
- Pine contextual builtin delivery;
- lossless Datum publication and cancellation.

`Node.bind()` accepts only parameter objects and DataStreams. Parameter binding
updates the existing module; stream binding updates Node connections. Neither
subscribes. Binding is rejected after execution starts or disposal.

The first `Node.to(observer)` starts execution. Later observers share that same
run and receive only future Datums. Unsubscribing removes one observer;
`node.dispose()` stops the complete root and request-child graph.

```ts
const node = tea`
length = input.int(20)
emit "average" ta.sma(close, length)
`;

node.bind({length: 10});
node.bind(prices);
node.to(observer);
```

Each synchronized input produces one synchronous `Context.step()`. A thrown
observer `next()` callback fails the shared graph and reaches every observer
through `error()`.

## DataStream extent and time

A DataStream carries:

- an Arrow `Schema` describing its named fields;
- a cold or hot Observable;
- an optional regular Clock;
- optional finite `indices`.

`indices` is semantic metadata, not a resource limit. When present, Node checks
that the stream emits exactly that many values. The Pine Extension uses it for
`last_bar_index` and `barstate.islast`. A live stream leaves it null.

Declare event-time fields with Arrow's `TimestampMillisecond` type:

```ts
import {Field, Float64, Schema, TimestampMillisecond} from 'apache-arrow';
import {of} from 'rxjs';
import {DataStream} from 'tea';

const prices = new DataStream(
  new Schema([
    new Field('time', new TimestampMillisecond(), false),
    new Field('close', new Float64(), false),
  ]),
  of({time: -1n, close: 10}),
);
// One row: close = 10 at epoch millisecond -1.
```

Timestamp values may be numbers or bigints, but must fit an exact safe integer
number of epoch milliseconds. `Int64` fields remain supported for existing
bigint sources. Node checks event-time ordering before execution; time fields
remain event metadata and never occupy Tea numeric-series slots. An absent
nullable time field stays absent in the published row; an explicit null stays
null. The row's `timed` field records that distinction for Arrow serialization.

DataStream copies its schema at construction and returns defensive copies from
`schema`. Validation reads the declared Arrow types once per emission; custom
domain checks or conversions belong in ordinary RxJS operators upstream.

## Pine Extension

Pine is statically enabled while it is Tea's only Extension. It derives:

- `bar_index` from the Node's committed index;
- `last_bar_index` and `barstate.islast` from `DataStream.indices`;
- `time` from the current input datum;
- one fixed historical `timenow` value from the Node's host clock;
- historical bar-state flags from finite execution semantics.

Missing application symbol/timeframe metadata becomes the builtin's declared
empty Value. Contextual builtins never become another `Node.bind()` form.

## Compiled modules and binding

Runtime ABI 13 exposes one `Module<Context>` with mutable configuration. There is
no public manifest or separate preparation operation:

```text
module
  inputs
    schema             required application fields (Arrow Schema)
    series / builtins  history and fixed-context requirements
  parameters           declarations and bound values
  state
    frames             local empty Values, persistence, history and call sites
  outputs
    schema             sole owner of output names, types and write modes
  requests[]           each context/policy beside its child module
  bind                 the one parameter-binding operation
  main                 ordinary typed entry function
  clone                an independent configuration using the same code
```

`loadModule()` transpiles the generated TypeScript and constructs its `Module`.
The module constructor copies the ordinary Arrow schemas and keeps the binding
calculation function private. `module.bind()` validates a named patch,
preserves existing values, fills usable defaults only for still-unset parameters,
and recomputes dependent depths, parameter activity and request contexts. It updates
the existing module and returns that same object. Request-child module identities
also stay stable. A failed binding leaves the entire tree unchanged.

```ts
const module = tea`
length = input.int(20)
enabled = input.bool(true)
emit "price" enabled ? close[length] : close
`.module;

const same = module.bind({length: 20, enabled: false});
same === module; // true

module.bind({length: 40});
module.parameters[0].value; // 40; enabled remains false
module.inputs.series[0].depth; // {kind: 'const', bars: 40} for close[length]
```

No tagged assignment list or supplied-series markers are stored in the module.
`module.remaining()` reports parameters without usable defaults or supplied values.
`module.ready()` checks configuration only. `Node.bind(parameters)` delegates to
the module; `Node.bind(streams)` owns connections. `Node.ready()` additionally
checks every required root and child stream. The first `Node.to()` starts execution.

Input-source changes invalidate the Node's old connections, because they no longer
satisfy its requirements. Binding never subscribes, creates a frame, or allocates
Heap state. GPU preparation makes an independent module copy for each job, calls
its same `bind()` method, then checks physical arrays and plans device buffers.

Fixed contextual builtins can be supplied through the same bind operation:

```ts
// For a module whose builtin 0 is timeframe.multiplier:
module.bind({}, new Map([[0, 7]]));
module.bind({length: 6}); // the same context value 7 is retained
```

Only builtins marked constant accept these values. Each child owns its own context;
parent parameter changes propagate without replacing child context values. The
stored fixed value is also used during execution, including committed history.
Generated calculations clear late facts before evaluation. Missing parameters or
context leave configuration incomplete, never apparently ready with stale depths.
Errors in supplied values or calculated request policies fail binding immediately.

`node.module` returns the Node's existing module, without rebuilding or copying its
request tree. Configuration closes when execution starts: further `bind()` calls
fail. The runtime captures the configuration and Arrow metadata needed by that
execution once, so changing a caller-held metadata Map cannot change a running
program. Use `module.clone()` to configure an independent run while reusing the
compiled functions. The clone starts with the same parameter values; its next
`bind()` patch changes only that clone.

## Typed programs and captured values

The compiler emits ordinary TypeScript importing `tea/runtime`. Each program
supplies the four exact type arguments to `Context`: parameters, inputs, root
state and outputs. Functions are lexical TypeScript functions; written call sites
have named state under `frame.calls`.

Each generated state type directly declares its `locals` and `calls` properties.
These library types have separate responsibilities:

| Type                                      | Responsibility                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `Value<T, K>`                             | Captured value and Tea arithmetic; `K` preserves numeric kind or nominal identity |
| `Input<T, K>`                             | Read-only history through `.hist(offset)`                                         |
| `Series<T, K>`                            | One state binding, adding staged `.set()` and lazy initialization                 |
| `Frame`                                  | Static binding requirements and written call-site definitions                             |
| `Context<Params, Inputs, State, Outputs>` | One execution's values, storage and transaction lifecycle                         |
| `Module<Context>`                         | Schemas, storage requirements, binding calculations and `main()`                  |

A read captures the value before later assignments:

```ts
const before = ctx.state.locals.total.hist(0);
ctx.state.locals.total.set(before.add(float(1)));
// before still contains the previous number.
```

Arithmetic creates temporary values without history buffers. `int(7).div(int(2))`
contains 3; `int(7).div(float(2))` contains 3.5. Division by zero and numeric overflow
produce numeric NA. Boolean control flow remains ordinary TypeScript control flow,
so a skipped branch does not evaluate its operands.

Passing a captured value to a function preserves Tea value semantics. A parameter
that reads its own history is copied into a local Series belonging to that written
call site. It does not borrow the caller's history. A history-free parameter stays
an ordinary TypeScript local:

```ts
import {float, type Frame, type Series, type Value} from 'tea/runtime';

type Sum = {locals: {total: Series<number, 'float'>}; calls: {}};

function accumulate(frame: Sum, value: Value<number, 'float'>) {
  const total = frame.locals.total;
  total.init(() => float(0));
  total.set(total.hist(0).add(value));
  return total.hist(0);
}
```

The calls `accumulate(ctx.state.calls.close, close)` and
`accumulate(ctx.state.calls.open, open)` use separate `total` bindings. Their state
survives steps. Repeated execution of one written call inside a loop reuses that
call's state.

Generated persistent initialization uses a `needsInit()` guard followed by
`initialize(value)`. This keeps a Tea `return` inside an initializer in its
containing function; the handwritten `.init()` convenience remains lazy.

Struct captures keep their managed reference identity. Reading a field captures
its current value. A write captures and validates its receiver before evaluating
the right-hand side:

```ts
const field = point.require().field('x');
const replacement = calculate();
field.set(replacement);
```

`point.field('x').get()` on an NA struct returns the field's typed empty; `require()`
rejects an NA write before `calculate()` runs. Array, matrix and map mutators return
`{replacement, result}`. The caller stores that replacement in its Series or field;
a previously captured collection still has its old immutable header.

## Generated classes and generic values

Lowering uses TypeScript declarations directly. Each Tea enum becomes a string
enum; each nominal struct becomes a class with named, typed fields. A unique
symbol key gives the class nominal typing without emitting a field or using
JavaScript private slots:

```ts
const PointTag = Symbol('Point');
class Point {
  declare readonly [PointTag]: void;
  x: Value<number, 'float'> = float(NaN);

  constructor(fields?: Omit<Point, typeof PointTag>) {
    if (fields) Object.assign(this, fields);
  }
}
```

A managed allocation stores a class instance in the Context's Heap. Captured
struct values carry its `Ref<Point>` and constructor identity. Field operations
use the instance's named fields; they never convert a field name to a numeric
layout entry. Heap transaction views preserve the prototype and shared reference
identity while recording writes. The Heap's `TypeInfo` owns allocation,
reference tracing and logical-byte accounting.

Collections retain captured elements and an empty exemplar of their generic
argument. A read returns the stored Value directly, including its numeric kind
or managed reference. An empty collection therefore needs no element type ID:

```ts
const Integers = array(int(NaN));
const items = Integers.new(ctx, int(2));
items.get(int(0)); // Value<number, 'int'> containing NaN
```

`ArrayValue`, `MatrixValue` and `MapValue` are frozen header classes over
persistent Heap backing. Array and matrix elements, map keys and values, and
tuple members are captured Values. Mutations allocate replacement backing;
copying a collection does not deep-copy referenced structs. Bounds, ownership,
nominal identity and logical memory limits remain runtime checks.

`Color` is an immutable class with four byte fields (`r`, `g`, `b`, `a`), with
255 meaning opaque alpha. Color operators compare channel values; separately
constructed instances of the same color are equal. `Color.parse('#ff0000ff')`
and `new Color(255, 0, 0)` both format as `#FF0000`. Color parameter metadata
continues to use canonical hex strings; execution captures a Color. Publication
produces a detached `{r: 255, g: 0, b: 0, a: 255}` record matching its Arrow Struct.
NA remains null.

## Builds and handwritten TypeScript

`tea build indicator.tea -o indicator.ts` checks the emitted TypeScript before
writing it. The generated module contains its exact Context types, readable Arrow
schema constructors, storage requirements, binding calculations and ordinary functions.
Generated lexical parameters are prefixed so source names cannot shadow runtime helpers.
Execution JavaScript comes from transpiling that same source; there is no second
semantic emitter. Tagged `tea` templates use synchronous transpilation without
running the TypeScript checker on each template construction. Build and CI checks
cover emitted positive and negative typing cases.

The `examples/api/typed-runtime.ts` example shows a complete handwritten Module with parameter-bound history and two independent
accumulators. Run it from a checkout with:

```sh
npm run build:package
node examples/api/typed-runtime.ts
```

Its rows are derived from `close = 10, 20, 30` and `open = 1, 2, 3`:

| Index | Close sum | Open sum | Previous close (`lag = 1`) |
| ----- | --------: | -------: | -------------------------: |
| 0     |        10 |        1 |                        NaN |
| 1     |        30 |        3 |                         10 |
| 2     |        60 |        6 |                         20 |

The example uses `createNode(program.bind(...))`, `DataStream` and `.to(observer)`;
it adds no host loop. Handwritten code declares its retention and schemas explicitly.
TypeScript does not infer history requirements from a function body. Request-bearing
programs still use Node's child synchronization described in [Requests](requests.md).
Handwritten TypeScript is a CPU entry path; WGSL continues to consume the Tea Program.

## Context and transactions

`Context` owns committed state, same-index values, and one Heap.
`Step` keeps a sparse **write set** keyed by retained binding identity. A read
first checks that write set, then applies the binding's persistence and history
rules. Calls open lazily. Execution does not construct a parallel mutable copy
of the local/call tree.

Struct-field writes use Heap transaction views of the generated class instances.
Aliases observe the transaction's pending writes. These views and the local
write set participate in the same attempt; generated functions never own a
separate commit operation.

One step is transactional:

1. read committed history and same-index values;
2. call `main(context)` with read-your-writes access to local and Heap changes;
3. capture output values at each `.set()` or `.append()`;
4. validate and commit after `main()` returns normally;
5. abort state, Heap changes and buffered outputs if execution throws.

The wrapper owns the transaction, so an early return from a handwritten `main()` is a successful
step. Tea entry source simply falls through; source `return` belongs to functions.
Its `using` scope aborts any uncommitted Heap transaction on exit. Functions
called by `main()` participate in the same step; they do not commit independently.
`step()` returns a `StepResult` directly and throws on failure.

For example, after `total.set(int(12))`, `total.hist(0)` returns 12 within this
attempt. If a later operation throws, rollback drops that write and the buffered
outputs. No committed history has changed. Successful final execution prepares
new histories before the Heap commit, and Context adopts them only on success.
History advancement still visits retained calls; sparse writes eliminate the
working-tree copy, not the required history updates.

Provisional success replaces same-index values and commits its Heap transaction;
it does not advance committed binding/input history. Final success advances
history too. A failed step changes neither. Public Node remains final-only;
direct `Context.step()` preserves the runtime provisional, `var` and `varip`
semantics described in [Memory model](memory-model.md).

Heap allocation safeguards remain internal implementation checks. They are not
execution inputs or user configuration.

## Arrow schemas and published rows

Arrow owns the recursive I/O type system. Checked Tea types project once into
Arrow fields; generated TypeScript classes, enums and generic runtime operations
carry execution values. There is no runtime structural type table or separate
output declaration table. Using a schema does not require serializing or
allocating a RecordBatch at every step.

| Value           | Arrow type                                               |
| --------------- | -------------------------------------------------------- |
| Tea int / float | Float64, with `tea:type` distinguishing them             |
| bool / string   | Bool / Utf8                                              |
| color           | nullable Struct with non-null r/g/b/a Uint8 fields       |
| enum            | Utf8 with nominal identity and member metadata           |
| struct / tuple  | Struct with named / positional fields                    |
| array           | List of a typed child field                              |
| matrix          | Struct with rows, columns and a flat values List         |
| map             | Map with typed non-null keys, preserving insertion order |
| host binary     | Binary; this does not add binary operations to Tea       |
| event time      | TimestampMillisecond                                     |

Tea integers deliberately retain their current JavaScript number representation,
including finite arithmetic outside the safe-integer range and numeric `NaN`.
Arrow Int64 would change that contract. Numeric `NaN`, signed zero and empty lists remain distinct. An absent set emission
and an explicitly emitted null share the column's null value. Nominal IDs come from the
checker; metadata never re-encodes a recursive structural schema. Internal recursive
structs are valid, but unrepresentable recursive exports produce a compiler error.
Resource records contain kind/id and remain scoped to their producing runtime.

For this program (with `close` bound to 10):

```tea
emit "price" close
emit.append "fills" "buy"
```

Node publishes:

```ts
{
  index: 0,
  timed: false,
  provisional: false,
  price: 10,
  fills: ['buy'],
}
```

`module.outputs.schema` owns every named field in declaration order. Each field
records `tea:write` (`set` or `append`). Runtime snapshots walk these Arrow fields
and the captured value directly. Consumers use schema order, including
for integer-like column names whose JavaScript property enumeration order differs.

`price` is a nullable Arrow Float64 field. A skipped emission and an explicitly
emitted null both produce null; emitting numeric NA produces NaN. `fills` is a
non-null `List<Utf8>`; a step with no appends produces an empty list. Each list
retains its own emission order. There is no global event ordinal or payload wrapper.

Tea rejects duplicate set writers and repeated set execution at compilation.
The runtime also rejects duplicate sets from handwritten modules and aborts the
whole attempt. Set and append may not target the same column even when their
Arrow shapes match; the checker validates this language rule before projection.

Both paths snapshot aggregates **at emission**. Mutating a struct later in the same
step cannot change an earlier event. Published records, arrays and Maps contain
ordinary detached values; they remain usable after the next step or disposal.
Maps are standard JavaScript Maps suitable for Arrow builders, not Heap handles.

Index and provisional status accompany every row. Event time is optional; `timed`
is false when the time field is absent and true when present, including null.
This extra presence bit preserves that distinction when Arrow encodes both absent
and null nullable cells as null. Source time conversion remains exact.

Inspect the schema with Arrow itself:

```ts
const field = node.module.outputs.schema.fields.find(
  field => field.name === 'price',
);
console.log(field?.type.toString()); // Float64
```

Batch builders and Arrow IPC can consume these values later. The observer chooses
whether to retain data; the execution engine does not accumulate output batches.
GPU readback uses the same logical schemas and row shape for its supported subset.
Arrow schema support does not imply GPU support for every corresponding value.

## Batch Recipe

The Batch Recipe is the complete finite orchestration abstraction:

```ts
await batchRecipe(
  node,
  [parameters, rootStream, requestStreams],
  observer,
).execute();
```

It calls the public `bind()` and `to()` methods, waits for Node completion and
an observer's optional asynchronous `completion` Promise, counts Node-owned
indices, and always disposes the Node. It does not compile, resolve external
data, inspect compiled configuration, create runtimes, allocate storage, or synchronize
requests.

A sweep will be a separate Recipe that composes isolated Batch Recipes. Until
that Recipe exists, Tea exposes no parameter-grid layer.

## CLI run

`tea run` is one small application of the public path. It:

1. compiles one source file;
2. parses one finite CSV into a DataStream;
3. binds source-declared parameters;
4. invokes one Batch Recipe;
5. renders the resulting Datums.

Compilation and Recipe execution are measured with scoped `using` timers. The
CLI uses no source registry, backend union, or generic execution wrapper.

## GPU bindings and physical allocation

WGSL lowering produces one bind-independent `CompiledWgslProgram` at GPU ABI 9,
embedding its Runtime ABI 13 module. Set result cells carry separate presence and
value-validity words, so skipped outputs and numeric NA remain distinguishable.
Older runtime and GPU artifacts are rejected. The GPU
runtime accepts concrete bindings:

```ts
type GpuBinding = Readonly<{
  params: Readonly<Record<string, unknown>>;
  indices: number;
  series: Readonly<Record<string, readonly number[]>>;
  time?: readonly (number | null)[];
  declare?(outputs: Module['outputs']): void;
  next(datum: Datum): void;
}>;
```

The application materializes those arrays. The GPU runtime validates required
series and extents, packs fixed buffers, dispatches, reads back complete Datums,
and preserves caller order as binding identity.

Callers do not choose chunk length, effect capacity, or total GPU bytes.
Physical values are derived from:

- actual binding extents;
- artifact channel and maximum-effect counts;
- fixed ABI strides and u32/i32 bounds;
- `GPUDevice.limits.maxBufferSize`;
- `maxStorageBufferBindingSize`;
- workgroup and dispatch limits.

The runtime selects any workgroup-state staging solely from the artifact and
the device's hard workgroup-storage limit. It selects the largest chunk that
fits hard device buffer limits. Effect capacity is exactly
`chunkIndices × artifact.maxEffectsPerRow`. An allocation or device-limit
failure is an operational error, not a configurable policy.

`runChunk()` advances device-resident state; `runAll()` repeats it until every
binding completes. Decoding validates the entire current chunk before its first
Datum is delivered. A decode or callback failure makes the session terminal.
`dispose()` releases only session-created GPU resources; the injected device
remains application-owned.

## Determinism

Generated code contains no host I/O, randomness, or wall-clock access. A finite
run is determined by its module, parameter values, bound DataStreams, and the
Pine execution clock captured for that Node. GPU execution is determined by its
artifact and concrete bindings.

## Staged beyond this slice

- live provisional-input protocol and watermarks;
- dynamic or nested requests;
- Sweep and live Recipes;
- optional application source registries;
- broader GPU support for structs, resources, requests and non-scalar operations.
  Existing append codecs support literal strings and packed colors; that does not
  imply arbitrary string/color operations or user-defined struct execution.
