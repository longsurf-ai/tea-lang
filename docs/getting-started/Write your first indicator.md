---
title: Write your first indicator
---

A moving average program can also emit an event when the close crosses it.
Write the requirement precisely: a crossing occurs only when the current close
is above the current average and the previous close was at or below the
previous average. Remaining above does not cause another crossing.

```tea
length = input.int(3, "Length", minval=1)
average = ta.sma(close, length)
crossed = ta.crossover(close, average)
plot("average", average, "Moving average")
alertcondition("cross", barstate.isconfirmed and crossed, "Cross", "Close crossed the average")
```

`ta` is automatically available. `plot` and `alertcondition` are automatically
available without a `visual.` prefix. Their first argument is an output ID;
the plot value and alert condition come second. Titles are presentation text.

The `length` parameter is identified by its variable name, not the label
`Length`. The host supplies the input bars and may override that parameter.

With completed closes `[1, 2, 3, 2, 4]`, averages are missing, missing, `2`,
`7/3`, and `3`. Only the fifth row crosses above the average. There is no
previous valid average on the third row. A condition using `barstate.isconfirmed`
excludes provisional attempts on an unfinished bar.

The output is an event value. Its host chooses whether to store it, notify
someone, or ignore it. See [outputs and events](../language-guide/outputs-and-events.md).
