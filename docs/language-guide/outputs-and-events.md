---
title: Outputs and events
---

## Stable output identity

`emit "id" value` writes one named column. IDs and column types are fixed at
compilation. A plain column allows one writer; conditionally absent writes
publish null. `emit.append "id" value` collects zero or more values each step,
starting from an empty list. Emissions capture the value at that instant.

Visual helpers follow this same output model. `plot("price", close, "Price")`
returns and emits a plot description. Its ID is `price`; its title is `Price`.
Consult [visual declarations](../reference/libraries/visual.md) for exact options.

## Alert events

`alertcondition(id, condition, title, message)` uses compile-time title and
message text. Every true call appends an event; false appends nothing. A true
state across three steps produces three events. For transitions, compute the
transition explicitly. Gate with `barstate.isconfirmed` when the requirement
says to evaluate at bar close.

```tea
threshold = input.float(50, "Threshold")
crossed = ta.crossover(close, threshold)
alertcondition("cross", barstate.isconfirmed and crossed, "Price cross", "Price crossed threshold")
```

An event does not send a notification, persist an alert rule, or create a chart.
Those are host responsibilities.

## Dynamic text and typed payloads

Use `alert(id, condition, title, message, data)` for changing text or a payload.
The payload is a user-defined struct; its fields keep their declared types.

```tea
struct Move
    string symbol
    float price

above = close > 50
alert("move", barstate.isconfirmed and above, "Price above 50", "Observed price " + str.tostring(close), Move.new(syminfo.ticker, close))
```

Several calls may append to one output ID if their payload type is identical.
Different payload types need different columns. Each event carries its own
subject data; a multi-symbol program should include the symbol in the payload.
The host chooses which final or provisional outputs to retain and deliver.
