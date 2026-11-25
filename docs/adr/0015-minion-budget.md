# A budget for every minion

Status: accepted, 2026-11-19 (#1114, F2 from idea minion #1092; Josh picked it and approved the plan that evening).

Every minion gets a budget: the median cost of its type of work on its model family over the last four weeks, every
scheme pooled (`src/minion-budget.ts`). It is never a cap. The grilling round with Josh, the same day:

1. **When the minion is asked**: "2x and past $3". At twice its budget, and never under $3, one line reaches the running
   turn (or the next turn's opening line) asking it to say why it is costing more or to split off what's left. Once per minion.
2. **When its Taskmaster hears**: "4x and past $10". One message to its Taskmaster with the numbers, waking it (cold too, since
   ADR 0036 dropped the cold hold). Once per minion. Nothing stops by itself. *Amended 2026-11-22 (#1672, below): again at each doubling.*
3. **The line up front**: "Yes, each turn". Each turn opens with what its kind of work usually costs and what it has used.
4. **What the minion is told**: "Say why, or split".
5. **What people see**: "Chat line + minion page". A chat line at each mark, and "$14 of about $6.50" on the minion's
   page header (amber past the ask). A forecast on the cost page is a separate handoff.

Replayed over the 1,072 minions of the week to Nov 19, each against the three weeks before: the ask fires on about 18%
(which held 48% of that week's spend; plain 2x would fire on 33%), and the wake on about 3% (25 to 33 a week; plain 4x
would be about 120). Medians per scheme or per effort fired on as many, so they stay pooled per type and model family.
Only closed minions count (an open one is still short of its final cost). A type with fewer than five in the window falls
back to its family's median; with none, there is no budget. Codex and other non-Claude models get none: their turns
aren't priced.

## Amendment, 2026-11-22 (#1672): the marks keep firing

On #1605 the ask fired at $9, the one wake at $18 got "carry on, no split", and nothing fired again until Cara noticed at
about $120 ("Why is this taking so much money? did something go wrong?"). On #1668's card she picked "Build it": "the
Taskmaster gets woken again at every doubling, and past 10x the usual (at least $50) you get a card: carry on, split, or
stop. It still never stops anything by itself."

- **The wake repeats** at each doubling of its mark (4x, 8x, 16x…, from the $10 floor for cheap minions), once each; a jump
  past several wakes once. Its text says a carry on lasts only to the next mark, and from the second wake on asks the
  Taskmaster to check the conditions it set last time (#1605's asked for Sonnet Grunts and cost lines; neither happened).
- **The owner's card** at 10x and never under $50, once: to `assigned`, else who asked for it. Carry on and Split reach the
  minion as an answer; Stop stops its turn as the stop button does (the answer is held, so no turn starts).
- The 2x ask and the 4x wake's own thresholds are unchanged. Every mark is a multiple of the budget's usual cost, so a
  brief's own estimate can stand in for it later.
