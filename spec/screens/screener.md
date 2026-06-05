# Screener Tab — RETIRED (folded into Watchlist)

> **Retired 2026-06-05.** The standalone Screener tab is gone. Its two ranked lists ("Intraday" / "Swing") now render as **Upside-curated virtual lists inside the Watchlist screen** — see `watchlist.md` → Upside-curated virtual lists. Bottom nav stays three tabs (Portfolio · Watchlist · Settings).

Everything functional carried over: the two ranked leaderboards, the rolling-30d hit-rate column, the walking-band chip, and the set-marker / add-to-my-list affordances.

The three-trait **accordion** shape (the original Batch S4 design — one vertical section per trait) is dropped. The traits themselves survive as **reason chips** on the virtual-list rows (`dip` / `catalyst` / `post-earnings`), and `catalyst_reversal` + `post_earnings_drift` event names are unioned into the lists rather than living in their own sections — see `../signals/screener-universe.md` (traits) + `../signals/dip-bounce-scorer.md` → Feeding the virtual lists.

This file is kept as a redirect for older cross-references. The live FE design is in `watchlist.md`; the data model is `../signals/curated-list.md` + `../signals/dip-bounce-scorer.md`.
