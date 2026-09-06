---
title: Tea Compiler
---

Tea compiles to ordinary TypeScript backed by `tea/runtime`. The same runtime
can execute handwritten TypeScript. The WGSL backend starts from the same
checked Program and supports a narrower GPU subset.

```text
Tea source → parser → checker → noder → Program
                                        ├─ TypeScript → runtime Module
                                        └─ WGSL artifact → GPU execution
```

## One semantic source

The parser records source syntax and positions. The checker determines types,
qualifiers, declaration identity, and legal operations. The noder projects those
checked facts into Program: expressions, statements, parameters, input needs,
outputs, and call-site state. It does not repeat type checking.

Both backends consume this Program. Neither receives data streams, a device,
application scenarios, or trading-policy objects. See [Program IR](../ir.md)
for the exact ownership rules.

## Readable generated execution

For example:

```tea
factor = input.int(2)
var float total = 0
total += close * factor
emit "total" total
```

The generated TypeScript contains a program-specific `ProgramContext` and an
entry function equivalent to this excerpt:

```ts
function main(ctx: ProgramContext): void {
  ctx.state.locals.total.init(() => float(0));

  const before = ctx.state.locals.total.hist(0);
  const close = ctx.inputs.series.close.hist(0);
  const factor = ctx.params.factor;
  ctx.state.locals.total.set(before.add(close.mul(factor)));

  ctx.outputs.total.set(ctx.state.locals.total.hist(0));
}
```

`ProgramContext` identifies `factor` as an integer value, `close` as a readable
float input, and `total` as writable float state. Its output accepts one captured
float value. Unknown inputs, writes to input series, and
incompatible output values fail TypeScript checking.

`hist()` returns a captured value. Later assignment cannot change that capture.
Arithmetic lives in the runtime's value methods, including Tea's integer
division, missing-value rules, and numeric overflow handling. Persistent
initialization is lazy: it occurs only when execution reaches `.init()`.

Functions are ordinary lexical TypeScript functions. A stateful function
receives its own typed frame; two written calls use separate named entries in
`frame.calls`. History-bearing arguments are copied into that call's frame.
[Runtime execution](../runtime.md) explains frames and transactions in detail.

## Configuration and execution

The complete artifact exports a `Module<ProgramContext>`. Its constructor
receives the generated entry function, schemas, state requirements, request
children, and any parameter-dependent binding calculation. Arrow schemas and
TypeScript declarations come from the same Program. Readable Arrow constructors
appear directly in the artifact. Storage descriptors serve internal history and
Heap operations, rather than defining another I/O schema.

`module.bind()` validates parameters and updates configuration atomically. It
returns the same Module. `module.clone()` creates an independent configuration
for another run. Execution starts only when configuration is complete.

Node connects streams and synchronizes request children. Context then runs one
module step, commits state and buffered outputs together after success, and
aborts failed attempts. Generated functions do not commit independently.

## Build and inspect

```sh
tea parse example.tea --ir
tea build example.tea -o example.ts
```

Builds check generated TypeScript against the actual runtime library. The
synchronous template API skips that repeated check and transpiles the same
source when loading. There is one TypeScript emitter; JavaScript is a mechanical
translation of its result.

The [GPU backend](/advanced/gpu-lowering) embeds that same Module for parameter binding
while executing its eligible Program subset as WGSL. Handwritten TypeScript is
not a WGSL input.
