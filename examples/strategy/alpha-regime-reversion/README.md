# Alpha Regime Reversion — Swing Core + Dip

This is a clean-room Tea implementation of the explicitly published
**Swing Core + Dip** profile from
[Alpha Regime Reversion Pro v2 by Safi](https://www.tradingview.com/script/JdCTLj7S-Alpha-Regime-Reversion-Pro-by-Saf/),
published 2026-07-27 and inspected 2026-08-14. No Pine source is copied here.

The profile is long-only by design. It preserves the chart and QQQ 200-bar
regime gates, entry/exit buffers, dollar-liquidity gate, fast/slow trend test,
deep and shallow RSI dip states, rebound/timeout reset, core-versus-dip target
allocations, 5%-increment rounding, account-risk cap, incremental buys,
partial reductions, weighted cost, next-open fills, emergency stop, cooldown,
fees, one-tick adverse slippage, and standard `broker.FillExecuted` effects.
Its two RSI streams use strategy-local SMA-seeded Wilder state to match Pine's
`ta.rsi` initialization without changing Tea's shared indicator contract.
Target-percent rebalances, partial reductions, weighted accounting, and the
resting emergency stop run through Tea's canonical `trade.ohlc`, `broker`, and
`portfolio` components; the example owns only the published signal state.

The publication's separate Intraday Reversion profile is not selected here:
the checked-in fixture is daily and cannot supply its 09:30–16:00 session
bars. Display tables, labels, and alert-message formatting are presentation,
not trading behavior.

## Data and measured sweep

The primary Binance BTCUSDT daily series is checked in and SHA-pinned. The QQQ
macro regime is intrinsic to this profile and is resolved through Tea's Yahoo
provider at runtime, so this sweep requires network access. Yahoo's unofficial
current history is not hash-pinned; exact results can change if that upstream
history changes. The config supplies BTCUSDT's `0.01` tick size, so the
published `slippage=1` setting is modeled as exactly one adverse tick. Applying
a stock/ETF profile to BTC is intentional compiler/runtime stress, not a claim
about the author's published market.

```sh
tea execute examples/strategy/alpha-regime-reversion/sweep.yaml
```

The 16-scenario JavaScript sweep processes 52,528 primary rows plus the QQQ
request context. On the 2026-08-16 canonical-component migration run its
reported execution completed in **70.35 s**. Total return ranged from
**35.38% to 211.70%**, maximum drawdown from **27.51% to 43.97%**, and
completed round trips from **22 to 57**. The best-return scenario produced
**211.70%**, with **38.36%** maximum drawdown and **23** completed round trips
(`core_allocation=50`, fast EMA 15, deep RSI 20, 10% emergency stop). The large
return and drawdown are exactly why this result must be treated as a stress
fixture rather than an investment conclusion.

Runtime measurements vary by machine. This is not investment advice or a
TradingView parity claim.
