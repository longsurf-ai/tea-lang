---
title: Values and control flow
---

## Bindings and reassignment

`=` declares a binding; `:=` assigns an existing binding. An ordinary declaration
runs each time execution reaches it. `var` initializes the binding once, when
first reached, and retains it across steps. See the [execution model](./execution-model.md)
for repeated attempts on one live step.

```tea
threshold = input.float(50, "Threshold")
above = close > threshold
var int count = 0
if barstate.isconfirmed and above
    count := count + 1
emit "count" count
```

Use `int`, `float`, `bool`, `string`, and `color` annotations when needed.
An initially missing numeric value needs an explicit type, such as
`var float lastPrice = na`. Test missingness with `na(value)`; use
`nz(value, replacement)` only when replacing a missing observation matches the
requirement. Booleans are not nullable.

Float arithmetic uses binary floating-point values. Decimal prices and computed
percentages can round to either side of a threshold, even when the decimal
calculation is exactly equal. Define the required precision or tolerance for
such comparisons and test decimal boundary values; an integer-price example
alone does not establish the equality behavior.

`const`, `input`, `simple`, and `series` are qualifiers, ordered from least to
most variable. A parameter that accepts `input` cannot accept a value that
changes on every step. The [native reference](../reference/native-functions.md)
shows restrictions for each parameter.

## Expressions and blocks

Arithmetic uses `+`, `-`, `*`, `/`, `%`; comparisons use `<`, `<=`, `>`, `>=`,
`==`, `!=`; boolean expressions use `and`, `or`, `not`.
Use indentation for blocks, and `//` for comments. Both `if` and the ternary
operator evaluate only the selected branch.

```tea
range = high - low
ratio = range > 0 ? (close - low) / range : 0.0
label = if ratio >= 0.5
    "upper"
else
    "lower"
emit "label" label
```

Keep helpers requiring consecutive history outside conditional branches and
combine their already computed results with the condition. A helper's history
belongs to that written call site, not to every bar it skipped.

## Functions and loops

A function uses `=>`, has inferred or annotated parameters, and returns its last
expression or an explicit `return`. Each written call owns its own persistent
locals and parameter history. A multi-value return must be destructured at its
declaration, as `[a, b] = function(...)`; a tuple is not a general stored value.

```tea
mean(float source, int length) =>
    sum = 0.0
    for i = 0 to length - 1
        sum := sum + source[i]
    sum / length

emit "mean" mean(close, 3)
```

`for i = 0 to n` includes both endpoints. Use `array.get(values, i)` or
`values.get(i)` for collection access: `values[i]` is history of the binding,
not element indexing. Arrays, maps, structs and methods are covered by the
[memory model](../memory-model.md). Consult the [type inventory](../reference/types.md)
for supported forms rather than assuming another language's type syntax.
