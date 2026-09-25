---
title: Live scanner
---

## Emit typed occurrences

`alertcondition(id, condition, title, message)` emits the original
`visual.Alert` with constant text. For an occurrence carrying source data,
`alert(id, condition, title, message, data)` accepts a user-defined struct:

```tea
struct Signal
    string symbol
    float change

change = ta.roc(close, 1)
alert("moves", math.abs(change) >= 2, "Price move", "One-bar change",
    Signal.new(syminfo.ticker, change))
```

Each call whose condition is true appends one `visual.AlertEvent<Signal>`
containing `title`, `message`, and its own typed `data`. A false condition
appends nothing. Several calls may share a column if their payload type is
identical. Each execution attempt replaces that step's list, including live
provisional attempts; the host decides which attempts to record or deliver.
Tea itself sends no notifications and performs no persistence or network IO.

The helper's private, empty marker interface accepts ordinary structs without
requiring special methods. Payload fields retain their Arrow types. Hosts that
save JSON must reject or deliberately handle non-JSON values such as numeric
missingness; Tea does not silently coerce them.

A fixed multi-instrument scan uses named, top-level
[requests](../requests.md), with a host-bound DataStream for every request.
Dynamic symbol lists and request creation during execution are unsupported.
