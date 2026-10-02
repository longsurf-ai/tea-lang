---
title: Introduction
slug: /
---

Tea is a language for calculations over ordered time-series inputs. A program
runs once per input step, can retain state and history, and emits named values.
The host supplies the data and decides how to display or deliver the output.
Tea itself does not fetch prices, send notifications, or place real orders.

## Start here

Read [program structure](language-guide/program-structure.md) and
[execution model](language-guide/execution-model.md) before writing a program.
Then choose the topic you need:

| Task                                                               | Read                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Variables, types, reassignment, functions, loops                   | [Values and control flow](language-guide/values-and-control-flow.md)              |
| Moving averages, crossings, warmup, missing values, retained state | [Time-series calculations](language-guide/time-series.md)                         |
| Plots, named outputs, event conditions and payloads                | [Outputs and events](language-guide/outputs-and-events.md)                        |
| Another symbol or timeframe                                        | [Requests](requests.md)                                                           |
| Reusable source modules                                            | [Imports](imports.md)                                                             |
| Aliasing, collections, history, realtime and rollback              | [Memory model](memory-model.md)                                                   |
| Exact built-in signatures and supported library exports            | [Reference](reference/overview.md)                                                |
| A complete first program                                           | [Write your first indicator](getting-started/Write%20your%20first%20indicator.md) |

To look up a named API, search `reference/` recursively. Native signatures live
in `reference/native-functions.md`; ordinary library declarations live in
`reference/libraries/<library>.md` (`ta.md` for calculations, `visual.md` for
plots and alerts). `reference/functions.md` is an index, not the declarations.

## One program, one step

```tea
length = input.int(10, "Length", minval=1)
average = ta.sma(close, length)
plot("average", average, "Average")
```

The host binds `close` and the parameter `length`. Each step computes the next
average. `plot` emits a visual description with the fixed ID `average`.
An entry may start with `indicator("Title", overlay = false)` to give a host
its display title and placement; the header never changes execution. There is
no `strategy()` header. An ordinary Tea program can emit numbers, plots,
events, or several of these together.

Tea resembles Pine in some syntax. Use this version's declarations and semantics:
for example visual helpers require an output ID before the value/condition,
request declarations require host-bound data, and history indexes apply to
bindings. A function or spelling found in another language is not evidence of
support here.

For a behavior check, derive expected values from the requirement, choose a
small finite input containing both matching and nonmatching cases, and compare
the actual outputs. Successful compilation establishes legal code; a successful
run establishes execution. Neither alone establishes the intended behavior.
