# codegen

Bind-independent lowering from the one checked Program. `codegen.ts` and
`lower.ts` emit ordinary TypeScript importing `tea/runtime`; `wgsl/` emits the
supported GPU subset. `docs/runtime.md` owns execution contracts.

## Invariants

- Both targets consume Program directly, once. No backend receives datasets,
  parameters, devices, jobs, runtime buffers, or application policy objects.
  No strategy wrapper IR, parallel frontend, or trade/broker/portfolio name
  recognition belongs here.
- The CPU artifact is TypeScript ESM exporting one ABI-13 `Module<Context>`.
  Its Context type describes exact parameters, inputs, named frame state, and
  output destinations. `main` and ordinary lexical functions use the same
  runtime library available to handwritten TypeScript. There is no second JS
  emitter, numeric function table, or generated interpreter.
- `check.ts` checks generated builds and CI fixtures against actual runtime
  exports. Synchronous template loading transpiles that same source. Generated
  programs import only `tea/runtime`; no host I/O, Date, or randomness appears.
  Generation is deterministic. Portability tests check TypeScript syntax,
  imports, and actual semantic types.
- `ir/frames.ts` owns Name locations and call-site topology. A method owns its
  hidden receiver; each function owns its arguments and locals. The program
  frame owns the remaining Names. Reuse that projection rather than inferring
  ownership from reachability or copying its address map.
- Generated setup metadata retains slots and captured empty Values alongside
  stable names for inputs, locals, and call sites. It emits no runtime structural
  type table or numeric value-layout IDs. Execution uses named
  properties such as `ctx.state.locals.total` and `frame.calls.accumulate`.
  Repeated written calls have independent state; repeated execution of one
  written call reuses that state.
- `Value` is a captured value. `Input.hist()` and `Series.hist()` capture before
  later operand effects; `Series.set()` stages a write. Arguments are captured
  in source order before selecting the call frame. History-bearing formals
  copy arguments into their own frame; other formals remain ordinary locals.
  Function returns never borrow a live caller or callee binding.
- Persistent declarations remain lexical `InitName` statements, lowered to an
  inline `needsInit()` guard and `initialize(value)` so a source `return` exits
  its enclosing function. Context owns the transaction and commits only
  after successful main execution. Generated functions never commit separately.
- Arithmetic and intrinsics call runtime methods/functions, including integer
  division, finite-or-NA normalization, color conversion, and NA-aware equality.
  Int-to-float widening is explicit where required by a typed boundary. And/Or
  remain lazy; ternary syntax lowers to the same lazy conditional IR as if.
  Invalid non-finite Program constants still fail lowering.
- Numeric loops capture bounds once, preserve ascending/descending inclusive
  ranges and index writes, and stop zero or non-progressing updates. Sparse
  output bounds are a separate transport constraint, not a general loop limit.
- Generated structs are classes with named captured-Value fields and erased
  unique-symbol brands. Their factories retain constructor identity and logical
  byte size. Tea enums are generated string enums; Color uses the runtime class. A field write
  captures `receiver.require().field(name)` before evaluating its RHS. A
  collection mutator captures its receiver before arguments and stores only the
  replacement header afterward. Copying a reference never clones its body.
- Module owns inputs, parameters, state requirements, outputs, request children,
  and one immutable `bind()` method. Its private calculation callback receives
  only a draft of binding facts and fixed context values. It resets late facts
  before checking missing parameters and evaluates the supported non-allocating
  const/input/simple subset. There is no binding-time frame or Heap.
- Bound history normalizes each synthesized component before combining maxima;
  an invalid component contributes zero without erasing another valid demand.
  Builtin constancy comes from qualifiers. Parameter enum identity comes from
  Program.nominalIds, shared by JS and WGSL projection.
- Each request record keeps its direct declaration name, context/policy,
  child Module, and parent/child captured empty Values together. Node computes and
  synchronizes children before main reads `ctx.inputs.children.name.hist()`.
  Dynamic request contexts fail before codegen. Option and context arguments
  each retain their independent source evaluation order.
- `schema.ts` is the sole Type-to-Arrow projection. Both backends use it and
  Program.nominalIds. Generated Schema/Field/DataType constructors reproduce
  those Arrow objects; no second output declaration table exists. Do not change
  the Program interface without explicit user approval.
- One output schema owns named value types and write modes in source declaration
  order. Generated destinations use `.set(value)` or `.append(value)` and capture
  detached values at that point. Set fields hold nullable T; append fields hold
  List<T> in runtime append order, without cross-column ordinals. Tea validates
  static names, mode/type consistency, and unique plain writers before codegen.
- `gpu/contract.ts` owns the GPU artifact ABI, fixed bindings, offsets, and
  strides. WGSL embeds this same generated Module; GPU binding clones and binds
  it instead of evaluating another representation of configuration expressions.
  Unsupported references, matrix iteration, and unlisted natives fail closed
  at their owning backend boundary.
