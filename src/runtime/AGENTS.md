# runtime

The `tea/runtime` package entry supports generated and handwritten TypeScript. `js/` owns JavaScript
execution mechanics; `gpu/` owns WebGPU execution. Public `Node` owns the CPU
reactive graph. Files at this directory root are limited to the generated-module
ABI, module binding, output/value/layout representation, parameter
validation, loading, and history validation.
`docs/runtime.md` is authoritative; `docs/requests.md` owns request semantics.

## Invariants

- ABI 11 uses a concrete Module class with one flat configuration. Inputs and outputs each own one Arrow schema; state groups descriptors and frame templates; requests co-locate metadata and child code. There is no ModuleManifest or public concretize operation.
- module.bind is synchronous and the sole parameter/default/context validation and preparation path. It mutates and returns its receiver, preserving root and child module identity, and fills defaults only when values remain unset. Failed binding changes no configuration; binding is rejected after execution starts. Fixed context values live once on constant builtin inputs and are used by both binding and execution.
- Generated binding code clears late facts before dependent evaluation. Incomplete parameters/context never leave stale facts marked ready. Streams and supplied flags never enter modules; Node owns availability and complete graph readiness.
- Generated artifacts construct ordinary Arrow schemas; standard IPC remains available for serialization and defensive schema copying. Do not structuredClone Arrow objects. Execution captures private configuration/schema copies once; ordinary binding and Node inspection do not clone modules. Independent executions explicitly clone or load their own modules; descriptor/code identity may be shared.
- Outputs have one Arrow schema and one declaration array. Fields own names, types, write mode and kind; declarations own only args and physical snapshot IDs. One cell array represents each step. Do not recreate an event-specific payload type or metadata table.
- Runtime input numbers are finite or NaN; host integer parameters and fixed integer context values are safe integers (context also permits numeric na). Missing builtin data is distinct from typed null/NaN/false.
- Request synchronization is Node-owned. GPU device capacity planning stays beside the GPU runtime and uses the same module.bind operation.
- Context owns committed history, same-index values and Heap. Its synchronous step() returns StepResult directly and throws on failure. Existing history, aliasing, collection and provisional semantics are unchanged.
- Generated modules import tea/runtime and contain lexical functions plus exact Context types. main takes one Context; there is no funcs table or universal RuntimeContext operation table. The library entry must remain independent of compiler and Node API imports.
- Module.clone() explicitly creates an independent bound configuration with shared code. It replaces free clone/assembly helpers; public Node keeps one stable module tree.
- Build/CI paths typecheck emitted TypeScript. loadModule transpiles the same source synchronously; tagged templates do not run a second checker. WGSL still consumes the same Tea Program.
- Bind errors use BindError; source compiler errors use Errors; runtime invariant failures use fatal. Do not add API-specific binding wrappers or duplicate error taxonomies.
