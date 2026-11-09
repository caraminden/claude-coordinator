---
name: doc-vs-live
judges: each claim a doc makes about live files (paths, commands, behaviour, numbers, lists), checked against those files
when: "schedule: monthly"
input: one item per doc the scheme's rubric names, with the repo at main checked out for the critic to read
mode: informed
model: sonnet
effort: medium
max_rounds: 1
gate: advisory
---
# Doc vs live

**Starter.** A scheme's rubric `extends: citadel:critique/rubrics/doc-vs-live` and says which docs
it judges and where their live files are. A doc drifts silently: nothing fails when a script gains
a flag or a hook is renamed, and the next agent that reads the doc does the old thing. Threadspace's
handbook fell far behind its live scripts this way.

Each item is one doc. Read it claim by claim, open the live file each claim is about, and give
every finding as `<doc>:<line> → <live file>:<line>: the doc says X; the file does Y`. A scheduled
run reports and fixes nothing (`max_rounds: 1`): people pick which drift to fix from the report.

## Blockers

1. **Paths exist.** Every file, folder, script, skill or agent the doc names exists where it says.
   See it: list or open each one. Seen: none yet.
2. **Commands run as written.** A command the doc gives exists, with the flags and arguments it
   shows (the script's argument parsing or usage text, the package scripts). See it: find each flag
   in the code. Seen: none yet.
3. **Behaviour matches the code.** What the doc says a piece does (when it fires, what it checks or
   refuses, what it writes and where, in what order) is what the code it names does. See it: read
   the code and cite the line that agrees or differs. Seen: none yet.
4. **Numbers match their source.** A default, limit, timeout, count, model, price or date the doc
   gives matches the constant, config or measurement it comes from. See it: grep the code or the
   cited source for the value. Seen: Citadel #50's cost figures were about 5x too high (it summed the
   session's running total, not each turn's), found by Citadel's October 2026 retro.
5. **Lists are whole.** A doc that lists a set ("today's hooks", "the scripts", "every key") names
   every live member and none that are gone. See it: list the folder or registry the set lives in
   and compare both ways. Seen: Threadspace's handbook, far behind the live scripts.
6. **Pointers resolve.** A link or a "see X, section Y" names a file and a heading that exist.
   See it: open the file and find the heading. Seen: none yet.

## Watch-list

- A claim about running state the repo can't show (a live service, the database, another repo, a
  person's machine): a `can't check` note naming what would check it, never a blocker.
- History told as fact ("now does X", "changed from Y"): it goes stale by itself.
- A doc that restates what one command shows (a `--help`, a config file): a copy waiting to drift.
