# The Skills page and a scheme's kit-skill switch

Status: accepted, 2026-11-19 (#1062, from #1047's sweep of hidden systems: H7 and X3).

Cara asked the sweep to "find other opportunities to codify our processes and surface them to users instead of just having
them be set up in the shadows". The kit's skills and Grunt types loaded for every turn of every scheme, and no page listed them
or how they ran. Josh picked both items on 2026-11-19:

- **H7** ("Add a "build a new skill" option, and also give info on when/where/how these skills are being used, not just what
  they do"): each scheme gets a Skills page in its settings. It lists the kit's skills and Grunt types and the scheme repo's own
  `.claude/skills` and `.claude/agents`, each with its trigger and the last 14 days of use: runs, minions, the minion types it
  ran in, the step of the turn (before any edit, after edits, after an error, before a ship), the Grunts it started, how often
  the minion shipped afterwards, and the last few runs. The counts come from the stored Claude stream (`src/skills.ts`), worked
  out on a worker thread because the window is about 800 MB. A **+ New skill** button starts a minion with an editable brief.
- **X3** ("Make it clear that these are default and highly recommended, but schemes should have autonomy"): every kit skill is
  shown as "Default, recommended", and a scheme can turn any of them off (`projects.skills_off`).

The grilling round with Josh, the same day:

1. **One page or two** with Build 4's Reviewers and critics page (#1050): "sibling pages", linked to each other.
2. **What off means**: the skill is left out of the turn's own kit copy and blocked with a `Skill(citadel:<name>)` deny rule as
   well, for minions and the Taskmaster alike. It applies from each minion's next turn.
3. **Anything locked on**: nothing. Josh: "Maybe add a warning or something, but a scheme should be able to do whatever it
   wants". Turning off a skill with a known cost shows that cost and asks to confirm first.
4. **Grunt types**: listed with their use, with no switch.
5. **Who starts a kit skill**: only the Citadel scheme's members, and starting it is the go. Anyone in a scheme can start one
   for that scheme's own repo.

Cara's Q10 for Build 4's review set (2026-11-19) decides what happens with self-review off: nothing labels a change's risk,
so every ship in that scheme waits for a person's go. The minion prompt says so.

Codex turns aren't pruned: a Codex turn installs its kit into the person's shared Codex home, so pruning one scheme's copy would cut the skill from their other schemes too. The go rule is enforced by the server: with self-review off, `hand_off_land` refuses a ship with no go.
