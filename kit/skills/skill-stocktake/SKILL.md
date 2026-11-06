---
name: skill-stocktake
description: Stocktake of the skills and agents themselves, judging each Keep, Improve, Update, Retire or Merge. Use when asked to audit, prune or stocktake the kit's or a repo's skills (citadel:retro calls it on a misfire).
---

# Skill stocktake

Every skill description loads into every turn of every scheme, so two skills that match one
ask, or one that matches unrelated asks, cost context and cause misfires. A stocktake judges
each skill and writes a report with handoffs. It edits, moves and deletes nothing itself: a
person picks which fixes become minions.

## Steps

1. **Scope.** The report opens with what you scanned, and which of these were absent:
   - the kit's skills and agents (`kit/skills/`, `kit/agents/`), in Citadel's repo only: in
     any other repo the kit is Citadel's to audit, so leave it out;
   - the repo's own `.claude/skills/` and `.claude/agents/`;
   - the rest of your session's available-skills and agent-types lists (Claude Code's
     built-ins, other plugins). Those lists are the real always-loaded set.

2. **Mode.** The last stocktake is the newest `reports/skill-stocktake-*.md` in the scheme's
   shared folder (`$COORDINATOR_SHARED_DIR`); its header names the repo commit it read.
   - **Quick**, the default: the skills a retro or the ask named, plus those changed since that
     commit (`git log --name-only <commit>..HEAD -- kit/skills kit/agents .claude/skills
     .claude/agents`), plus every skill whose description would match the same ask as one of
     those. With no earlier report, only the named ones and their neighbours. Nothing to
     judge: say so and stop.
   - **Full**, when asked, or when nothing is named and there is no earlier report: every
     skill, built-ins included.

3. **Inventory.** One row per skill: description words (loaded every turn), body and
   references-file words (loaded on trigger), and uses in the last 30 days (skill loads and
   agent starts) from `node <this skill's folder>/uses.ts`, which reads this account's
   transcripts across every scheme. The count is a floor: turns in a person's own container
   are missing, and a skill another skill reads by path never shows. A skill for a rare
   moment (a retro, a scheme setup) is meant to be quiet. Low use is a question to raise,
   never a reason to retire on its own.

4. **Judge each skill**, reading it whole with the inventory beside it:
   - **Overlap**: another skill, a built-in, CLAUDE.md or a rules file already says this. Two
     descriptions that would both fire on one ask are a finding even when the bodies differ.
   - **Trigger breadth**: name one ask it should fire on and one near-miss it must not. Firing
     on the near-miss means the description is too broad.
   - **Freshness**: every path, command, tool, flag and `citadel:` name it mentions still
     exists (`ls`, `grep`, `--help`; the THIRD_PARTY.md pin for copied skills).
   - **Actionability**: steps that end on a completion criterion, or reference a session can
     act on.
   - **Unique value**: what a session would do worse without it.
   - **Cost**: the description is as short as its triggers allow, and reference only some
     branches need sits in a references file (citadel:writing-for-agents).

   For a full scan, hand the reading to Grunts in batches of about eight (citadel:subagents
   picks model and effort). Write one brief file in `$TMPDIR` that every batch reads: the
   whole inventory (so each can judge overlap), the built-ins' descriptions, the skills
   handoffs already in flight, and the row format. Each Grunt writes its rows to a file and
   returns three lines. Spot-check the claims a Retire or Merge rests on before you report.

5. **Verdict**, one per skill, with a reason that stands alone:

   | Verdict | When | The reason names |
   |---|---|---|
   | Keep | useful, current, no clash | what it does that nothing else does |
   | Improve | worth keeping, needs a change | the section, the change, the target size |
   | Update | names something that moved, or its upstream pin is behind | each stale reference and its replacement |
   | Retire | no unique value left, or costs more than it gives | the defect, and what covers the need instead |
   | Merge into X | substantial overlap with X | X, and what to carry over |

   Restate the evidence every time: "overlaps with X" or "unchanged" is not a reason.
   Built-ins and other plugins' skills are not ours to edit, so judge them for clashes and put
   the fix on our side: narrow our description, or say in our body when theirs is the right one.

6. **Write it up** in `reports/skill-stocktake-<date>.md` in the shared folder: date, mode,
   repo commit, the scope list, totals (always-loaded words across all descriptions; how many
   skills fired in 30 days), then the table (skill, description words, body words, uses,
   verdict, reason). Group the non-Keep verdicts into handoffs in `handoffs/`, one per minion
   the work should become, and list them at the end.

Done when every scanned skill has a row with a verdict and a standalone reason, every non-Keep
verdict is in a handoff or says why not, and the reply carries the top three findings.
