---
title: Live trading
---

Tea consumes streams and emits values. A live application supplies the data,
executes the program and decides what an event means outside the language.
The `broker`, `portfolio` and `trade` libraries model trading state in Tea;
importing them does not connect an exchange or submit an external order.

Start with the [execution model](../language-guide/execution-model.md) and
[memory model](../memory-model.md). Historical finalized steps and live
provisional attempts use the same program, but provisional attempts can roll
back. Use `barstate.isconfirmed` when a signal must wait for a completed bar.
See [outputs and events](../language-guide/outputs-and-events.md) for event code.

For multiple streams, read [requests](../requests.md): the host binds each
named child and delivers its data in the documented event-time order. Do not
assume a higher-timeframe value is a finalized candle merely because it is
available at a parent timestamp.

Verify numerical results and event conditions over finite inputs first. Then
exercise provisional updates, finalization and stream failures in the host.
Historical success alone does not establish live delivery, notification
deduplication, external order execution, or recovery after reconnection.
Those contracts belong to the integrating application.
