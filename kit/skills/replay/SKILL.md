---
name: replay
description: Rerun kept real app chats against a change to a contraption's in-app agent (its prompt, its tools, or what it tells players), with a blind critic judging each pair, to prove the change didn't make real chats worse. Use when a person asks, and once before shipping a big change to an app agent's prompt or tools; never for small edits, per fix round, or from self-review on its own.
---

# Replay real chats against a prompt change

A contraption's turns sent with `keep: true` keep their session's first five turns: what the player
typed, the agent's tool calls with their results, and its reply (Citadel #836). `citadel-replay`
reruns a few of those chats twice, once on the agent's current system text and once on yours, with
both runs' tool calls answered from the recording. A `citadel:critic` Grunt then reads each pair as
X and Y, blind to which side is new.

**It costs usage.** Each kept turn runs twice on your own plan: 5 chats of 5 turns is 50 Claude
turns. Cara, 2026-11-16: "be judicious about when to leverage this replay". So:

- Run it only when a person asks, or once for a big change to an agent's prompt or tools, after the
  change is otherwise done. Fix what it finds, then ship: don't replay again for each fix round
  unless a person asks.
- Keep the default 5 chats. The script refuses over 60 Claude turns without `--over-cap`, which
  takes a person's ask.

## Privacy

Kept chats are players' own words. Read them in place and keep everything made from them (the
outcome files, the key, your report) inside the scheme: your temp folder, your own chat and its
report. Never quote them in a commit, a PR, an issue, a code comment, another scheme or a log. Delete
the outcome folder and key when you're done. A player who opts out in Settings → Your account has
their kept chats deleted, and none are kept from then on.

## 1. Find the chats and the two prompts

- **Chats:** `<scheme shared folder>/.replay/<app>/`, one `.jsonl` file per session (the shared
  folder is `/home/…/projects/<scheme id>/shared/project`, among your working directories). It is a
  dot folder: the Files view doesn't list it. None there means the app doesn't send `keep: true` on
  its turns yet, or nobody has played since: say so and stop.
- **Old and new system text:** the exact `system` the app's server sends on a turn, for `main` and for
  your branch, each in a file in `$TMPDIR`. If the app builds it from parts, run its own builder on
  both versions rather than copying one file. The script warns when the chats ran on another
  "old" (an earlier version): the comparison still holds, because both sides rerun.
- **Tools (only for a tool change):** by default the fake servers offer only the tools the chat
  called. When your change adds, renames or redescribes tools, pass each version's tool list:
  `--tools old-tools.json --tools-new new-tools.json`, each `{ "<server name>": [<tools/list
  result's tools>] }`. `--mcp <server>=<url>` sends a server's calls to the app's own replay server
  instead of the stub, if it has one.

## 2. Run it

```sh
citadel-replay run --chats <dir> --old "$TMPDIR/old.md" --new "$TMPDIR/new.md" --out "$TMPDIR/replay"
```

It prints the turn count first. Then it runs 3 sides at once (`--parallel`), each in a fresh
session in a temp folder whose transcript it deletes. `--model` overrides the recorded model. A run
of 50 turns takes a while: start it in the background and wait with `citadel-wait pid <pid>`.

It writes `chat-1.md` … `chat-N.md` to `--out`. Each holds the player's words per turn, outcome X,
outcome Y, and "Originally". The key, which side was new, is in `<out>.key.json`, outside the
folder. Don't open it until the verdicts are in.

## 3. The blind critic

One `citadel:critic` Grunt reads all the chats (`citadel:subagents` for its model; the rubric says
sonnet). The rubric is the scheme's own replay rubric if its review set (the turn's "Review set:" folder)
has one that `extends: citadel:critique/rubrics/replay`. Otherwise use the starter itself,
`<kit>/skills/critique/rubrics/replay.md` (`<kit>` is two folders up from this skill's base
directory). The brief holds:

- the Grunt line from your system prompt, quoted whole;
- the rubric's path, and the outcome folder's path, and nothing else to read: not the key, not
  your diff, not the prompts, not which side you expect to win;
- the ask: per chat, `chat-N: X worse | Y worse | same`, then at most 2 findings for the worse
  one, each quoting the player's line and the outcome's words it rests on.

One pass. If a verdict looks wrong to you, say so in the report next to it; don't re-brief the
critic to get another answer.

## 4. Unblind and report

Read the key, map each verdict to old or new, and report in your chat:

- one line: `new worse on <n> of <N> chats, old worse on <m>, same on <k>`;
- per chat where the new prompt is worse: the player's words, what the new outcome did against
  the old one, and the critic's finding.

Fix real regressions in your change. A regression you leave, say why. Then delete the out
folder and the key.
