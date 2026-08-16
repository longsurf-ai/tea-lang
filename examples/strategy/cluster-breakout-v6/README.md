# Cluster breakout v6

This clean-room implementation models the earlier v6 profile of the open-source
[Cluster Breakout Strategy v6 (Robust)](https://www.tradingview.com/script/DkDNMQsn-Cluster-Breakout-Strategy-v6-Robust/).
That mutable publication page served materially different v8 logic when it was
rechecked on 2026-08-14. This directory therefore treats the independent v6
behavioral contract below—not the page's current source—as its reproducible
authority. No third-party source is copied.

The implemented profile includes ATR-normalized cluster detection, optional
contraction and volume confirmation, buffered two-sided breakouts, strong-close
filtering, fixed-size long and short entries, per-day limits, exit cooldown,
the +1R breakeven stage, +target-R transition to a trailing stop, and the
pre-1R time stop. Persistent stop orders are gap-aware: a bar that opens
through a prior stop fills at the open, otherwise at the stop.

The publication targets intraday markets and defaults to an India-session
window plus end-of-session flattening. The checked-in BTC daily profile uses
the strategy's explicit session-off and EOD-flat-off choices; `session_mode`
and `exit_eod_mode` must both remain zero because Tea does not yet own an
exchange-timezone/session-calendar contract. The trend filter remains a real
parameterized code path but is disabled in the measured profile, matching its
published default. Visual lines, labels, tables, and alerts are omitted.

The strategy composes Tea's canonical `broker.new`, `portfolio.new`, and
`strategy.configure` components. The broker owns same-close entries, persistent
gap-aware stops, and time-close fills; the signed net portfolio owns cash,
position, and P&L accounting. `marginLong=0` and `marginShort=0` preserve the
published fixed-unit profile without a cash-admission gate. Current dashboard
annotations classify every buy as an entry and every sell as an exit, so
short-open and short-cover markers remain visually reversed even though
quantities, cash, and P&L are correct.

The 36-scenario CPU sweep varies cluster length, ATR tightness, breakout buffer,
and strong-close threshold over the SHA-256-pinned BTCUSDT daily snapshot:

```sh
tea execute examples/strategy/cluster-breakout-v6/sweep.yaml
```

Revalidated on 2026-08-16 with `js-f64`, the sweep executed 36 bindings and
118,188 rows. Lowering took 16.49 ms, execution 64,029.12 ms, and reported
total time was 64,045.61 ms. Total return
ranged from -0.047153 to 0.714522, maximum drawdown from 0 to 0.354245, fill
count from 0 to 96, and completed round trips from 0 to 48. Some strict
cluster/filter bindings intentionally produced no trades; that is a valid
result, not a skipped execution.

The highest-return binding was `cluster=12, tightness=2.5, buffer=0.15,
strong-close=0.55`: ending equity 171,452.25, return 0.714522, drawdown
0.108804, 80 fills, and 40 round trips. The lowest-return binding was
`cluster=10, tightness=2.0, buffer=0.15, strong-close=0.65`: ending equity
95,284.67, return -0.047153, drawdown 0.354245, 86 fills, and 43 round trips.
These are descriptive snapshot extrema, not parameter recommendations. This
is a historical runtime fixture, not investment advice.
