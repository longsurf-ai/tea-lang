---
title: Time-series calculations
---

## Current values, history and warmup

`close` is the current input value. `close[1]` is the previous committed value of
that binding. A computed expression must first have its own binding:

```tea
midpoint = (high + low) / 2
previousMidpoint = midpoint[1]
emit "previous" previousMidpoint
```

Unavailable numeric history is `na`. A numeric comparison involving missing
values is not evidence that the threshold was crossed. Preserve missingness
until the calculation is meaningful; replacing it with zero changes signals.

The current `ta.sma(source, length)` uses the current sample plus the preceding
`length - 1` samples. It needs a complete window; missing samples in that window
produce a missing average. `ta.highest` and `ta.lowest` also include the current
sample. To compare against _previous_ bars, compute the rolling value every
step and use that result's `[1]` history. `ta.ema` seeds from its first source
value, while `ta.rma` seeds from a window of nonmissing values. Their startup
behavior is not interchangeable.

A requested output window may require earlier input for warmup. The host must
supply those rows; returning only the visible window does not eliminate that
need. State requiring all prior observations cannot be reconstructed from an
arbitrary short sample.

## States and transitions

`close > threshold` is true on every row above the threshold. An upward crossing
requires the current value to be above and the previous value to be at or below.
`ta.crossover` implements that comparison; `ta.crossunder` reverses it. Equality
on the current row is not a cross. Evaluate these helpers each step.

```tea
threshold = input.float(50, "Threshold")
crossed = ta.crossover(close, threshold)
alertcondition("cross", barstate.isconfirmed and crossed, "Cross", "Crossed above threshold")
```

For completed closes `[49, 50, 51, 52, 50, 51]`, only rows 3 and 6 cross.
If the first observed close is already above 50, there is no earlier value that
proves a crossing. Define requirements for first observations explicitly.

## State with a clear update rule

Use persistent state for counts, sequences, cooldowns and remembered levels.
Decide what resets it, when it advances, and whether a prolonged condition
produces one event or an event on every step.

```tea
var int streak = 0
if barstate.isconfirmed
    streak := close > open ? streak + 1 : 0
alertcondition("streak", barstate.isconfirmed and streak == 3, "Streak", "Three bullish closes")
```

This emits on the third bullish close in each streak, not on the fourth and fifth.
`>= 3` would describe a different rule. A nonbullish close resets the streak.

Write independent expected outputs before running a finite scenario. Include
boundaries (equal values and first valid windows), false cases, and repeated
matches. See [execution conformance](../conformance.md) for Tea's own executable
contracts and [memory model](../memory-model.md) for live state semantics.
