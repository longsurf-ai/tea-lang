# runtime

The `tea/runtime` package entry supports generated and handwritten TypeScript. `js/` owns JavaScript
execution mechanics; `gpu/` owns WebGPU execution. Public `Node` owns the CPU
reactive graph. Files at this directory root are limited to the generated-module
ABI, module binding, output/value representation, parameter
validation, loading, and history validation.
`docs/runtime.md` is authoritative; `docs/requests.md` owns request semantics.

## Invariants

- ABI 13 uses a concrete Module class with one flat configuration. Inputs and outputs each own one Arrow schema; state contains frame templates with captured empty Values, persistence and history requirements; requests co-locate metadata and child code. There is no ModuleManifest or public concretize operation.
- module.bind is synchronous and the sole parameter/default/context validation and preparation path. It returns an independent root/child configuration and fills defaults only when values remain unset. Child parameters never inherit parent patches; optional declaration paths address children. Existing executions and receivers stay unchanged. Fixed context values live once on constant builtin inputs and are used by both binding and execution.
- Generated binding code clears late facts before dependent evaluation. Incomplete parameters/context never leave stale facts marked ready. Streams and supplied flags never enter modules; Node owns availability and complete graph readiness.
- Generated artifacts construct ordinary Arrow schemas; standard IPC remains available for serialization and defensive schema copying. Do not structuredClone Arrow objects. Execution captures private configuration/schema copies once; binding copies configuration and schemas while Node inspection remains pure. Independent executions derive or load their own modules; immutable empty Values and code identity may be shared.
- Outputs have one Arrow schema and no parallel declaration array. Fields own names, types and write mode; snapshots walk the Arrow fields and captured values directly. Set fields contain nullable values; append fields contain non-null lists of raw values in per-column execution order. One cell array represents each step in schema declaration order. Duplicate sets abort the attempt, including a second null write. Do not recreate an event-specific payload type or metadata table.
- Runtime input numbers are finite or NaN; host integer parameters and fixed integer context values are safe integers (context also permits numeric na). Missing builtin data is distinct from typed null/NaN/false.
- Request synchronization is Node-owned. GPU device capacity planning stays beside the GPU runtime and uses the same module.bind operation.
- Context owns committed history, same-index values and Heap. Its synchronous step() returns StepResult directly and throws on failure. Existing history, aliasing, collection and provisional semantics are unchanged.
- Generated modules import tea/runtime and contain lexical functions plus exact Context types. main takes one Context; there is no funcs table or universal RuntimeContext operation table. The library entry must remain independent of compiler and Node API imports.
- Module.clone() explicitly creates an independent bound configuration with shared code. It replaces free clone/assembly helpers; each derived public Node owns its own module tree.
- Build/CI paths typecheck emitted TypeScript. loadModule transpiles the same source synchronously; tagged templates do not run a second checker. WGSL still consumes the same Tea Program.
- Bind errors use BindError; source compiler errors use Errors; runtime invariant failures use fatal. Do not add API-specific binding wrappers or duplicate error taxonomies.

- Runtime types are ordinary TypeScript classes, enums and generic Values. There is no StorageType registry or numeric value-layout ID. Color is an immutable RGBA byte class; output uses a detached Uint8 Struct while parameter metadata keeps canonical hex. Struct class constructors and erased unique-symbol members preserve nominal identity.
