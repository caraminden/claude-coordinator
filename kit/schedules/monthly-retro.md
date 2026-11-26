---
name: Monthly retro
type: research
model: claude-opus-5-5
effort: medium
trigger: 600 minions
min_minions: 40
cron: 0 7 1,16 * *
stagger: 1d within 12d
applies: the scheme has minions working in it (any repo: the retro is about how the work went, not the code)
---
Retro for {scheme}: how the work since the last retro went, by citadel:retro. Cara (2026-11-15) picked a monthly retro for each busy scheme, because milestone retros never ran here (move-fast work has no milestone PRs). Cara (2026-11-23) picked "Lower it to 40" for the gate: at 150 none had run, and only the four busiest schemes would ever clear it.

Read these, one Sonnet Grunt per source. Each Grunt returns counts and minion numbers, never transcripts.
1. This scheme's retro log since the last retro (retro-log/<date>/*.md in its shared folder), especially:
   - the "process" lines (self-review's Process: notes);
   - refusals and refused stops;
   - land conflicts.
2. Citadel's process digests since then that cover this scheme, and their "Fix scoreboard" tables: {citadel_shared}/reports/process-digest-*.md (read them in place).
3. The last retro and the ledger, in the retro folder CLAUDE.md's Project facts name (docs/retros/ if none). Its fixes are what this retro checks.
4. People's corrections in this scheme's chats over the window (strikes, "no", "I said", "again").

Then follow citadel:retro's steps:
1. Write <YYYY-MM>.md in that retro folder.
2. Update the ledger, the folder's README.md: mistakes more than one retro found, and what now stops each.
3. Make the few edits the retro calls for in this scheme's own skills, rules and docs, after citadel:self-review, by this scheme's usual landing route.
4. A fix for the Citadel kit, the tripwire or Citadel's prompts goes in a handoff in this scheme's handoffs/, named handoff-citadel-<slug>.md; message your Taskmaster its path to pass on to Citadel.
5. End with one multi-select ask_question card, one option per handoff you wrote for this scheme's repo, each with its `start` (handoff path, title, type, model, effort) and your recommendation marked (pair a lone one with "None of these"); link the card in your reply, start none yourself, and stay open in state ready until it is answered. A handoff for another scheme's repo gets no option: its path goes only to your Taskmaster, and a run with no option posts no card.

Reply with the top three findings and what landed (commit and risk label), linking the retro. With no card, stay open in state complete, with the retro named in the note; the server closes it once a member has seen it.
