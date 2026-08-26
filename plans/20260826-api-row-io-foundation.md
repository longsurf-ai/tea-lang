# Establish one Datum boundary for API row I/O

Status: implemented and verified on 2026-08-26.
Final gates: 117 test files / 1,134 tests, documentation build, and 18 Dawn
integration tests passed under Node 22.

## 1. System map

```text
CSV bytes --> CSV parser --> DataStream<T> --> Node --> JSRuntime
                              | schema                  StepResult (internal)
                              | clock                         |
                              +-------------------------------v
                                                       toDatum()
                                                            |
                                                  public Node Datum
                                                            |
                                      +---------------------+----------------+
                                      v                     v                v
                                  CSVSink                StdoutSink     later row sinks
```

- `StepResult.toDatum()` is the one format-neutral output projection, and public
  `Node.to()` emits only that Datum. Raw StepResult remains a JSRuntime-level
  value. CSV, WebSocket, Parquet, and Tail adapters must not reinterpret output
  IDs or channels independently.
- One Tea output is one datum column: a single channel is unboxed; multiple
  channels become an object keyed by manifest channel names. Effects remain one
  array column.
- `DataStream` owns Zod validation exactly once. Sources decode physical bytes
  but do not parse the same row again.
- This slice deliberately does not solve asynchronous backpressure or
  provisional WebSocket updates; the dependent transport plan owns those.

## 2. Problem

The package root is not exported normally, CSV factories cannot carry clocks,
and CSV rows are Zod-parsed by both `CSVSource` and `TeaNode`. On output,
`Node.to()` currently publishes physical `StepResult` values while `CSVSink`
accepts schema-shaped rows, so the public Node boundary is not yet a row
operator.

The target is one small reusable row boundary. Runtime owns conversion from Tea
outputs to a datum; Node publishes that datum directly. CSV and Tail remain
physical encoders rather than Tea-aware sinks.

## 3. Implementation

1. **Export the public API from the package root** — `package.json`, `src/index.ts`
   - Add `".": "./src/index.ts"` to `exports` and make `src/index.ts` export
     `./api/index` explicitly. Keep specialized subpath exports unchanged; do
     not add a second hand-maintained API barrel.
   - Replace the obsolete `src/api/mock.ts` sketch with imports used by the
     runnable examples, or remove it once those examples own the grammar.

2. **Make Node a Datum-output operator** — `src/runtime/js-runtime.ts`, `src/api/node.ts`
   - Add `toDatum(): Readonly<Record<string, unknown>>` to `StepResult`.
     `JSRuntime` constructs the method with access to its immutable manifest
     output declarations; no declaration/schema array is copied into each
     result.
   - Emit stable columns `output_<oid>` for every manifest output with at least
     one channel. A missing conditional emission becomes `null`. One channel
     becomes its scalar value; multiple channels become a frozen object whose
     keys are the manifest channel names. Add `effects` as the complete frozen
     effect array and `provisional` as a boolean column.
   - Normalize Tea numeric `na` to `null`, including tuple/effect children.
     Fail explicitly when a channel still contains a Heap `Ref` or collection
     header; deep snapshots remain a separate memory-model feature.
   - Export the structural `Datum = Readonly<Record<string, unknown>>` contract
     from the API. Change Node's public result Subject and `to()` signature to
     RxJS `Observer<Datum>`; convert each internal StepResult exactly once before
     publication. Input Datum fields are not copied into output Datum. Raw
     StepResult remains available only to callers using JSRuntime directly.
   - Update Node lifecycle tests to assert exact Datum rows and preserve the
     existing single execution, later-sink, error, completion, and disposal
     behavior. Do not add an adapter, sink base class, or projector overload.

3. **Give `DataStream` one validation and clock owner** — `src/api/stream.ts`, `src/api/source.ts`, `src/api/node.ts`
   - Validate every source emission through `DataStream.schema` once before it
     reaches subscribers. Remove parsing from `csvRows()` and `TeaNode`.
   - Extend `CSVSource`, `CSVSource.open()`, and `fromCSV()` with an optional
     `Clock`, defaulting to `i`, and pass it unchanged to `DataStream`.
   - A schema without a direct bigint `time` output is untimed: it cannot select
     event-time synchronization but remains eligible for clock-count or
     one-to-one policies. Tests pin no-time CSV, bigint-time CSV, and clocked
     CSV behavior.

4. **Implement conventional CSV write modes with optional schemas** — `src/api/sink.ts`
   - Support these overloads without an options interface:

     ```ts
     new CSVSink(path, 'w');
     new CSVSink(path, 'a');
     new CSVSink(path, schema, 'w');
     new CSVSink(path, schema, 'a');
     ```

     Mode defaults to `w`; schema is optional.

   - `w` truncates. A supplied schema writes its header immediately; otherwise
     the first datum freezes columns and an empty execution creates an empty
     file. `a` reads the existing CSV header with `csv-parse`; absent/empty
     files use the schema or first datum. Compare column-name sets, then reorder
     each new row into existing header order. Missing/extra columns fail before
     writing.
   - Encode nested objects/arrays, including multi-channel outputs and effects,
     as JSON cells. Encode `null` as an empty CSV cell. A supplied Zod schema
     validates values in addition to structural column checks.

5. **Add the smallest inspectable sink and CSV examples** — `src/api/sink.ts`, `examples/api/`, `tests/`
   - Add generic `StdoutSink<T>` with an injected formatter and `writeLine`;
     defaults are JSON serialization and stdout. It prints each value
     immediately and resolves `completion` on complete.
   - Add deterministic examples for CSV-to-Tail, CSV-to-CSV scalar output,
     scalar request over two CSV streams, clock-count collect, and event-time
     collect. Examples accept paths through argv and never overwrite fixtures.
     Automated tests use temporary outputs and checked-in local CSV inputs only.

## 4. Verification

- [x] `npm test -- src/runtime/js-runtime.test.ts src/api/sink.test.ts` proves
      scalar/multi-channel/missing outputs, effects, na normalization, unsupported
      Ref failure, direct Node Datum publication, Tail output, and CSV `a`/`w`
      behavior.
- [x] `npm test -- src/api/source.test.ts src/api/tea.test.ts` proves one Zod
      parse, optional clocks, no-time fallback, and unchanged request execution.
- [x] An import test loads `tea` through the package root without using an
      internal source path.
- [x] Example tests run every local CSV pipeline, compare exact output rows,
      reject mismatched append columns, and leave source fixtures unchanged.
- [x] `npm run typecheck && npm test && npm run docs:check` passes; API docs and
      `examples/README.md` describe the single Datum boundary and CSV modes.
