# Tea execution configuration

Status: implemented

## Goal

Add one durable YAML/JSON configuration that selects a Tea program, one of the
available runtimes, and the execution context supplied to that program. The
same configuration is the future boundary for the CLI, editor tooling, scans,
and live execution.

The architecture remains three parts:

1. Tea Core compiles source through the single `compileToProgram()` pipeline.
2. A runtime executes that target-independent `Program` on JavaScript or
   WebGPU.
3. An execution context resolves providers and parameter selections into the
   existing ordered, complete `BindInputs[]` runtime boundary.

This work does not add another IR, a serialized physical plan, a job wrapper,
or strategy-specific runtime behavior.

## Configuration v1

YAML is the human-facing format; JSON is accepted because it is a YAML 1.2
subset.

```yaml
schema: tea.execution/v1

program:
  source: ./strategy.tea

runtime:
  kind: webgpu
  maxRowsPerChunk: 65536
  effectRecordsPerExecution: 5
  maxGpuBytes: 1073741824
  maxCacheBytesPerWorkgroup: 16384

execution:
  kind: sweep
  provider:
    kind: csv
    path: ../../data/binance/btcusdt-1d.csv
    sha256: fea088e4b139c8e99fe115e5ccdc5c85f2f1b25d6af38a7e71a29dfef1d0545d
  parameters:
    fast_length:
      range: {start: 2, stop: 20, step: 2}
    slow_length:
      range: {start: 24, stop: 60, step: 4}
    initial_cash: 100000
    slippage: 0.0005
    fee: 0.001
  maxExecutions: 10000
  timeNow: 1786579200000
```

V1 supports:

- `runtime.kind`: `javascript` or `webgpu`;
- `execution.kind`: `run` or `sweep`;
- one `csv` primary provider, wrapped in the existing built-in source routing
  so Tea requests still reach Yahoo/FRED;
- scalar Tea parameter values and explicit numeric range objects;
- optional CSV byte hash and deterministic `timeNow`;
- all four existing fixed WebGPU resource options. They are rejected for the
  JavaScript runtime, rebuilt field-by-field, and use the runtime's exact
  positive/nonnegative/zero-allowed contracts.

The CSV is always the root binding at the empty symbol/timeframe pair. Tea
requests from that execution may still use the built-in Yahoo/FRED routing,
but choosing a remote root context is not implied by `kind: csv` and is not a
v1 feature.

Omitted Tea parameters use their source declarations' defaults. `run` requires
exactly one execution, rejects ranges and `maxExecutions`, and defaults to the
JavaScript runtime only in the direct `run` command. `sweep.maxExecutions` is optional,
defaults to 10,000, and must be a positive safe integer no greater than 10,000. A sweep with no ranges
is a valid one-execution sweep. It expands ranges in Program parameter
declaration order and rejects axis/product overflow before materializing axis
values or parameter sets. Hyperparameters are ordinary Tea parameters selected
as ranges; they are not a second concept.

Configured or host-captured `timeNow` must be a finite safe epoch-ms integer.
The executing process captures an omitted value exactly once after any GPU
relay and copies it to every binding. This fixes time for one execution but
does not by itself freeze Program files, libraries, or mutable network request
data.

The document deliberately excludes output presentation, X/Y/Z selection,
camera state, GPU layouts, buffers, devices, API keys, environment expansion,
commands, and executable hooks.

The remaining `BindInputs` request, collection, heap, transient-heap, and
fixed-value limits stay on their existing runtime defaults in v1; the config
does not expose a partial generic `limits` bag.

All relative paths resolve from the configuration file's directory, never the
process working directory.

`program.source` selects Tea Core input; it is not a second Program
representation or compiler authority. `compileToProgram()` still produces the
only Program. An editor running a config follows this explicit source (and may
offer to create/update it from the active document) rather than silently
substituting another buffer.

## Ownership

- `src/compile.ts` remains unchanged and solely owns source-to-`Program` stage
  order.
- `src/execution/config.ts` strictly parses the versioned document, rejects
  unknown structure, retains its base directory, and resolves file paths. It
  performs no provider I/O and acquires no runtime resources.
- `src/execution/parameters.ts` validates structured scalar/range selections
  against `ParamSpec[]` and performs bounded deterministic expansion.
- `src/execution/context.ts` validates against Program parameter facts, asks an
  injected provider factory to construct the selected `DataProvider` once, and
  constructs ordinary complete `BindInputs[]` with one caller-supplied sink per
  execution. Its host dependencies are injected file reads, opaque provider
  configuration, `fetch`, clock, and sinks—not globals.
- `src/execution/run.ts` is the orchestration owner: compile once, resolve the
  execution context, acquire the runtime host, execute, and dispose. It does
  not own compiler stage order or presentation.
- `src/execute.ts` remains the only target-neutral Program execution harness.
- A small host adapter acquires JavaScript or Dawn/WebGPU target resources and
  returns an explicit disposable lease.
- `src/cli/parameters.ts` owns direct dynamic-parameter flag spelling and converts those
  tokens into the shared structured parameter selections.
- `src/cli/execution.ts` adapts the three first-class CLI entry points to the
  shared execution and reporting contracts. `src/main.ts` remains only
  Commander/process I/O.

The execution context accepts one narrow injected provider factory. V1's
closed config admits only `kind: csv`; the default factory owns byte/hash
validation, decoding, and `builtinSources` wrapping. It does not replace or
merge with `providers/data/registry.ts`, which routes runtime symbols such as
`FRED:CPIAUCSL`. YAML can never name an imported executable factory.

Context resolution returns `{kind, axes, bindings}`. This is execution metadata,
not a job/plan abstraction: `bindings` are the existing complete `BindInputs[]`,
and `axes` are retained only because sweep result projection needs them.

## CLI

Add the canonical command:

```text
tea execute path/to/run.yaml [--json]
```

The configuration is the command's single execution specification: `tea
execute` accepts no runtime, parameter, tracing, or visualization overrides.
`--json` changes only publication into the versioned renderer-neutral result;
a sweep JSON result includes every bounded trajectory captured during that
same execution.

The source-and-dynamic-parameter commands remain first-class:

```text
tea run strategy.tea -i data.csv --length 10
tea sweep strategy.tea -i data.csv --length 2:20:2
```

Their flags are translated to the same structured selections, provider,
runtime, and resolved execution-context path. V1 does not combine a config
file with CLI execution overrides, avoiding two sources of truth.

Direct positional source and `-i` paths are first resolved against the
invocation working directory, then adapted into the shared in-memory config;
they never inherit a synthetic YAML directory.

The Commander `preAction` Bun-to-Node relay hook calls the same
`loadExecutionConfig(path)` used by the action. A `webgpu` config is relayed to
Node 22 before Dawn dynamically loads the native binding; there is no second
partial YAML parser. Help/version do not read a config. The parent passes a
hash of the bounded config bytes and the child verifies that hash before
executing, so a changed file cannot silently select different semantics after
relay. The hook retains one immutable `{config, bytesHash}` snapshot. A
same-process JavaScript execution consumes that exact snapshot instead of
reading the path again; a relayed child reloads once and verifies the private
parent hash before executing. Typed preflight configuration errors use the
normal `tea: ...`, exit-1 user-error path.

## Validation and trust boundaries

1. Reject configuration files larger than 1 MiB.
2. Parse exactly one YAML 1.2 core-schema document. Before conversion, bound
   AST depth and node/collection counts and reject aliases, anchors, merge
   keys, custom/explicit tags, complex keys, duplicate keys, and trailing
   documents.
3. Require a mapping root and `schema: tea.execution/v1`; reject every unknown
   key and rebuild accepted mappings without object prototypes.
4. Accept only finite numbers, strings, and booleans as parameter scalars—never
   YAML null—and the exact range shape. JSON uses identical semantics.
5. Validate parameter names, types, enums, constraints, range direction,
   numeric precision, and execution count against the compiled Program.
6. Reconstruct whitelisted runtime/provider objects; never spread parsed
   mappings into runtime options.
7. Let provider binding, WGSL eligibility, device limits, and runtime numeric
   profiles remain authoritative at their existing boundaries.
8. Never interpolate `~`, environment variables, or shell syntax. Provider
   secrets continue to come from the host environment and are never serialized.

The path base is `dirname(resolve(configArgument))`; source and data paths are
resolved lexically against it and must be readable regular files. A future
editor host separately resolves real paths when enforcing workspace trust so a
symlink cannot evade user confirmation. CSV `sha256` is optional, but when
present it is verified against the exact bytes before decoding. Program/import
versions and any network requests remain external provenance.

The parser exposes one typed `ExecutionConfigError`, printed once without a
stack at host boundaries. Parser limits are fixed constants in the config
module: 1 MiB source bytes, 64 levels, 10,000 nodes, and 10,000 entries per
collection. `sha256` is exactly 64 hexadecimal characters.

Workspace trust and confirmation of paths outside an editor workspace belong
to the future editor host, not to Tea Core or the configuration parser.

## Delivery

### A. Configuration and parameters

- Pin the open-source `yaml` parser.
- Add strict parser/path tests and structured parameter expansion tests.
- Calculate every range cardinality and the Cartesian product before allocating
  arrays; then materialize with the same scaled-integer algorithm used by CLI
  ranges (`String(number)` canonicalizes YAML/JSON numbers).
- Route direct CLI parameter syntax through the shared expander.

### B. Resolved execution context

- Build the CSV/built-in provider from the config.
- Produce complete `BindInputs[]` with one captured or configured `timeNow`.
- Add injected, offline tests for relative paths, defaults, ordering, limits,
  and binding metadata.

### C. Runtime selection and CLI

- Add the disposable JavaScript/WebGPU host lease.
- Add `tea execute` and route direct run/sweep through the same resolution
  path.
- Update the Node 22 relay for config-selected WebGPU.
- Prove equivalent direct flags and YAML produce identical run/sweep values.

### D. Documentation and real example

- Add an execution-config reference and document the three-part ownership.
- Add a checked-in config that runs the real Binance daily EMA sweep.
- Keep visualization state out of that file.

### E. Verification and review

- Run typecheck, the complete Bun suite, docs build, standalone npm install,
  real Dawn tests, CLI run/sweep/config equivalence, and scoped diff checks.
- Perform an adversarial review for parser safety, path resolution, resource
  ownership, GPU relay, and accidental Core/runtime coupling before committing.

## Deferred

- live editor updates beyond the implemented command/Webview dashboard;
- trajectory comparison across multiple selected executions;
- network/live provider configurations;
- multiple binding templates, scans, or live scheduling;
- CLI overrides layered over a config;
- config migration readers for future schema versions.

Those extend the same boundary only after their execution semantics exist.
