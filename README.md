# Citadel

A shared web UI for running headless Claude Code sessions as **minions**. Several
people sign in, open a scheme, and talk to its **Taskmaster**: a long-lived
Claude session that creates, messages, renames and dismisses the scheme's other
minions. A sidebar lists the minions (running, waiting for input, errored,
dismissed), and any minion can also be opened and chatted with directly. Each
minion is one Claude Code session working in its own git worktree.

This is the proof-of-concept stage: minions, chat, live output and a board.
Planned next: runners on other people's own Claude logins.

## How it works

- Each chat message spawns one `claude -p --input-format stream-json --output-format stream-json` process
  in the minion's working directory, with `--resume <session_id>` after the
  first turn. Idle minions cost nothing, and a restart loses nothing.
- Every stream event is stored in SQLite and pushed to browsers over
  server-sent events.
- Messages sent while a turn is running are queued and sent together as the
  next turn. Messages reach Claude as `[Name]: text`.
- Tool calls stay out of the chat. Turns run with
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` so Claude can plan with
  TaskCreate/TaskUpdate, and `public/progress.js` (shared by the server and the
  browser) replays the events into a readout in the minion bar:
  "Running tests… 3/7", expandable to each step and the tool calls made while
  it was in progress. Each turn leaves one collapsed "Turn finished · N
  actions" line in the chat, and board cards show the same summary line.
- Images pasted, dropped or attached in the composer are shrunk in the browser
  if needed, saved under `projects/<id>/uploads/<ticket>/`, and sent to Claude
  as image blocks alongside the message text.
- `projects/<id>/shared/project/` is a folder every minion and the Taskmaster can read and
  write (`--add-dir`, plus a line in the system prompt) for handoffs, specs and notes. Its
  documents and pages are listed on a "Shared files" page, linked from the artifacts panel. The Taskmaster can
  also read and write the repo's Claude Code memory folder, still with no shell.
- Opening a scheme creates its Taskmaster minion on first visit. Its turns
  run with an extra MCP server (`src/mcp.ts`) whose tools call this app's API
  with a bearer token that only reaches that scheme's minions (never the
  Taskmaster itself). The token is passed in the environment, not on the
  command line, so other users on the box can't read it from `ps`.
- Each scheme can have **instructions** (up to 16,000 characters), edited on the
  scheme's Settings page (beside Sign out in the overview panel). They're appended
  to the system prompt of the Taskmaster and every minion, so they apply from each one's next turn. "Import from Claude Code" lists
  the instruction and memory files of the login the app runs as (`~/.claude/CLAUDE.md`
  and `rules/`, the repo's `CLAUDE.md` files, and auto-memory) to add with a tick.
  A file upload or a paste works too. The Taskmaster can read and change them
  with its `get_project_instructions` and `set_project_instructions` tools.
- **Machines** lend minions MCP servers that run on people's own computers, such as a
  Godot editor that runs builds on a laptop. Add one in the overview panel's Machines
  section; the app shows a one-time token and a command to run there, which downloads
  `public/machine-agent.mjs` (Node 18+, no installs) and starts it with the MCP server's
  command. The agent dials out to the app and holds an event stream open, so the computer
  needs no open ports and can be anywhere. Every minion turn (not the Taskmaster) gets each
  machine that is online when it starts as an MCP server named after the machine
  (`mcp__<name>__…`): a small stdio proxy (`src/machine-mcp.ts`) relays through the app
  (`src/machines.ts`), and the agent runs a separate copy of the MCP server per session.
  Tokens are stored hashed; a new token or removing the machine disconnects it. With
  `MACHINES_URL` set (perigee uses its tailnet name), agents connect only there, on a second
  listener that serves nothing else, and the public address refuses them.
  `--claude-mcp <name>` runs a server already set up for Claude Code on that computer
  (from its `~/.claude.json`, e.g. Delve's `godot-ai`), and each machine's notes ("never
  restart it", where the clone is) go into minion prompts while it is online. For Windows
  the page also gives a PowerShell snippet that registers a Task Scheduler task to start the
  agent now and at every logon, in the person's own session, with no reboot.
- **GitHub** wakes a minion about its pull request. `src/github.ts` polls each open
  minion's branch for its newest PR with one `gh api graphql` call, one minion at a time
  (every 2 minutes while a PR is open, backing off to 15 while nothing changes; 30 for
  minions without one; every turn's end looks again soon). A CI verdict on the head commit,
  a new review or comment, or a merge or close is sent into the minion as a message from
  "GitHub". The gh account is the minions' own, so its remarks, merges and closes during that
  minion's turns are skipped, as are bots. Handled events are kept in `github_seen`, so
  nothing is sent twice, and a PR's first look sends nothing.
- **Push notifications**: "Notify me on this device" in the overview panel subscribes that
  browser (desktop, or the installed Android app) with Web Push, and once on, a scheme can be
  muted there. Claude only pings for decisions, blockers and results: a question card (from a
  minion or the Taskmaster), a failed turn, or a minion set to ready, try or blocked; never for
  plain replies, and never the person who caused it. One notification per minion, replaced by the
  next; clicking it opens the minion. `src/push.ts` signs with VAPID and encrypts payloads
  (RFC 8291) using only `node:crypto`; the key pair is made on first start as `vapid.json` in
  `DATA_DIR` (mode 600). Replacing that file orphans every subscription.
- Schemes with a repo URL are cloned once; each minion gets
  `git worktree add -b ticket/<id>-<slug>` from the default branch.

No dependencies: Node 24+ runs the TypeScript directly (type stripping) and
uses the built-in `node:sqlite`.

## Layout

| Path | What |
| --- | --- |
| `server.ts` | HTTP server, JSON API, SSE stream, static files |
| `src/runner.ts` | Spawns `claude` turns, parses stream-json, queues messages |
| `src/mcp.ts` | MCP server giving the Taskmaster its minion-management tools |
| `src/approvals.ts` | Approval rules, plugin folders, and the Approve / Deny cards |
| `src/tripwire.ts` | PreToolUse hook every turn gets: blocks known accidents (live data, checkout, units, keys) |
| `src/push.ts` | Web Push: VAPID keys and signing, payload encryption, when to notify |
| `src/machines.ts` | Relays MCP traffic between minion turns and connected machines |
| `src/machine-mcp.ts` | Per-turn stdio stand-in for a machine's MCP server |
| `public/machine-agent.mjs` | Agent people run on their own computers to connect them |
| `src/github.ts` | Watches minions' pull requests and messages them about CI, reviews and merges |
| `src/workspace.ts` | Clones scheme repos, creates per-ticket worktrees |
| `src/instructions.ts` | Finds Claude Code instruction and memory files to import as scheme instructions |
| `src/db.ts` | SQLite schema and queries |
| `src/auth.ts` | Shared-password login, signed session cookies |
| `public/` | Front end (vanilla JS, no build) |
| `public/progress.js` | Task-list and step tracking, shared with the server |
| `deploy/claude-coordinator.service` | systemd user unit, with a resource-cap drop-in in `.service.d/` |
| `deploy/backup.sh`, `deploy/prune.sh` | Nightly database backup; pruning of long-closed minions (each with a `.service` and `.timer`) |
| `tools/deploy.sh`, `tools/boot-check.ts` | Safe deploys: checks, front-end reloads, idle restart with rollback |

## Running

Configuration comes from the environment:

| Variable | Default | |
| --- | --- | --- |
| `COORDINATOR_PASSWORD` | (required, 12+ chars) | Shared sign-in password |
| `SESSION_SECRET` | (required, 32+ chars) | Signs session cookies |
| `HOST` / `PORT` | `127.0.0.1` / `8573` | Listen address |
| `DATA_DIR` | `~/.local/share/claude-coordinator` | Database, clones, worktrees |
| `CLAUDE_BIN` | `claude` | Claude Code executable |
| `MACHINES_URL` | (unset: agents use the app's address) | Private address machines' agents connect to, e.g. `http://perigee.tail59477f.ts.net:8574`; the app listens there for agents only |
| `PUSH_SUBJECT` | the app's address, from the first subscribe | VAPID contact (`https://…` or `mailto:…`) push services see |

On perigee the secrets live in `~/.config/claude-coordinator/env` (mode 600,
never committed) and the app runs as a user service:

```sh
ln -s ~/claude-coordinator/deploy/claude-coordinator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-coordinator
journalctl --user -u claude-coordinator -f
```

The service runs with `UMask=0077`, so the database and everything it writes are
private (mode 600). `resources.conf` caps it, and every turn it runs, at
`MemoryMax=8G` and `CPUQuota=800%`, half of perigee, which is shared:

```sh
mkdir -p ~/.config/systemd/user/claude-coordinator.service.d
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/resources.conf ~/.config/systemd/user/claude-coordinator.service.d/
```

**Backups.** `deploy/backup.sh` takes an online `sqlite3 .backup` at 04:00 into
`$DATA_DIR/backups/`, checks the copy restores (integrity check plus the core
tables), and keeps 7 dailies and 4 weeklies (hard links), mode 600. They live on
the same disk, so they cover mistakes, not a dead disk. To restore, stop the
service and copy a backup over `coordinator.db` (removing its `-wal`/`-shm`).

**Pruning.** `deploy/prune.sh` lists, and with `--apply` deletes, the session
state (`claude_state`) of minions closed over 14 days ago and the worktrees of
minions closed over 30 days ago. Branches are kept, worktrees with uncommitted
changes are skipped, and a reopened minion gets its worktree back from its
branch. `--stale-backups` also removes the ad-hoc `coordinator.db.backup-*` and
`.bak-*` copies, once a nightly backup passes its check. Always read a dry run
before the first `--apply`.

```sh
for u in backup prune; do
  ln -s ~/claude-coordinator/deploy/claude-coordinator-$u.{service,timer} ~/.config/systemd/user/
done
systemctl --user daemon-reload
systemctl --user enable --now claude-coordinator-backup.timer claude-coordinator-prune.timer
```

Turns run as the service's user with that user's Claude Code login, so every
minion currently uses Cara's account.

### Deploying

Once a change is on `main` in the scheme repo, run `tools/deploy.sh` from the
minion that made it. It never hard-restarts:

1. It fast-forwards `~/claude-coordinator` to `main`, runs `node --test`, and
   boots the new code on a spare port against a copy of the database
   (`tools/boot-check.ts`: the app page, `/api/health`, and the MCP server's
   initialize and one tool call). If any of that fails it puts the checkout
   back and exits non-zero; nothing restarts.
2. If everything changed since the commit the server booted from is under
   `public/`, it sends `SIGHUP`. The server re-reads `public/` and tells open
   tabs, which reload once nobody is typing. No restart, no interrupted turns.
3. Otherwise it queues the fixed-name `cc-restart-when-idle` unit (a second
   deploy joins the one already queued). Once no minion is running it
   restarts, waits up to 30 s for `/api/health` to answer from the new commit,
   and tags it `last-good`. If it doesn't come up, it resets to `last-good`
   and restarts again. After 2 h without an idle moment it gives up.
4. Once the new code is live (after the reload, or after the healthy restart
   and `last-good` tag, inside the unit), it pushes that commit to `main` on
   GitHub (`origin`), with the gh CLI's git credentials. GitHub's `main` is
   what's live and the off-box copy. It never force-pushes: if GitHub's `main`
   has diverged, it says so and leaves it. A failed push (no network, auth, a
   rejection) doesn't fail or roll back the deploy: its report shows as an
   error and notifies, with the reason and any fix, but still dismisses the
   minion, and the next deploy retries. Also in `journalctl --user -t
   cc-restart-when-idle`.

How a queued restart went is posted in the deploying minion's chat (a failure
as an error, which pushes) and in the journal: `journalctl --user -u
cc-restart-when-idle` and `-u claude-coordinator`. A rollback leaves the bad
commit on `main`, so fix forward. Back up `coordinator.db` with `sqlite3
.backup` before deploying a data migration.

## Permissions

Headless turns can't show a permission prompt, so every minion runs in
`bypassPermissions`: full access as the service user. What would still prompt
goes to the `approve` tool (below), which shows a card only for a tripwire ask
or a scheme's approval rules and denies anything else. The Taskmaster's prompts
are denied (`--permission-prompts none`).

**Needs approval.** A scheme can list Claude Code permission rules, such as
`Bash(gh pr merge:*)` or `mcp__*__merge_pull_request`, on the "Needs approval"
tab of the scheme's Settings page (or the Taskmaster's `set_project_settings` tool). Every
minion runs with (the `ask` rules only when the scheme has some):

```
--permission-mode bypassPermissions
--permission-prompts host
--permission-prompt-tool mcp__thread__approve
--settings '{"permissions":{"ask":[<the rules>]},"hooks":{…}}'
```

`ask` rules are still checked in `bypassPermissions`, so only matching calls
prompt; everything else runs as before. (`--permission-prompts none` would deny
them outright, even with a prompt tool.) The prompt goes to the `thread` MCP
server's `approve` tool, which posts an Approve / Deny card in the chat and waits
until someone signed in clicks; the chat records who. Only a person's Approve
allows the call. Cards live in memory with the turn that asked: Stop, a failed
turn or a server restart expires them, and an expired card denies. The turn runs
with `MCP_TOOL_TIMEOUT` raised to a week so a card can wait overnight; a timeout
also denies. With rules set, anything else that would prompt in
`bypassPermissions` gets a card too, instead of being denied.

Rules are guardrails against mistakes, not a sandbox: a Bash rule matches how a
command starts, and a minion with full shell access could reach the same result
another way. The Taskmaster is never affected.

**Tripwire.** Every turn, Taskmaster or minion in any scheme, gets a `PreToolUse`
hook (`src/tripwire.ts`) in its `--settings`, alongside the repo's own hooks. It
blocks known accidents and says why and what to do instead: writes to the live data
dir (the database, its backups, other schemes' folders under `projects/`), the live
checkout (except a fast-forward `git pull` there until `tools/deploy.sh` exists, and
that script itself), `~/.config/claude-coordinator/` and the systemd and Quadlet
unit folders; `systemctl --user restart|stop|kill` of the app's or Godot's units;
reading `~/.ssh` or the Claude login; and running `server.ts` without `DATA_DIR`
and `PORT`. It reads the command text, so it's a tripwire, not a sandbox: a script,
an interpreter or a path in a variable gets past it. The table of blocked and
allowed commands is `test/tripwire.test.ts`.

Some blocks are things a person may reasonably want once, so in a minion's turn
they *ask* instead (the hook returns `permissionDecision: "ask"`, which Claude Code
sends to the `approve` tool even in `bypassPermissions`): Bash writes in the data
dir other than the live database files (SQL on the live database asks when the
whole of it is in the command), copying units into the user unit folders, and
`systemctl --user enable`/`link` and the like. The card shows the exact call, the
minion's Bash description as its reason, and the tripwire's reason; Approve runs
that one call once. The server works the verdict out again (the hook's reason
doesn't reach the prompt tool), and refuses the card without a description of at
least 20 characters, while another tripwire card from that minion is waiting, or
after one was denied that turn. Everything else stays a hard block: credentials,
the live checkout, the env file, other schemes, restarts, `server.ts` on live data,
and clobbering the live database file. A Taskmaster's turn can't show cards, so its
asks are blocks.

**Plugin folders.** A scheme can also list folders relative to the repo root
(e.g. `tools/mods/delve`); each minion turn gets `--plugin-dir <worktree>/<folder>`
for every one that exists in its worktree. Turns also get `COORDINATOR_SHARED_DIR` (the
scheme's shared folder) and `COORDINATOR_FILES_DIR` (the minion's own) in their environment,
for plugins and hooks that write files people should see.

The Taskmaster itself runs in `acceptEdits` with only its MCP tools
pre-approved, so it can read the code and manage minions but can't run shell
commands; it hands the real work to minions.
