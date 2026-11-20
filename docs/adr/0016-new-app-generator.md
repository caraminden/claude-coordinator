# A scheme's Taskmaster makes a new app in one call, in a folder of its own repo

Status: accepted, 2026-11-19 (#1136, Build 6; from #1093's platform ideas, A1).

## Context

Eight apps were built by hand, each re-deciding sign-in, migrations, backups, health and its first page, and only Citadel's
Taskmaster, on an admin's turn, could register one. A scheme that wanted an app had to ask Citadel's Taskmaster, then
start a repo, then wire it all up.

## Decision

Josh picked "Build it" on #1093's choices page and settled the open forks in two grilling rounds on 2026-11-19; he
approved the plan the same day: "make_app: one tool call adds a tested, backed-up, signed-in app in a folder of the
asking scheme's repo, registers it and starts a minion that ships it and builds the idea".

- **Who:** any scheme's Taskmaster, on a turn a member of that scheme asked for ("Anyone signed in ... They can make one for
  their own schemes"). It is on for the scheme's owner and members ("Maker plus scheme members"); `set_app_person` switches
  one of the scheme's own apps for one person.
- **Where:** the app lives in `apps/<name>/` of the asking scheme's repo ("A folder in its repo"), not a repo of its own:
  that scheme's minions only work in that repo. The registry's new `subdir` points deploys there: manifest, build, units,
  roll back and migrations read from the folder, git steps stay at the repo root, a ship that changes nothing in the folder
  doesn't redeploy it, and its release target owns only that folder.
- **What:** the kit's starter (`kit/skills/contraption-ui/new-app/`): server core (the identity check, migrations, a
  nightly backup by the #828 convention, `/healthz`, `/api/me`), a first page on Citadel UI, its own tests, agent notes,
  and a CI workflow only when the scheme already has a runner. The first page is only a starting point ("this is just for
  the initial deployment not a rule for how apps look").
- **How:** a tool, no page ("Tool only"). The server starts a minion first and commits the generated app as its branch's
  first commit before the brief can start a turn, then registers the app with a free port from 7350 to 7999. The minion's
  brief ships the app as its scheme ships, then grills the maker and builds the idea.

## One way for each part

The eight live apps (Mandate, Peek Auras, Theory of Crafting, The Trans Agenda, TWIReader, VoiceAnalyzer, TripPresenter,
Genesis Tree) are all Node on plain `node:http`, and each has its own copy of the identity check; only Mandate and
VoiceAnalyzer write nightly backups, and half have no CI workflow. The starter takes the way most of them already do each
part, so moving one over later is small:

| Part | The one way |
|---|---|
| Server | Plain `node:http` under `BASE_PATH`; every path outside `OPEN` needs the identity header, else 401 |
| Identity | One copy, `src/identity.ts`: Ed25519 over the header, checked against `identity.pub` in `CITADEL_KEYS`; data keyed on `sub` |
| Data | SQLite (`node:sqlite`) in `DATA_DIR/app.db`, numbered `migrations/NNNN-*.sql` run at start; the manifest lists them |
| Backups | Mandate's: a 03:00 Pacific timer writes `backups/<day>/app.db` with `VACUUM INTO`, keeping 14 days (#828) |
| Health | `/healthz` answers 204 once the database opens |
| First page | Citadel UI's top bar and tokens, saying who is signed in; an icon and a web manifest |
| Tests | `node --test` on the kit's fake Citadel (#1126) |
| CI | A workflow on the scheme's own runner, run only when the app's folder changes; none without a runner |

## Consequences

- A scheme gets a running, signed-in app in one call plus one ship; proved on a dev server for two schemes (deploy, the
  page signed in at 1440 and 390, a backup, the app's 8 tests) in 30 s.
- Apps made before this stay as they are; moving them onto the shared parts is a separate handoff.
- The app's repo is its scheme's: its CI, ship and push guard are that scheme's, so an app made in a scheme with no
  runner has no CI until the scheme gets one.
