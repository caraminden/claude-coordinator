---
name: cabal
description: "Leading a cabal as its Overseer: the roster, starting members, routing fixes, a build's branch and go card. Use when you are a cabal's Overseer."
---

# Leading a cabal

A **cabal** is a group of minions working toward one aim under one lead, its **Overseer**. A **build cabal** has a
branch `build/<n>` its members merge into, and ships to main once; a **goal cabal** has none, and each member ships
to live itself. You are one cabal's Overseer: name yourself by it ("Build 8's Overseer", "the docs sweep's Overseer"),
never "the Overseer" alone. Code keeps `lead`, `build_owner` and `cabal`.

Your record is the **board** (`cabal_board`), not your chat: the roster with each member's state, merges, claims, spend
and risk read from facts, members' notes and asks, your log and the red-run line. People read it in place of your chat,
and your next shift starts from it. Put each decision on the log (who decided, quoted, with the time) as you make it.

At every wake, `cabal_board` read comes first. Then handle, in this order: people's messages, the red line, blocking
asks, merges since your last wake, then every other open ask, answered together.

## 1. Forming (your first turn)

1. Split the work into pieces. Where the brief leaves forks open, grill first (`citadel:grilling`). Size it the way
   Build 5 found works: about four lanes that never wait on each other, no two members writing one file, and a member
   per piece a fresh minion can finish (see `citadel:briefing` for a piece's size and model, and its one-slice-first
   rule for a split behind a new gate: `cabal_start` only that slice's row and hold the others, with no `after` on it).
2. Write a handoff per piece with `citadel:briefing`, in the shared folder's `handoffs/`.
3. Add one roster row per piece (`cabal_board` row): label (T1, M2), title, lane, what it waits on (`after`), the files
   it expects to touch, handoff path, model, effort and expected cost. A row for a member in another scheme names it
   with `scheme`. Add a **fixer** row (`role: fixer`, a handoff that says "takes small fixes across the cabal, one at a
   time, from <your cabal>'s Overseer"): it is started only once a fix needs it.
4. Post the **forming card**: `cabal_board` form, with a width (default 4: members at work at once). Link the card in
   your reply. People's go approves the whole roster; end the turn and wait for it.
5. A build cabal (you were made with `build_owner`, your prompt names the build): make the branch first (section 4,
   step 1), so members start from it.

*Done when* every piece has an approved row with a handoff, and the card's go is in.

## 2. Starting and running members

- Start each approved row with `cabal_start` (`message_taskmaster` for a row in another scheme: that scheme's
  Taskmaster starts it on its own people's go). Start every row whose `after` is met; past your width it waits as
  next up and starts by itself. Members chained on another's work start when it is in.
- A piece people didn't approve (a new row, a changed handoff, model or cost) goes on a new forming card. Never start
  around one.
- Unseal, stop or reseal your own members with `cabal_member`; everything outside the cabal stays the Taskmaster's
  (`message_coordinator`).
- Asks: a member's non-blocking ask is held mail. Answer them together at your next wake (`cabal_board` answer). A
  blocking one woke you: answer it first. A claim to move is an ask too (section 4).
  - **Settled** by the build's spec, its decisions log or a person's earlier pick: answer it yourself on the board and
    quote the source. These stay off people's cards.
  - **Silent**, or the answer would bend or reverse a person's pick: ask people on a card (`ask_question`, `to` the
    build's requester, your pick marked). The asking member waits on it and the others carry on. Put the answer in the
    spec's decisions log, quoted and dated, and on the board.
- If no member has made progress (a merge, a ship, a note) for 3 days, ask people with a card: carry on, cut the
  roster, or close the cabal.

## 3. Routing a fix

A red run, a review finding or a person's report on a member's work goes, in this order, to:

1. **its maker**, if it is still open: `message_minion`, with the red test or finding and how to reproduce it;
2. **the fixer**, otherwise (a maker that merged and closed counts): start the fixer row if it isn't running, then
   message it the fix;
3. **you**, only for a merge conflict or a fix of about 20 lines or fewer.

Set the red line (`cabal_board` red) while a full run is red, and clear it once green, logging who fixed it. Your context is the cabal's
most expensive: a fix past 20 lines in it costs more than the same fix in a fresh member.

## 4. A build cabal's branch

Your build is `build/<n>`. In a container, each `tools/land.sh` below is the land tool, with into, full or build.

1. **Make the branch** from main first (`git branch build/<n> main`) if your prompt says it isn't there: it switches
   the build on, and members start from it.
2. **Plan the claims** before members start: `build-claims.md` at the top of `build/<n>`, a line `build: #<your
   number>`, then one line per member, `#N: <the files it writes>` (paths separated by spaces; a folder ends in /; no
   path in two claims), and `shared: <hub files>` for files several members add to, which take only added lines.
   Add each member's line as `cabal_start` gives its number, before its first merge.
   Commit it on your branch and merge it in with `tools/land.sh --into build/<n>` (docs only, so no test files).
   `--into` refuses a member's merge that writes outside its claim; a member that needs another's file asks you on
   the board, and you move the claim the same way.
3. **A full run, once no member is still merging.** Each time members merge in and none is still landing into
   `build/<n>` (a full run queued behind one is refused at rebase): commit, `git merge --ff-only build/<n>`, then
   `tools/land.sh --into build/<n> --full` (a member's own merge runs only the test files it touched, so a red in any
   other file shows only here). Batch them: one full run for every merge since the last, never one per merge. On a
   red, find which merge since the last green run caused it and route it (section 3).
4. **Take main in** once a day and right before shipping: commit, `git merge --ff-only build/<n>`, then the scheme's
   main-merge step (Citadel's is `tools/citadel-node tools/ship-numbers.ts take main`: `git merge main` with the
   build's new SCHEMA_HISTORY lines moved after main's; merge, never rebase, since a rebase changes members' commit
   hashes), resolve, then `tools/land.sh --into build/<n> --full`. If it exits 75, no CI runner took its run: call
   `wake_when_runners_back`, set state sealed and end your turn.
5. **Ship the build** once every member's row shows merged: take main in one last time, self-review the whole diff
   against main with a claude-fable-5-2 reviewer at medium effort, label the build with the highest of its members'
   labels and that review's, `git rm build-claims.md` and merge that into `build/<n>` (`--build` refuses while it is
   there), and post one go card (ask_question, kind merge) with the roster, the label and what wasn't verified,
   whatever the label, and the calls you made yourself from the spec and picks, so people can send any
   back. On the go, run `tools/land.sh --build` from your worktree with your branch at the build's tip:
   one CI run, one deploy. Stay open for the retro (section 7): the land tool takes `stay_open: true` with
   `waiting_on: "the cabal retro"`; after a `land.sh` you ran yourself, call `wake_when_live`.

A member in another scheme ships to its own main, never into your build. When it must not go live first, seal it with
`message_taskmaster` seal, and unseal it once the build is live.

## 5. A goal cabal's ships

Each member ships to live itself, as any minion does. Watch the board: reorder where one member's work needs
another's first (members list their files; the board flags a file two rows list, so settle who goes first on the log),
and catch a member stuck in the ship line. Nothing merges into you.

## 6. Shift changes

The server starts you a fresh session when your context grows past its limit; its message says what to put on the
board and in your handoff. After one, open this skill again and read the board before acting.

## 7. Closing

A cabal gets **one retro**, yours; no separate build retro, and the server starts no effort retro for it.

- **When:** a build cabal once its build is live; a goal cabal once every member is dismissed (Citadel wakes you then;
  if your last open rows were removed instead, write it without waiting).
- **Retro:** run `citadel:retro` over the cabal from `cabal_board` timeline: starts, merges or ships, asks and how long
  they waited, reds and who fixed them, and each member's spend against expected. Add members' chats, `process`
  retro-log lines and the diff only where the timeline raises a question. A build cabal's also says whether the claims
  helped (refusals, moved claims, conflicts they missed). Write `cabal-<slug>.md` in the retro folder CLAUDE.md's
  Project facts name (the retro skill's default otherwise), linking the board by the address on the timeline's first
  line, and ship it by the scheme's usual route for a doc change (a build cabal's lead: straight to main now). Then
  log `Retro: <its path>` on the board: a cabal whose lead is dismissed without that line gets the server's effort
  retro instead.
- **Then close:** every open ask answered, the log's last line says how it ended, and your handoffs deleted from the
  shared folder. The board stays, read-only. A retro that posts a start card keeps you open until it is answered.
- A member closes as "merged into Build <n>" in a build cabal, as today.

## In every scheme

A scheme's Builds setting (Minion rules, `builds`) governs build cabals: with it off, its Taskmaster suggests none,
and only goal cabals run there. The board, `cabal_start` and the claims check are the same in every scheme.
