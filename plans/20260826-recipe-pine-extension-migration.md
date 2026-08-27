# Recipe and Pine Extension migration

## Result

```text
application DataStreams
        │
        ▼
Batch Recipe ─▶ Node.bind() / Node.to() ─▶ JSRuntime ─▶ lossless Datum

application numeric arrays
        │
        ▼
GpuBinding[] ─▶ WebGPU session ─▶ complete Datum publication
```

- `Recipe<R>` has only `execute(): Promise<R>`.
- Batch is one finite public Node wiring, not another executor.
- Parameters and DataStreams remain the only Node binding forms.
- `DataStream.indices` supplies finite extent when known.
- The Pine Extension derives contextual values from Node index, finite extent,
  current input time, and one fixed historical clock.
- Applications own files, databases, network calls, symbol routing, and request
  child DataStreams.
- GPU execution accepts concrete arrays and derives physical capacities from
  the artifact and hard device limits.

## Deleted compatibility architecture

- the complete `src/execution/` directory;
- YAML/JSON execution schemas and strategy sweep files;
- the transitional direct-runtime Batch harness;
- `node-batch.ts`, finite-context adapters, and parameter-grid expansion;
- fixed-storage counters, workspaces, and leases;
- external data/context contracts and built-in source registries;
- sink capabilities that changed upstream transport;
- caller-set CPU Heap/request/fixed-storage options;
- caller-set GPU chunk, effect, memory, and cache options;
- the generic CPU/GPU backend union and `runProgram()` wrapper.

## Current ownership

1. Compiler produces one Program.
2. JS lowering produces one recursive JSModule.
3. Node owns the public CPU graph, requests, runtimes, index, Pine values, and
   Datum publication.
4. Batch Recipe binds, observes, awaits completion, counts indices, and
   disposes.
5. CLI `run` is a small application of that path and uses scoped `using`
   timers.
6. GPU lowering produces one reusable artifact; the GPU runtime consumes
   concrete `GpuBinding[]` without a host-orchestration layer.

## Verification

- [x] public Node executes finite Pine builtins and validates DataStream extent;
- [x] direct and request-child indices remain context-local;
- [x] conformance cases run through finite DataStreams, Node, and TraceSink;
- [x] strategy component, lot, EMA, BB, and Alice execution regressions pass;
- [x] GPU unit and real Dawn parity use concrete bindings;
- [x] package exports and public Batch example run;
- [x] documentation generation, links, typecheck, and offline build pass;
- [x] stale architecture names are absent from supported source and docs.

The next orchestration feature is a concrete Sweep Recipe. No parameter-grid or
configuration layer exists before that Recipe has an approved minimal design.
