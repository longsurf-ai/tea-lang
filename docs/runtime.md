---
title: 'Runtime and public execution'
sidebarTitle: Runtime
---

Tea has one Program, one public CPU graph, and one target-specific GPU session.
The public Node/Recipe path is the only CPU orchestration path.

## Architecture

```text
Tea source
    │ compileToProgram()
    ▼
 Program
    ├─ generate JS ─▶ Node.bind(DataStream) ─▶ Batch Recipe ─▶ Datum observer
    └─ lower WGSL ─▶ createGpuExecution(GpuBinding[]) ─▶ Datum sink
```

Applications own data acquisition. CSV files, WebSockets, arrays, databases,
and network APIs become DataStreams before Tea sees them. Request children are
ordinary named DataStream bindings. The GPU receives already materialized
numeric arrays.

## Public Node execution

`tea` creates one mutable Node over one immutable recursive `JSModule` tree.
Node owns:

- the RxJS input graph;
- one child Node per static request;
- one `JSRuntime` per Node context;
- synchronization and copied request buffers;
- committed index progression;
- Pine contextual builtin delivery;
- lossless Datum publication and cancellation.

`Node.bind()` accepts only parameter objects and DataStreams. Binding replaces
the immutable module snapshot but never subscribes. Binding is rejected after
execution starts or disposal.

The first `Node.to(observer)` starts execution. Later observers share that same
run and receive only future Datums. Unsubscribing removes one observer;
`node.dispose()` stops the complete root and request-child graph.

```ts
const node = tea`
length = input.int(20)
plot(ta.sma(close, length))
`;

node.bind({length: 10});
node.bind(prices);
node.to(observer);
```

Each synchronized input produces one synchronous `JSRuntime.step()`. A thrown
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
    new Field('time_close', new TimestampMillisecond(), false),
    new Field('close', new Float64(), false),
  ]),
  of({time: -1n, time_close: 0n, close: 10}),
);
// One row: close = 10 over the interval [-1, 0) epoch milliseconds.
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
- `time` and `time_close` from the current input datum;
- one fixed historical `timenow` value from the Node's host clock;
- historical bar-state flags from finite execution semantics.

Missing application symbol/timeframe metadata becomes the builtin layout's
typed empty value. Contextual builtins never become another `Node.bind()` form.

## Generated JavaScript module

The JS backend emits one recursive Runtime-ABI-8 module tree. Every root and
request child has the same code, manifest, layout table, request children, and
direct `concretize()` function.

Raw generated artifacts carry standard Arrow schema-only IPC bytes. Loading restores
real `Schema`, `Field`, and `DataType` instances. `module.inputs` describes the
required named series; `module.outputs` describes the complete published row.

Binding copies ordinary manifest data and copies Arrow schemas through Arrow APIs,
writes parameter values or series-supplied markers, and runs direct `concretize()`.
It returns a new module snapshot. Node and JSRuntime capture private schemas;
`node.module` and schema getters expose independent metadata Maps. Neither
`structuredClone` nor `Object.freeze(Map)` would provide that boundary.
Generated code never stores Observables, DataStreams, live State, or Heap values.

`JSModule.ready()` and `remaining()` derive their answers from the manifest;
there is no parallel binding result or parameter vector.

## JSRuntime state and transactions

`JSRuntime` owns one committed State, one same-index Intermediate, and one Heap.
The manifest's frame and history depths determine fixed runtime arrays directly.
No workspace preflight, state-storage lease, or duplicated fixed-byte budget is
needed.

One step is transactional:

1. read committed State and current Intermediate;
2. evaluate generated code against tentative frame and Heap changes;
3. snapshot outputs and effects;
4. commit State and Heap together on success;
5. discard every tentative change on failure.

Provisional success replaces Intermediate and commits its Heap transaction; it does
not advance committed binding/input history. Final success replaces State and
Intermediate. A failed step changes neither and aborts the Heap transaction. Detailed assignment, reference, collection, and history
semantics live in [Memory model](memory-model.md).

Heap allocation safeguards remain internal implementation checks. They are not
execution inputs or user configuration.

## Arrow schemas and published rows

Arrow owns the recursive I/O type system. Tea's compiler types and execution
state descriptors retain their separate roles. There is no second output/event
payload type language, and using an Arrow schema does not require serializing or
allocating a RecordBatch at every step.

| Value                 | Arrow type                                               |
| --------------------- | -------------------------------------------------------- |
| Tea int / float       | Float64, with `tea:type` distinguishing them             |
| bool / string / color | Bool / Utf8 / Utf8 with color metadata                   |
| enum                  | Utf8 with nominal identity and member metadata           |
| struct / tuple        | Struct with named / positional fields                    |
| array                 | List of a typed child field                              |
| matrix                | Struct with rows, columns and a flat values List         |
| map                   | Map with typed non-null keys, preserving insertion order |
| host binary           | Binary; this does not add binary operations to Tea       |
| event time            | TimestampMillisecond                                     |

Tea integers deliberately retain their current JavaScript number representation,
including finite arithmetic outside the safe-integer range and numeric `NaN`.
Arrow Int64 would change that contract. Numeric `NaN`, signed zero, empty lists,
null references and absent emissions remain distinct. Nominal IDs come from the
checker; metadata never re-encodes a recursive structural schema. Internal recursive
structs are valid, but unrepresentable recursive exports produce a compiler error.
Resource records contain kind/id and remain scoped to their producing runtime.

For this program (with `close` bound to 10):

```tea
plot(close)
effect.emit("buy")
```

Node publishes:

```ts
{
  index: 0,
  timed: false,
  provisional: false,
  output0: {series: 10},
  effect0: [{ordinal: 0, payload: 'buy'}],
}
```

`output0` has Arrow type `Struct<series: Float64>`. It is null when that declaration
was not emitted. `effect0` is a List of records; its ordinal preserves global
execution order across all event declarations. Assignment outputs keep the final
write per channel; event lists retain every emission.

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
const field = node.module.outputs.fields.find(
  field => field.name === 'output0',
);
console.log(field?.type.toString()); // Struct<{series:Float64}>
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
data, inspect a manifest, create runtimes, allocate storage, or synchronize
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

WGSL lowering produces one bind-independent `CompiledWgslProgram`. The GPU
runtime accepts concrete bindings:

```ts
type GpuBinding = Readonly<{
  params: Readonly<Record<string, unknown>>;
  indices: number;
  series: Readonly<Record<string, readonly number[]>>;
  time?: readonly (number | null)[];
  sink: OutputSink;
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
Datum is published. A decode or sink failure makes the session terminal.
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
- broader GPU support for structs, resources, requests, strings, and colors.
