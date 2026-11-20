# Kit files sync themselves

Status: accepted, 2026-11-19 (#1100, option C of #601's spec on top of option A; evidence in the shared folder's
`reports/scheme-onboarding-review-2026-11.md`, section 3).

Every scheme copies four of the kit's scheme-setup templates: `land.sh` byte for byte, and `guard.sh`, `pre-push` and
`ponytail.md` adapted to the scheme (its protected branch names, ponytail's `paths:` and "In this repo" section, a PR
scheme's wording). Until now a template change made deploy.sh ask the Taskmaster for one sync minion per drifted scheme:
42 minions and about $104 between 2026-11-06 and 2026-11-19. Josh picked "Kit files sync themselves" on #1097's card
(2026-11-19).

## Decision

The server makes the syncs itself (`src/kit-sync.ts`), with no minion turns:

- **When.** On boot and every 10 minutes it compares the four templates at the live checkout's HEAD with the set the last
  round started from (a kit-only deploy may not restart the server). A change starts a round; a newer change supersedes
  an open round (its cards settle, its branches go), but never while one of its ships runs.
- **A 3-way merge, not a copy.** The base is the kit version the scheme's copy came from: the `Kit-Sync: <kit commit>`
  trailer on the newest commit touching the file (every sync writes one), else the past template version equal to the
  copy, else the closest by lines (a tie goes to the older one, so an unplaceable kit change shows as a conflict). A merge
  that gives back the scheme's file is nothing to do, so no skip list is needed; a conflict makes no branch for that
  scheme and leaves held mail for its Taskmaster. Schemes with no `tools/land.sh` (they ship by pull request) are listed
  on the card only.
- **The check.** In a worktree of its own (`projects/<n>/kit-sync`, branch `kit-sync/<kit short>`, not `land/…`, which
  land.sh uses for CI scratch): `bash -n tools/land.sh`, `tools/guard.sh --self-test` when guard.sh changed, then the
  scheme's `SMOKE_CMD`, else its `CHECK`, as a host job. The quick check, not the full one: land.sh runs CHECK and CI
  again on the ship, and FuckSpamTexts' CHECK is a full gradle build. A red check leaves held mail with the tail for that
  scheme's Taskmaster.
- **One go on Citadel's side.** Josh, 2026-11-19, on the card asking one go or one per scheme: "One go on Citadel's side",
  and "If you can, do it on citadels side, but if you cant (like genesis tree) then send a message to the taskmaster".
  One ship card in Citadel's Taskmaster chat lists every scheme behind; the server answers it itself (like a machine
  job's go card, not an approval, which a turn's end expires). Ship it ships each green scheme through its own
  `tools/land.sh`, one after another, pushed as the person who clicked (their GitHub link, as a minion's land is, #911).
- **Where that login can't push** (Genesis Tree pushes to awlego's repo, Genesis Tree #15), checked first with GitHub's
  `permissions.push`: that scheme's Taskmaster gets held mail and the scheme gets a ship card of its own, which any of
  its members answers, pushed as them.
- deploy.sh's drift step now says "sync waiting on your go" and asks for no minions.

## Not done

Schemes reading the kit's copy live (#601 rejected it), opening PRs for PR schemes, and syncing Project facts or agent
model lines.
