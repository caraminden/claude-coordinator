# A budget for every minion

Status: accepted, 2026-11-19 (#1114, F2 from idea minion #1092; Josh picked it and approved the plan that evening).

Every minion gets a budget: the median cost of its type of work on its model family over the last four weeks, every
scheme pooled (`src/minion-budget.ts`). It is never a cap. The grilling round with Josh, the same day:

1. **When the minion is asked**: "2x and past $3". At twice its budget, and never under $3, one line reaches the running
   turn (or the next turn's opening line) asking it to say why it is costing more or to split off what's left. Once per minion.
2. **When its Taskmaster hears**: "4x and past $10". One message to its Taskmaster with the numbers, waking it unless it
   is cold (held mail then). Once per minion. Nothing stops by itself.
3. **The line up front**: "Yes, each turn". Each turn opens with what its kind of work usually costs and what it has used.
4. **What the minion is told**: "Say why, or split".
5. **What people see**: "Chat line + minion page". A chat line at each mark, and "$14 of about $6.50" on the minion's
   page header (amber past the ask). A forecast on the cost page is a separate handoff.

Replayed over the 1,072 minions of the week to Nov 19, each against the three weeks before: the ask fires on about 18%
(which held 48% of that week's spend; plain 2x would fire on 33%), and the wake on about 3% (25 to 33 a week; plain 4x
would be about 120). Medians per scheme or per effort fired on as many, so they stay pooled per type and model family.
A type with fewer than five minions in the window falls back to its family's median; with none, there is no budget.
