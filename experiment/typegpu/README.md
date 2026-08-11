# TypeGPU backtest experiment

This standalone Node package proves that TypeGPU can express a complete
parameter-swept backtest rather than only element-wise kernels. One TypeGPU
invocation scans one full market series for one SMA pair; a two-dimensional
dispatch covers parameter pairs on `x` and instruments/intervals on `y`.

The experiment uses TypeGPU for all shader authoring and typed GPU resources.
Dawn's `webgpu` package supplies the Node `GPUDevice` and chooses the native
backend automatically (Metal on the tested Mac; Vulkan is not required). There
is no raw WGSL fallback.

## Verdict

TypeGPU 0.11.9 exposes everything this kernel needs:

- runtime storage arrays and typed structs;
- dynamic indexing and long sequential loops;
- two-dimensional compute dispatch;
- atomic sparse-journal allocation;
- injected Dawn devices and command encoders; and
- typed readback/deserialization.

The capability gate and the production backtest both pass. The practical limit
is WebGPU buffer capacity, not a missing TypeGPU feature. A default
`requestDevice()` grants only the portable 128 MiB storage binding, so the
provider requests higher device limits automatically whenever the journal
needs them, up to the adapter maximum (4 GiB on the tested M2 Max). Journal
readback deserializes only the written prefix, so capacity headroom costs GPU
memory but never readback time.

## Runtime

Use Node 22.22.0 (the package accepts Node 22.12+ and rejects other major
versions):

```sh
node --version
npm ci
npm run capability-smoke
npm test
```

TypeGPU 0.11.9's mapped-buffer reader races Dawn cleanup under Node 24/25 when
reads overlap. This package therefore performs its three readbacks sequentially
and pins Node 22. Dawn's owner object is retained until process teardown so all
native wrappers outlive the device.

There is exactly one compute dispatch and one compute submission per sweep.
Summary, event, and journal readback each add a copy-only submission; they do not
launch the kernel again.

## Strategy and exchange contract

Each job uses close-based rolling SMAs and the following deterministic rules:

1. The first fully warmed bar establishes the previous fast/slow values.
2. A buy signal requires `previousFast <= previousSlow && fast > slow`.
3. A sell signal requires `previousFast >= previousSlow && fast < slow`.
4. A signal submits an all-in/all-out market order for the next bar's open.
5. Buys fill at `open * (1 + 1bp)` and sells at `open * (1 - 1bp)`.
6. Every fill pays a 1 bp taker fee on notional.
7. The simulator is fractional, long-only, and has no partial fills, volume
   constraint, leverage, shorting, lot size, or forced final liquidation.
8. A final-bar signal is recorded and expires; an open position is marked at
   the last close.

The GPU reports final equity, return, maximum drawdown, fees, lifecycle counts,
and a sparse journal of every submitted order, fill, and expiration.

## Real BTC data

Download all completed Binance spot BTCUSDT daily and hourly candles from the
venue's first available bar:

```sh
npm run download -- --symbol BTCUSDT --intervals 1d,1h --data-dir data
```

The downloader pages the market-data-only Binance endpoint, validates every
response with Zod, drops the one known zero-duration/zero-volume/zero-trade
sentinel in early hourly history, excludes the current incomplete candle, and
writes content-addressed snapshot manifests. `data/` is intentionally ignored.

The snapshot taken on 2026-08-07 contains:

| Interval | Completed bars | First open (UTC) | SHA-256                                                            |
| -------- | -------------: | ---------------- | ------------------------------------------------------------------ |
| `1d`     |          3,277 | 2017-08-17 00:00 | `941bc0ea599674c98615ad318c8d53d7c6cd63c5071a3a768100fbff57969e26` |
| `1h`     |         78,523 | 2017-08-17 04:00 | `ac5df291b533d3b88534940083ff4a38c38394b2ffa1c5ccf1189180ceb62547` |

## One-dispatch sweep

Event capacity defaults to the derived worst case — the strategy can submit at
most one order per signal-capable bar and each order emits exactly one fill or
expiry, so a valid job never exceeds `2 × (barCount - slowPeriod)` events. A
default run therefore cannot overflow. `--event-capacity` remains available as
an explicit lower bet for grids whose worst case exceeds adapter limits; a
lost bet still hard-fails with `GpuJournalOverflowError` instead of
truncating.

A bounded grid preserves the one-dispatch property with no capacity tuning:

```sh
npm run sweep -- --fast 5:20:5 --slow 30:100:10
```

That real run covered 32 parameter pairs / 64 full-history jobs in one
dispatch, recorded 132,060 events against a derived worst-case capacity of
about 5.2 million (167 MB journal, granted via raised device limits), and took
about 190 ms including packing, pipeline creation, execution, and
prefix-limited sequential readback on the tested machine.

The dense default is fast `5:100:1` crossed with slow `20:300:1`, pruning
`fast >= slow`, for 23,655 parameter pairs and 47,310 jobs across `1d` and
`1h`. Its worst case is about 3.87 billion events (~124 GiB), beyond the
adapter's 4 GiB binding maximum, so the default run fails up front with an
explicit limits error before any dispatch. Passing
`--event-capacity 41100000` (a 1.22 GiB journal granted via raised device
limits) is a sparse-output bet that succeeded on the 2026-08-08 snapshots,
recording 40,994,936 shape-validated events across all 47,310 jobs in one
dispatch, in about 34 seconds end-to-end including the 41-million-event
prefix readback. Trust only shape-validated counts: a bypassed
`assertGpuSweepShape` once let a partially executed dispatch masquerade as a
22.5-million-event success.

Batching the dense grid is the straightforward next step if a worst-case-safe
capacity matters more than a single launch. It is deliberately not hidden in
this experiment: a command never silently changes the requested execution
model.

## Inspectable artifacts

Generate reconciled output for the bounded real grid:

```sh
npm run artifacts -- \
  --fast 5:20:5 \
  --slow 30:100:10 \
  --event-capacity 150000 \
  --output results/btc-real-smoke
```

The successful run writes a complete manifest only after every job and event
passes CPU replay:

- `summaries.ndjson`: every parameter/instrument result;
- `gpu-events.ndjson`: every GPU order/fill/expiration record;
- `orders.ndjson`, `fills.ndjson`, `round-trips.ndjson`: rich exchange records;
- `equity.f32le`: job-major full equity curves; and
- `equity-index.ndjson`: byte offsets and identities for plotting.

For the 64-job run this produced 66,028 orders, 66,025 fills, 32,997 round
trips, and 2,617,568 equity points (10,470,272 binary bytes). Curves are replayed
and written one job at a time, so the complete matrix is never retained in RAM.

The tiny fixture independently runs the strategy on CPU and GPU. On long real
histories, strict `f32` rolling sums can cross one bar apart on CPU and Metal
when the SMAs are almost equal. Real artifacts therefore treat the GPU journal
as the strategy decision record and independently validate its exchange
lifecycle/accounting while building CPU equity. Across the verified real grid,
aggregate replay drift was at most 6 `f32` ULPs; the gate permits 8. Journaled
fill price, quantity, and fee values replayed exactly.

## Multiple instruments

Pass more verified manifests as a comma-separated list:

```sh
npm run sweep -- \
  --manifests data/binance-spot-btcusdt-1d.manifest.json,data/another.manifest.json \
  --fast 5:20:5 --slow 30:100:10 --event-capacity 200000
```

Open/close arrays are concatenated once, and each snapshot contributes an
`{offset, length}` descriptor. No kernel change is needed for additional
instruments or intervals; only data acquisition currently specializes in
Binance spot `1d`/`1h` snapshots.

`npm run benchmark --` accepts the same manifest/grid options plus
`--iterations` and `--engine gpu|cpu` (default `gpu`). Benchmark mode returns
timings and counts but does not implicitly write multi-gigabyte equity
artifacts.

- `--engine gpu` runs the one-dispatch TypeGPU sweep per iteration and reports
  the engine's pack/encode/execution timings. `--event-capacity` applies here
  and defaults to the derived worst case; the report echoes the resolved
  capacity and journal bytes.
- `--engine cpu` runs every job sequentially through the CPU reference engine
  (`runCpuBacktest`) on one thread and reports wall time per iteration. Job
  ordering matches GPU job indexing, boundary parsing happens before the timer
  starts, and `--event-capacity` is rejected because no journal exists. Note
  the CPU engine also materializes full orders/fills/equity artifacts, so its
  time is an upper bound on a summaries-only CPU sweep.

Both engines report `totalBarSteps` (bars × parameter pairs) so runs of
different grids are comparable per bar-step. All CLI commands print indented
JSON to stdout.
