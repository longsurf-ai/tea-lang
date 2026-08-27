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

- a Zod schema;
- a cold or hot Observable;
- an optional regular Clock;
- optional finite `indices`.

`indices` is semantic metadata, not a resource limit. When present, Node checks
that the stream emits exactly that many values. The Pine Extension uses it for
`last_bar_index` and `barstate.islast`. A live stream leaves it null.

Object schemas may declare exact epoch-millisecond fields:

```ts
time: z.bigint();
time_close: z.bigint();
```

Node validates them before execution. They remain event metadata and never
occupy Tea numeric-series slots.

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

The JS backend emits one recursive Runtime-ABI-7 module tree. Every root and
request child has the same code, manifest, layout table, request children, and
direct `concretize()` function.

Binding deep-copies the manifest tree, writes parameter values or
series-supplied markers, runs direct concretization on that copy, freezes it,
and returns a new module snapshot. Generated code never stores Observables,
DataStreams, runtime State, or Heap values.

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

Provisional success replaces Intermediate only. Final success replaces State
and Intermediate. Detailed assignment, reference, collection, and history
semantics live in [Memory model](memory-model.md).

Heap allocation safeguards remain internal implementation checks. They are not
execution inputs or user configuration.

## Lossless Datum

`StepResult` remains internal. Node or the GPU adds its absolute index and
optional event time to create one Datum:

```ts
interface Datum {
  readonly index: number;
  readonly time?: number | null;
  readonly outputs: readonly {
    readonly outputId: number;
    readonly channels: readonly Value[];
  }[];
  readonly effects: readonly {
    readonly effectId: number;
    readonly payload: EffectValue;
  }[];
  readonly provisional: boolean;
}
```

An absent output has no array entry. An explicitly emitted numeric `na` remains
`NaN`. Channels, effect ids, payloads, index, time, and provisional state are
never flattened or rewritten in memory. JSON or CSV spelling belongs only to a
chosen serializer.

Consumers do not advertise capabilities that alter upstream execution. Every
producer creates the complete Datum; a collector may retain only what it needs.

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
