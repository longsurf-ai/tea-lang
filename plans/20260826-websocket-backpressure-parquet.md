# Add bounded live transports and columnar row adapters

Status: in progress; bounded Node/sink serialization and final-only JSON
WebSocket adapters are implemented. Parquet, GC seams, and benchmarks remain.

## 1. System map

```text
                         bounded queue
WebSocket JSON --> Zod --> DataStream --> Node
       ^                                                         |
       |                                                         v
       +-- close/error lifecycle                         public Datum
                                                                 |
                                      +--------------------------+-----------+
                                      v                          v           v
                              WebSocketSink                 ParquetSink   Stdout/CSV
                              bufferedAmount                nested schema
                                      |                          |
                                      +------ completion/error --+
```

- RxJS is push-based and has no automatic demand protocol. Every non-pausable
  source must therefore declare a finite queue capacity and overflow behavior.
- Correctness is the default: overflow errors. Lossy `drop-oldest`,
  `drop-newest`, and `latest` are explicit host choices, never hidden defaults.
- First WebSocket semantics are final JSON datums only. Reconnect,
  provisional/final messages, watermarks, and application ACK protocols remain
  staged.
- Parquet reuses the same Datum shape; it preserves multi-channel structs and
  effect lists natively instead of inventing a second Tea-output projection.

## 2. Problem

`WebSocketSource` is a throwing stub, no WebSocket sink exists, and the current
Observer-style sink cannot acknowledge slow writes. `concatMap` preserves Node
step order but may queue an unbounded number of upstream emissions. Grafana's
live implementation confirms the required pattern: explicit readiness plus
bounded retained frames, rather than implicit RxJS backpressure.

The target is a small transport policy shared by live sources and async sinks.
WebSocket and Parquet adapters consume validated datums; neither knows Tea
output IDs, channels, request semantics, or runtime Heap state.

## 3. Implementation

1. **Keep synchronous runtime execution one-to-one** — `src/api/stream.ts`, `src/api/node.ts`
   - `DataStream` carries only its schema, Observable, and optional Clock.
   - `JSRuntime.step()` has no asynchronous boundary. Node therefore uses
     ordinary RxJS `map`: one input Datum completes exactly one step before the
     next input emission can run.
   - Do not add an execution queue, capacity, or overflow policy until a runtime
     step can actually suspend. A future asynchronous runtime must define that
     boundary from first principles when it exists.

2. **Implement final-only JSON WebSocket input** — `src/api/source.ts`
   - `WebSocketSource<T>` requires URL, Zod schema, and optional Clock. Use the
     host's WebSocket implementation; allow the constructor to be injected
     directly for deterministic tests without a new transport interface.
   - Connect on subscription, accept text frames only, `JSON.parse`, then rely
     on `DataStream` for the single Zod validation. Clean close completes;
     socket/parse/schema errors fail; unsubscribe removes listeners and closes
     the socket. No reconnect or implicit message loss.

3. **Implement WebSocket output as an Observer** — `src/api/sink.ts`, `src/api/node.ts`
   - Node publishes to ordinary RxJS observers. A transport observer owns any
     queue required by that transport; Node does not define a parallel Sink
     protocol. Multiple observers remain independent and never reconnect or
     duplicate program execution.
   - `WebSocketSink<T>` requires a Zod schema, validates a datum, JSON-encodes
     it, and waits while `bufferedAmount` exceeds its finite high watermark.
     Socket error/close rejects `completion`; `complete()` waits for pending
     sends before closing. Reuse the same capacity/overflow vocabulary for
     host-side pending sends.
   - `CSVSink` exposes physical file completion after Node Writable flush;
     `StdoutSink` writes synchronously and owns no completion Promise.

4. **Add Parquet as a separate physical adapter** — `src/api/source.ts`, `src/api/sink.ts`
   - First select one maintained, permissively licensed standalone npm
     implementation through a focused spike; do not add both Arrow and Parquet
     stacks. Record the choice and exact supported logical types before adding
     the dependency.
   - Map scalar datum fields to primitive nullable columns, multi-channel output
     objects to structs, and effects to lists of structs. Reject unsupported
     runtime handles/Refs before opening a file. Parquet source requires a
     caller-provided Zod schema and optionally carries Clock metadata.
   - Write row groups incrementally with a bounded row-group size; never retain
     the complete execution merely to produce one file.

5. **Add live examples, GC seams, and non-flaky benchmarks** — `examples/api/`, `src/runtime/js-runtime.ts`, `tests/`
   - Add WebSocket-to-Tail, WebSocket-to-CSV, CSV-to-WebSocket, and
     WebSocket-to-WebSocket examples. Automated tests use an injected fake
     socket and never open a network connection; manual examples use explicit
     final-datum JSON protocols.
   - Thread existing `JSRuntimeOptions` through Node construction for tests.
     Add a narrow snapshot method for Heap statistics only if behavioral tests
     with small limits cannot prove reclamation; do not expose Heap or refs.
   - Add opt-in benchmarks for CSV parse, base Node steps, scalar/count/event
     requests, each sink, queue overflow, and Parquet row groups. Report
     rows/sec, queue high-water mark, and retained Heap bytes; CI checks
     correctness, not machine-dependent throughput thresholds.

## 4. Verification

- [ ] Bounded-operator property tests prove capacity never exceeds its limit,
      FIFO/error/drop/latest behavior, cancellation, and completion under reentrant
      emissions.
- [ ] Fake-WebSocket tests prove lazy connection, JSON/Zod failures, clean
      completion, unsubscribe close, send ordering, `bufferedAmount` waiting, and
      every overflow mode without network access.
- [ ] CSV/Tail regression tests prove awaitable writes preserve order and
      propagate drain/write failures without reconnecting Node execution.
- [ ] Parquet round trips preserve nullable scalars, multi-channel structs,
      effect lists, column order independence, and bounded row-group memory.
- [ ] GC stress tests prove temporary arrays are reclaimed and retained history
      remains rooted under small injected limits.
- [ ] Example smoke tests cover all local/fake source-sink combinations;
      `npm run typecheck && npm test && npm run docs:check` and Dawn GPU tests pass.
