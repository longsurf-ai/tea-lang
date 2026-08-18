# Configured execution host

This directory turns one validated execution configuration into an ordinary
Tea `Program` execution. It is host orchestration, not another compiler or IR.

## Invariants

- Keep the architecture in three parts: Tea Core alone compiles source to the
  target-independent `Program`; a platform runtime executes that Program; the
  execution context supplies providers, parameter selections, inputs,
  bindings, time, and the run kind.
- `config.ts` owns the closed, versioned file schema and path snapshot. It must
  reject unknown structure and executable YAML features. It does not compile,
  construct providers, acquire devices, or render output.
- `parameters.ts` validates selections against Program-owned parameter facts
  and expands bounded sweeps in declaration order. Omitted parameters remain
  omitted so the Program's defaults stay authoritative.
- `context.ts` constructs each selected provider once and resolves complete,
  backend-neutral `BindInputs[]`. Provider I/O and host capabilities remain
  injected seams; the context never selects a compiler backend.
- `backend.ts` owns only runtime-host acquisition and disposal. WebGPU resource
  fields map directly to the GPU runtime contract; JavaScript acquires no host
  resource.
- `run.ts` compiles through `compileToProgram()` exactly once, then resolves the
  context, acquires the backend, executes, and disposes it. Presentation remains
  a caller concern.
- The first-class `tea run` and `tea sweep` commands adapt their dynamic flags
  into an in-memory v1 config and use this same context and runtime path. Do not
  maintain a second execution implementation for direct source commands.
- Keep tests colocated and use only repository-owned fixtures or injected host
  dependencies. The Program snapshot hash covers exact root-source bytes plus
  the compiler-owned Tea source closure; provider hashes cover exact input
  bytes. UTF-8 decoding is fatal.
