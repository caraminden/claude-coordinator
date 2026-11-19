---
name: every-scheme
description: >
  Every scheme, or Citadel only? Open before building or changing a feature, rule, setting, tool, notification
  or page that touches running or managing a scheme (minions, cards, releases, lands, Taskmaster, properties,
  schedules, shared folder, contraptions), including a small tweak to one that exists.
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
- **Skills**: `kit/skills/` and `kit/agents/` load in every scheme (and a kit skill names no repo's paths); `.claude/skills/` and `.claude/rules/` load in Citadel's repo only. A skill about running a scheme goes in the kit.
- **Tool and prompt text**: `src/mcp.ts` descriptions and `src/prompts.ts` are every scheme's. Words like "Citadel's" or a Citadel path in them mislead other schemes' minions.
- **Pages**: `public/` shows a scheme's pages from its own data. A control behind `own`, `buildPreviews` or a scheme name is a Citadel-only control: §1 must name it.

*Done when* a grep of your diff for `'Citadel'`, `ownScheme`, `CITADEL_TARGET` and `GLOBAL_OWNER` finds only uses §1 names.

## 3. Test in another scheme

Before ready, run the change as a scheme other than Citadel: a test that uses another scheme's project id, or a dev copy (`citadel-dev-copy`) seeded with a second scheme, and look at the page or call the tool there. Put the scheme you used in the ready note. A Citadel-only part says "Citadel-only: <bullet>" in the note instead.

*Done when* the ready note names the non-Citadel scheme you ran it in, or the §1 bullet that makes it Citadel-only.
