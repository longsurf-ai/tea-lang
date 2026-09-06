---
title: Execution Model
---

One runtime step evaluates the entry body against synchronized inputs. Ordinary
functions share the step's transaction while retaining their own written-call
state. Successful execution publishes the row and commits its state; failure
publishes nothing and aborts the attempted changes.

Both `if` and `condition ? left : right` evaluate only the selected branch.
Ternary syntax is compiled to the same conditional IR. Expressions still capture
their operands in source order, including named function arguments.

`var` initializes when execution first reaches its declaration and the binding
is uninitialized. `varip` additionally preserves same-index binding updates.
History reads such as `close[1]` observe the binding's prior committed values.
See [Memory model](../memory-model.md) for reference mutation and provisional
execution details.

Output columns are fixed during compilation and retain declaration order.
A plain emission captures one value; absence and an explicit null both publish
null. An append column starts as an empty list, and its items follow runtime
execution order independently of other columns. Values are detached when emitted,
so later mutations cannot change an earlier emission.

Returning from a function does not publish or commit independently. Main simply
finishes its body; [Runtime](../runtime.md) owns commit and publication mechanics.
