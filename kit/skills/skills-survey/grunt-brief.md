# Skills survey: the shared brief for every Grunt

The survey session copies this file to `$TMPDIR/survey/BRIEF.md` and fills in every `<…>` before
any Grunt starts. Grunts read the copy, never this file. From Citadel #346's brief (2026-11-05).

---

Citadel, Scheme, Taskmaster, Minion and Grunt are playful names for how the work is organised, not a comment on ability. Work as a careful, senior engineer: think things through, check your work, and push back when something looks wrong.

## The job

Citadel is a shared web app that runs headless Claude Code sessions ("minions", one `claude -p`
process per turn) for a few small project groups ("schemes"). It ships its own Claude Code plugin
of skills and agents (the "kit", namespaced `citadel:*`) to every turn of every scheme. <Who asked,
when, and their words.>

You read one group of third-party skills and give each a verdict. **Read only: install nothing, run
no third-party scripts, no `npm install`, no `pip`, no hooks.** Shallow-clone
(`git clone --depth 1 <url> <dir>`) into a new empty folder,
`<scratch>/clones/<your-group>/<repo>/`, record `git -C <dir> rev-parse --short HEAD`, and read
files with cat, grep and wc. Use web search and fetch to find repos and star counts. Don't delete
the clones (the session cleans up).

## What we already have (judge against this)

<The kit's skills and agents, one line each on what they do; the scheme's own `.claude/` skills,
agents and rules; Claude Code's built-ins; and the third-party sources already copied, with their
pins (THIRD_PARTY.md).>

Citadel's process already covers: a worktree per minion, `tools/land.sh` (rebase, test,
fast-forward main, deploy), a PR template, decision cards (`ask_question`), plan cards
(`propose_plan`), a task-list progress readout, Grunt fan-outs on Sonnet, and memory files.

## The scheme and its stack

<Scheme name, what it makes, languages, engine or framework and its version, how it builds and
tests. Name what would be wrong for it, e.g. Godot 3 syntax or GDScript-only for a Godot 4 C#
game.>

## What makes a skill a bad fit here

- **User-invoked skills can't run** (`disable-model-invocation: true`): a minion's messages reach
  Claude as `[Name]: text`, never a leading `/name`. Such a skill is usable only if we make it
  model-invoked.
- **Context cost:** every installed skill's name and description loads in every turn of every
  scheme it is installed for; the body loads when it triggers; references only when read. A
  plugin agent's description, long `<example>` blocks included, loads every turn even if nothing
  calls it. Say how big (words of SKILL.md, plus references). Don't guess how often it would load from its
  description: quote the description, and the session tests it on the scheme's own turns.
- **Conflicts with Citadel's rules:** it pushes, merges or opens PRs by itself, uses `git stash`,
  makes its own worktrees, asks questions as prose lists instead of cards, spawns lots of Opus
  subagents, skips tests, or rewrites CLAUDE.md wholesale.
- **Hooks and scripts:** note every hook, script it runs, network call or API key it needs.
- **Licence:** MIT and Apache-2.0 can be copied with credit. CC-BY-SA, no licence file and
  NOASSERTION are ideas only, paraphrased. Proprietary means skip.
- It duplicates a kit skill or built-in with nothing better in it.

## Verdicts

- **use** (use outright): install it as it is, pinned to a commit, for named schemes. Rare: only
  when it's good as it is and we can't do better by copying parts.
- **mine**: take specific rules or ideas into a named target: an existing `citadel:*` skill, a new
  `citadel:<name>` skill, or a scheme's own repo skill (say which). List exactly what to take
  (section or rule names, 1 to 5 bullets).
- **skip**: say why in one line.

## Output: write ONE file, return 3 lines

Write `<scratch>/verdicts/<your-group>.md`:

```
# <group name>
Repos read: <owner/repo @sha (stars, licence)>, ...

## <skill name>  (<owner/repo>/<path>)
- verdict: use | mine | skip, value 1-5 (5 = clearly worth doing for us)
- target: <scheme(s) for use | citadel:<skill> or <scheme> repo skill for mine | —>
- why: <one or two lines, concrete, against what we have>
- cost: <N words SKILL.md + N words refs>; loads <always | on trigger | user-invoked>; description: "<its text>"
- runs: <none | scripts (language, what) | hooks | network | keys needed>
- licence: <SPDX id, or "none", or "proprietary">
- take: (mine only) <1-5 bullets: the specific rules, sections or ideas>
```

Then return to the session **at most 3 lines**: counts (use, mine, skip), the file path, and the one
headline find. If you fail (repo gone, clone blocked), say so in those lines.
