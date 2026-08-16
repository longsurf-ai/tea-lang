# AliceTears Grid

This is a clean-room Tea implementation of the public open-source
[AliceTears Grid](https://www.tradingview.com/script/6I0p6rPM-AliceTears-Grid/),
revision updated 2025-12-02 and inspected 2026-08-14. No Pine source is copied
here.

The implementation preserves the published two-sided grid, daily-open baseline,
standard and breach/reclaim entries, independently triggered levels, fixed-cash
orders, deep pyramiding, per-entry lots, reversal of an existing opposite
position, standard and reversal profit-taking, optional trailing activation,
per-lot manual stops, commission, signed cash/equity accounting, and maximum
long/short stack tracking. Every open and close emits a standard
`broker.FillExecuted` effect with an unambiguous command id.

The script composes `broker.new(...)`, `portfolio.lots(...)`, and
`strategy.configure(...)`; its per-entry accounting and immediate market-fill
lifecycle are compiler-shipped Tea library code rather than a strategy-local
account. `maximum_open_trades` is the explicit bind-time storage policy. A
command that would exceed it is rejected before a fill is published. This cap
is independent of `maximum_steps`: daily trigger state resets while a lot can
remain open across a session boundary.

Alice-specific exit policy is separate from that accounting. The script owns a
`GridPosition` array keyed by the `tradeId` returned by each successful entry
fill; tag, target, stop, and trailing state live there. Its ordering mirrors the
lot portfolio's push and swap-pop rules, and it changes only after a successful
`entry_now` or `close_trade` fill. The strategy therefore never reads or edits
the portfolio's open-trade records to implement grid policy.

The measured stress config is intentionally not the publication's all-default
input set: it caps each side at five rather than twenty levels, sweeps the
take-profit reversal switch, disables trailing activation, and enables manual
per-lot stops. It fixes the simultaneous-open-trade cap at 100, well above the
three-lot maximum observed in this fixture. It leaves the custom session and
end-of-session close disabled, matching their defaults. UTC day boundaries
over the checked-in 15-minute bars define the baseline and provide a genuine
multi-bar session path. Tea can also express a fixed numeric UTC session;
arbitrary Pine session-string parsing is not part of this profile.
Presentation lines and tables are omitted.

The current dashboard infers entry/exit solely from buy/sell. It therefore
renders a short open (sell) as an exit and a short cover (buy) as an entry; the
engine and command ids remain correct while that visualization schema is
pending an explicit open/close action.

## Measured sweep

```sh
tea execute examples/strategy/alice-grid/sweep.yaml
```

The 8-scenario JavaScript sweep processes 160,000 rows from the SHA-pinned
20,000-bar Binance BTCUSDT 15-minute snapshot and completed in **46.41 s** on
the 2026-08-16 development run. The best scenario returned **0.0015%**, with
**0.54%** maximum drawdown and **428** closed per-entry lots
(`entry_reversal_mode=0`, 1% grid, five levels, standard take-profit). The
published breach/reclaim mode also trades on this intraday fixture; its best
checked result was **-0.12%** after costs.

Runtime measurements vary by machine. This high-event-count example is a
language/runtime stress fixture, not investment advice or a TradingView parity
claim.
