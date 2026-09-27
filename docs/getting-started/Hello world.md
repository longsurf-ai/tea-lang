---
title: Hello world
---

This program emits one numeric column for each input step:

```tea
emit "spread" high - low
```

For input rows with `(high, low)` equal to `(12, 9)` and `(15, 11)`, the
`spread` outputs are `3` and `4`. Inputs are supplied by the host; the program
contains the calculation, not a data download.

Continue with [your first indicator](./Write%20your%20first%20indicator.md) or the
[language reading guide](../introduction.md).
