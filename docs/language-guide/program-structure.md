---
title: Program Structure
---

Every entry is an ordinary Tea program. There is no indicator or strategy header.
Imports select reusable libraries; declarations and statements describe one step
of computation over the bound input streams.

```tea
length = input.int(20, "Length", minval=1)
average = ta.sma(close, length)
emit "average" average
plot("average-plot", average, "Average")
```

The first output column contains a number. The second contains the ordinary
visual value returned by the library's `plot` function. Each ID identifies one
column and must be known during compilation. Display titles do not allocate IDs.

Use `emit.append` when one step may produce multiple values for a column:

```tea
if close > open
    emit.append "signals" "up"
if close < open
    emit.append "signals" "down"
```

The column is a `List<string>`; a step with no signal produces an empty list.
Its element type and append mode must agree at every emission site. Plain `emit`
allows one writer per column; conflicting modes and potentially repeated plain
writes are compile-time errors.

Functions can return explicitly, including from a branch or loop:

```tea
direction(float value) =>
    if value > 0
        return 1
    return -1

emit "direction" direction(close - open)
```

Implicit final-expression returns remain supported. The entry body does not need
a return. `library("name")` identifies a reusable source module; it does not
classify an entry program's execution mode.
