---
name: Ship lessons
type: research
model: claude-sonnet-5-5
effort: medium
cron: 0 15 * * 1
stagger: 10m within 120m
applies: the scheme ships minions' work; Citadel adds it by itself when a ship first logs lines (hand_off_land's learned, or log_learned)
---
Weekly pass over {scheme}'s ship lessons: the up-to-three lines each minion wrote at ship about what its brief or the docs didn't tell it, and which tool, rule or skill got in its way (Josh added that half on 2026-11-19, from Peek Auras' idea Z7). Josh (2026-11-19) picked this so what one minion learned the hard way stops dying with it: anything said twice becomes a proposed doc, skill or brief edit. Citadel skips the run, at no cost, in a week with no new lines.

If list_schedules shows another schedule in this scheme that already turns ship lessons into edits (the memory curator, once it reads this queue), say so in one line and close: that one does this job.

1. Read the open lines with ship_lessons (its default 60 days). Each has its lesson id, the minion's #N, the date and the files it touched. *Done when* you have every open line.
2. Group the lines that say the same thing: the same fact, path, command or gotcha, in any words. The files help: two lines about the same area often mean the same gap. A line that names a tool, rule or skill that got in the way groups with others naming the same one. A repeat is a group with lines from two or more different minions. *Done when* every line is in a group or stands alone.
3. For each repeat, find where the missing fact belongs, or the tool, rule or skill that got in the way, and read it there first: a doc, a skill, a rule, CLAUDE.md's Project facts, a brief template, or a tool's description. If it is already written there, the gap is the pointer to it: propose sharpening that pointer instead. Write the edit as the exact line to add or change, and where. *Done when* each repeat has one edit, or a note that it needs none.
4. Post one ask_question card, multiSelect, with one option per edit: what minions kept having to find out, in plain words, and the change that fixes it. Mark the ones worth making as recommended. No repeats: post no card; mark nothing, and close quietly.
5. When the picks arrive, make the picked edits that live in this scheme's own repo (its docs, rules, skills, CLAUDE.md) after citadel:self-review, by this scheme's usual shipping route. An edit to the Citadel kit, Citadel's prompts or tool text goes in a handoff in this scheme's handoffs/ named handoff-citadel-<slug>.md, by citadel:briefing; message your Taskmaster its path to pass on. *Done when* each pick is shipped or handed off.
6. Mark the lines handled with ship_lessons take: those in a picked edit with note "proposed: <where it went>", those in an edit not picked with "dropped: not picked <date>". Lines that stand alone stay open, so a repeat next week still finds them.

Read only this scheme's queue, and copy no line into another scheme. Reply with the repeats found and what shipped or was handed off; then close.
