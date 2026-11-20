# Minions propose host tools; a Citadel member approves; the list lives in Citadel's repo

Status: accepted, 2026-11-19 (#1147, Build 6). Same shape as machine notes (#617, Josh, 2026-11-12: "Minion proposes, owner approves").

## Context

Turns kept needing tools the server didn't have (a linter, a CLI, a library's binary), and the only way to get one was to ask
a person to install it by hand, with no record of what the box has. A move off perigee would have to rediscover them all.
It installs software on the server, so there are no silent installs, ever.

## Decision

Josh's picks on #1147's cards, 2026-11-19:

- **Who approves:** "Citadel scheme members" (an admin, or a member of the Citadel scheme). A minion in any scheme may propose.
- **Sources:** "mise's own tools; npm packages; Python packages (pipx); Rust crates (cargo); GitHub release binaries; Arch
  packages (pacman)". mise has no pipx backend, so Python packages go through its `pypi:` backend. All but Arch packages
  install with `mise use -g --pin <spec>` as the server's user; the server has no root, so an approved Arch package is listed
  and a person runs the `sudo pacman -S --needed` line the minion hands them.
- **Where the list lives:** "In Citadel's repo", `deploy/host-tools.json`, one line per tool with who approved it, when and for
  which minion. Josh: "we definitely want all our dependencies in git so Citadel can be brought back up if we move off perigee".
- **How a line gets into git:** "The server ships it". An approval starts a chore minion in the Citadel scheme whose branch
  holds that one commit and hands its ship off like any minion's: a clean ship dismisses it, a failed one wakes it to fix.

A minion calls `propose_host_tool` (source, package, one exact version, why). The card shows the exact command; approving runs
it behind the click and tells the minion how it went. A newer proposal for the same package supersedes the open card, and one
already listed at that version is refused. `node tools/host-tools.ts install` puts the whole list on a fresh box;
`node tools/host-tools.ts check` names what the box lacks.

Turns get mise's shims last on their PATH (so they never shadow a tool already there) and `COORDINATOR_HOST_TOOLS`, the list's
path. Container turns mount `~/.config/mise` read-only with mise's other folders.

## Consequences

- Each approved tool ships a one-line change to Citadel's repo, which restarts the server like any non-front-end ship.
- Removing a tool is still by hand: delete its line and run `mise unuse -g <spec>`.
