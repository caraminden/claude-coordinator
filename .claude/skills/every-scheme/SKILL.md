---
name: every-scheme
description: >
  Every scheme, or Citadel only? Open before building or changing a feature, rule, setting, tool, notification
  or page that touches running or managing a scheme (minions, cards, releases, lands, Taskmaster, properties,
  schedules, shared folder, contraptions), including a small tweak to one that exists. Also open before adding a
  trigger: a schedule or template, CI alert, webhook or other auto-start.
---

The default is every scheme. Citadel is also one scheme among many, and a feature built keyed to it leaves the
others without (#1002: the Releases land line was reorderable for Citadel's scheme only, and Peek Auras got
nothing). Cara, 2026-11-18: "Anything that could help other schemes like that should generally always be applied
globally"; "Anything that is about the management of a scheme should be deployed Citadel wide."

## 1. Place the change

Citadel-only means the change is about this server itself, and only these are:

- The repo's own pipeline for its own server: `tools/land.sh`, `tools/deploy.sh`, the files in `tools/pipeline-files.txt`, restart and `wake_when_live` on the live head.
- The live checkout: the tripwire's rule on it (`src/tripwire.ts`), `ownScheme()` in `server.ts` (the scheme whose repo holds the running commit), the read-only mount in `src/claude-link.ts`.
- The release track of this server's own deploy (`CITADEL_TARGET` in `src/releases.ts`: rebase, test, restart, live).
- `/backup` (`src/backup.ts`, frozen), the Citadel Taskmaster's read of every scheme, and Citadel-wide admin (global property keys, Citadel-wide instructions, contraption admin: `GLOBAL_OWNER` in `src/properties.ts`).

Everything else, and every doubt, is every scheme. A part of a feature can be Citadel-only while the rest is shared: split it there, and give the shared part a reader that works for any scheme id (the way `TargetFinder` serves the others beside `CitadelServer`).

*Done when* each changed behaviour is filed as "every scheme" or as one bullet above, and the Citadel-only ones name it.

## 2. Build it where "every scheme" lives

- **Code**: key on the ticket's or viewer's `project_id`, never on `p.name === 'Citadel'`, `ownScheme()` or `GLOBAL_OWNER` unless §1 says it is Citadel-only. A setting a scheme can have is a per-scheme row or property, with Citadel-wide as the fallback.
- **Rules for agents**: Citadel-wide instructions (Settings, `edit_instructions` scope `citadel`) reach every scheme; scheme instructions reach one. A rule about running a scheme goes Citadel-wide.
- **Skills**: `kit/skills/` and `kit/agents/` load in every scheme (and a kit skill names no repo's paths); `.claude/skills/` and `.claude/rules/` load in Citadel's repo only. A skill about running a scheme goes in the kit (this one is repo-local only because it is about building Citadel's code).
- **Tool and prompt text**: `src/mcp.ts` descriptions and `src/prompts.ts` are every scheme's. Words like "Citadel's" or a Citadel path in them mislead other schemes' minions.
- **Pages**: `public/` shows a scheme's pages from its own data. A control behind `own`, `buildPreviews` or a scheme name is a Citadel-only control: §1 must name it.

*Done when* a grep of your diff for `'Citadel'`, `ownScheme`, `CITADEL_TARGET` and `GLOBAL_OWNER` finds only uses §1 names.

## 3. Test in another scheme

Before ready, run the change as a scheme other than Citadel: a test that uses another scheme's project id, or a dev copy (`citadel-dev-copy`) seeded with a second scheme, and look at the page or call the tool there. Put the scheme you used in the ready note. A Citadel-only part says "Citadel-only: <bullet>" in the note instead.

*Done when* the ready note names the non-Citadel scheme you ran it in, or the §1 bullet that makes it Citadel-only.

## 4. Five questions before a new trigger

A trigger is anything that starts minions or work without a person: a schedule (a clock, or a count such as "N ships since the last run"), a CI alert, a webhook, an auto-start. Answer these in the PR or the brief, one line each, before building it:

1. **What starts it?** Name the event, the time, or the count and the line it crosses.
2. **What does it read and write?** Name the rows, files and channels, and which of them its own output changes.
3. **What does it start next?** Follow the chain until it ends. A chain that can reach its own start is a loop.
4. **Where does a person come back in?** Name the card, note or hold that hands the result to someone.
5. **What stops two runs doing the same work?** Name the guard: a lock, a claim, a "last run" mark moved when the run begins, not when it ends. For a trigger that files minions or tickets, also name what stops it filing the same one twice (search open ones first; the key it dedupes on). A count trigger resets its count at the start of a run, so a crossing fires once.

Then: start a new trigger at a slow rate (a long interval or a high count) and tighten it once its runs look right. This is the trigger's own rate; people's minion starts are never throttled. Cap any retry loop at a few tries, then hand it to a person.

Why: the 2026-11-20 duplicate flake minions came from automatic starts with no answer to question 5.

*Done when* all five answers sit in the PR or brief, and question 5's names a guard a test or a read of the code can confirm.
