# The weekly Fable cap

Status: accepted, 2026-11-19 (#1061, from #1047's sweep of hidden systems; Josh answered the card the same day).

Before this, the Taskmaster's prompt said Fable tiers start on Opus high "when a person or a usage review says Fable use is over
budget", and no number existed. Josh, 2026-11-19, on #1061's card:

- **Measured in** (Josh: "You should be able to switch between yourself and the whole citadel. Per week usage should be in %
  of weekly caps, overal in API dollars"): the meter on Settings, Usage shows *You* as a share of your own weekly plan, and
  *Whole Citadel* in API dollars. Both read the per-model spend the cost tables already keep.
- **Past the cap** (Josh: "Fable tiers start on Opus high"): while the whole Citadel's Fable dollars in the last 7 days are at or
  over the cap, every Taskmaster's prompt says to start Fable-tier minions on Opus high. It switches back by itself.
- **The number** (Josh: "Should be a function of their weekly plan, lets say the starting cap would be like 20%"): one setting,
  `fable_cap_pct` (default 20), a percent of the weekly plan. The Citadel-wide cap in dollars is that percent of every
  priced account's weekly limit added up (`src/costs.ts`, `fableMeter`). Admins change it on the page.

Until a weekly meter has priced a plan there is no dollar cap, so nothing counts as over. Schemes with Fable off are unaffected.
