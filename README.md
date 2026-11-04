# Citadel

A shared web UI for running headless Claude Code sessions as **minions**. Several
people sign in, open a scheme, and talk to its **Taskmaster**: a long-lived
Claude session that creates, messages, renames and dismisses the scheme's other
minions. A sidebar lists the minions (running, waiting for input, errored,
dismissed), and any minion can also be opened and chatted with directly. Each
minion is one Claude Code session working in its own git worktree.

This is the proof-of-concept stage: minions, chat, live output and a board.

## How it works

- Each chat message spawns one `claude -p --input-format stream-json --output-format stream-json` process
  in the minion's working directory, with `--resume <session_id>` after the
  first turn. Idle minions cost nothing, and a restart loses nothing.
- Each turn runs in a transient user unit of its own (`systemd-run`, in
  `citadel-turns.slice`) through `src/turn-wrapper.ts`, which writes claude's
  output to a file in `$DATA_DIR/run/turns/` that the server tails. A restart
  leaves running turns alone: the next server re-attaches and catches up, and the
  turns' MCP calls wait for it (up to 2 min).
- Each minion and Taskmaster gets its own temp folder, `$DATA_DIR/projects/<scheme id>/tmp/<ticket id>`
  (`TMPDIR`, `TMP`, `TEMP` and `CLAUDE_CODE_TMPDIR`), on disk rather than in the
  shared `/tmp` tmpfs. Dismissing a minion clears it, and server start sweeps the
  folders of dismissed or deleted ones (`src/turn-tmp.ts`).
- People sign in with their own login and password. An admin invites them from
  Settings → People with a one-time link (7 days) that sets their password; the
  same button makes a reset link later. Each person sees only the schemes they own
  or were added to (Settings → Members); admins see every scheme. A turn runs on
  the Claude plan of the person who sent its messages: the server's own login for
  its owner (the first admin), and everyone else's own linked Claude (below). A
  message from someone who hasn't linked is kept with a note.
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
  Taskmaster itself). The one way past that is `message_taskmaster`, which
  messages another scheme's Taskmaster (never its minions): one the turn's person is also in (an admin is
  in all), or Citadel's from anywhere, labelled with who asks and whether they're a Citadel member;
  Citadel's may answer a scheme for 7 days after it last wrote (`src/access.ts`). A loop guard allows
  6 messages per pair of Taskmasters in 10 minutes. The token is passed in the environment, not on the
  command line, so other users on the box can't read it from `ps`.
- A **contraption**'s own server (local, with its contraption key, never through Caddy) sends its people's
  bug reports and feature asks to its home scheme with `POST /api/contraptions/asks`: files (16 MiB in all)
  go into that scheme's shared folder under `inbox/<contraption>/<login>/`, and the ask reaches its
  Taskmaster labelled like `message_taskmaster`'s; a non-member's feature ask is a proposal only
  (`src/contraption-asks.ts`).
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
  **Workspace tools** (#90): an agent started with `--config machine-agent.json` (both
  snippets pass it) reads workspaces from that file, which only the computer's owner edits:
  a folder, extra read-only folders, and named tasks with a fixed argv (no shell, no
  arguments from minions). With the machine's "Workspace tools" switch on (off by default),
  turns also get `mcp__<name>-ws__…`: `workspaces`, `git_sync` (fetch origin, detached
  checkout; stops rather than overwrite local changes), `run_task`/`job` (one job per
  workspace, long ones return a job id), `read_file`, `list_files`, and `fetch_file`, which
  copies a file of up to 20 MB into the minion's shared files under `machine-files/<machine>/`.
  A workspace its owner keeps on a branch (an Obsidian vault with Obsidian Git) sets
  `"git_sync": false`: `git_sync` refuses there, `workspaces` and the Machines page say it's off,
  and an agent whose workspaces all have it off doesn't offer the tool.
  The agent re-reads the file when it changes. Builds still run whatever the repo's project
  files say, so this limits what minions can ask for; it is not a sandbox.
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
  muted there, or the device kept to "Only my pinned minions": the minions that person pinned,
  anyone's, in schemes they're still in, plus the Taskmaster, which can't be pinned. Claude only pings for decisions, blockers and results: a question card (from a
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
| `src/inbox.ts`, `public/inbox.js` | The Needs-you inbox: a scheme's open cards and ready/try minions, as a strip at the top of the minions list |
| `src/schedules.ts`, `public/schedules.js` | Scheduled minions: cron parsing, the schedules table, and the panel the clock in the Minions header swaps in; the server's timer starts each due run as a fresh minion |
| `src/tripwire.ts` | PreToolUse hook every turn gets: blocks known accidents (live data, checkout, units, keys) |
| `src/push.ts` | Web Push: VAPID keys and signing, payload encryption, when to notify |
| `src/machines.ts` | Relays MCP traffic between minion turns and connected machines |
| `src/machine-mcp.ts` | Per-turn stdio stand-in for a machine's MCP server |
| `public/machine-agent.mjs` | Agent people run on their own computers to connect them |
| `src/github.ts` | Watches minions' pull requests and messages them about CI, reviews and merges |
| `src/workspace.ts` | Clones scheme repos, creates per-ticket worktrees |
| `src/instructions.ts` | Finds Claude Code instruction and memory files to import as scheme instructions |
| `src/db.ts` | SQLite schema and queries |
| `src/auth.ts` | Per-person sign-in (and the admin's shared password), invite links, signed session cookies |
| `src/access.ts`, `src/routes/people.ts`, `public/people.js` | Who sees what: news filtered by scheme membership, the turn gate, People and Members |
| `public/` | Front end (vanilla JS, no build) |
| `kit/` | The Citadel kit: a Claude Code plugin (skills, agents, hooks) every turn of every scheme loads |
| `public/progress.js` | Task-list and step tracking, shared with the server |
| `deploy/claude-coordinator.service` | systemd user unit, with drop-ins in `.service.d/`; `citadel.slice` caps it and its turns, `claude-coordinator.socket` holds the port across restarts |
| `deploy/backup.sh`, `deploy/prune.sh` | Nightly database backup; pruning of long-closed minions (each with a `.service` and `.timer`) |
| `deploy/offbox.sh`, `deploy/offbox-serve.sh`, `deploy/desktop/` | The off-box copy set backup.sh refreshes, the forced command the desktop's key runs, and the desktop's pull script and setup |
| `tools/land.sh` | Lands a minion's branch: rebase onto main, test, fast-forward main, deploy, under the deploy lock |
| `tools/deploy.sh`, `tools/boot-check.ts` | Safe deploys: checks, front-end reloads, restarts that keep turns running, rollback |

## Running

Configuration comes from the environment:

| Variable | Default | |
| --- | --- | --- |
| `COORDINATOR_PASSWORD` | (required, 12+ chars) | The admin's master password: it signs in as the admin whose login is typed (or the first admin for any other login). Never hand it out; invite people instead |
| `COORDINATOR_ADMIN` | `Cara` | Name of the admin made on first start, when the database has no people yet; their login is the name in lower case |
| `SESSION_SECRET` | (required, 32+ chars) | Signs session cookies, and encrypts people's linked accounts: changing it unlinks everyone's GitHub |
| `CITADEL_CONTRAPTIONS_DIR` | `~/.config/citadel/contraptions` (another `DATA_DIR`: its `contraptions/`) | Where each contraption's key folder goes (`<name>/identity.pub`, `<name>/contraption.key`), which its own service reads |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | (unset: turns use the box's gh login) | The OAuth App people link their own GitHub through (below) |
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
private (mode 600). `citadel.slice` caps the service and every turn it runs, at
`MemoryMax=8G` and `CPUQuota=800%`, half of perigee, which is shared
(`resources.conf` puts the service in it). `claude-coordinator.socket` holds port
8573 while the server restarts, so requests then wait instead of failing
(`socket.conf` makes the service use it):

```sh
mkdir -p ~/.config/systemd/user/claude-coordinator.service.d
ln -s ~/claude-coordinator/deploy/citadel.slice ~/.config/systemd/user/
ln -s ~/claude-coordinator/deploy/claude-coordinator.socket ~/.config/systemd/user/
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/resources.conf ~/.config/systemd/user/claude-coordinator.service.d/
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/socket.conf ~/.config/systemd/user/claude-coordinator.service.d/
systemctl --user daemon-reload
```

The socket takes effect at the next restart after that; until then the server
binds the port itself.

**Backups.** `deploy/backup.sh` takes an online `sqlite3 .backup` at 04:00 into
`$DATA_DIR/backups/`, checks the copy restores (integrity check plus the core
tables), and keeps 7 dailies and 4 weeklies (hard links), mode 600. Hand-made
`backups/coordinator-before-<what>.db` copies go once they are 7 days old.
Session state (`claude_state`, most of the bytes) lives in `state.db` beside
`coordinator.db`, attached by the server; it gets its own `state-<day>.db`, 3
dailies and no weeklies. Previews, boot-check and the pre-deploy copy copy only
`coordinator.db`. Then `deploy/offbox.sh` refreshes `$DATA_DIR/offbox/`, the copy
set Cara's Windows desktop pulls each morning over SSH (dailies and weeklies with
linked-account secrets stripped, plus the newest `state-*`); setup is in
`deploy/desktop/README.md`. To restore, stop the service and copy a backup over
`coordinator.db` (and a `state-*` one over `state.db`), removing their
`-wal`/`-shm`.

**Pruning.** `deploy/prune.sh` lists, and with `--apply` deletes, the session
state (`claude_state`) of minions closed over 14 days ago and the worktrees of
minions closed over 30 days ago. Branches are kept, worktrees with uncommitted
changes are skipped, and a reopened minion gets its worktree back from its
branch. `--stale-backups` also removes the ad-hoc `coordinator.db.backup-*` and
`.bak-*` copies once they are 7 days old, while the newest nightly backup is
under 2 days old and passes its check; the nightly timer runs `--apply
--stale-backups`. Always read a dry run before the first `--apply`. The units are
symlinks into this checkout, so after a deploy that changes one, run
`systemctl --user daemon-reload` for systemd to pick it up.

```sh
for u in backup prune; do
  ln -s ~/claude-coordinator/deploy/claude-coordinator-$u.{service,timer} ~/.config/systemd/user/
done
systemctl --user daemon-reload
systemctl --user enable --now claude-coordinator-backup.timer claude-coordinator-prune.timer
```

**Down alerts.** Every 5 minutes `deploy/citadel-watchdog.timer` runs
`tools/watchdog.ts` (`src/watchdog.ts`): it checks `claude-coordinator.service`
and `/api/health`, and each contraption's `citadel-app-<name>.service` while it is
enabled, with its manifest's health path or its port. Once one has been down or
not answering for 10 minutes (`WATCHDOG_MINUTES`) it web-pushes every admin's devices, and for a contraption its home scheme's
owner's too while they have Mandate on, straight from the script,
reading the database read-only, and once more when it is back. It never restarts
anything. Its state is in `~/.local/state/citadel-watchdog/`; `node
tools/watchdog.ts --dry-run` shows a round without saving or sending.

```sh
ln -s ~/claude-coordinator/deploy/citadel-watchdog.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now citadel-watchdog.timer
```

Turns for the server login's owner run as the service's user on that user's
Claude Code login. Everyone else's run in a Claude container of their own.

**People's own Claude.** Each person links their Claude plan in Settings → Your
account (`src/claude-link.ts`). Linking starts a rootless podman container,
`citadel-claude-<user id>`, from `deploy/claude-container/Containerfile`, with a
named volume as its HOME. `claude auth login` runs inside it; the person opens the
link, signs in with Anthropic and pastes the one-time code back into the card, and
the login stays in the volume. Citadel never sees a password or token. The
container runs `sleep infinity` under a transient `systemd-run --user` unit (no
unit file to install), with the host network, `--userns=keep-id`, 6 GB and 4 CPUs.
It mounts the data dir's `projects/`, its own turns' folder `run/turns/person-<user id>/`
(never the host's turns or another person's), the schemes' memory folders,
Claude Code's versions folder and the tool folders (read-only), and never `~/.ssh`,
`~/.config/gh`, the server's `~/.claude`, the database or the user bus. A turn goes
in with `podman exec -d … node src/turn-wrapper.ts`; its liveness is a heartbeat
file. Usage is kept per person (`usage:user:<id>`). If Anthropic turns the login
down mid-turn, the link is marked expired and the turn says so. Unlink signs out,
stops the container and deletes the volume. A turn in a container lands with the
`land` tool (mcp__thread), which runs `tools/land.sh` on the host for it, since
podman and systemd aren't reachable from inside. The tripwire keeps turns away from
`citadel-claude-*` containers and podman's storage.

**People's own GitHub.** With an OAuth App set up, each person links their GitHub
in Settings → Your account, and a turn pushes and opens pull requests as the
person it runs for (who sent its messages; a relay counts as its sender's
person). A turn for someone who hasn't linked gets no GitHub login at all, so it
commits but can't push, and says so. Without the OAuth App, turns use the box's
own `gh` login as before. To set it up, once:

1. On github.com: Settings → Developer settings → OAuth Apps → New OAuth App.
   Homepage `https://cara.apps.webplatformisbestplatform.net`, callback
   `https://cara.apps.webplatformisbestplatform.net/api/github/callback`.
2. Generate a client secret, and add both to `~/.config/claude-coordinator/env`
   as `GITHUB_CLIENT_ID=…` and `GITHUB_CLIENT_SECRET=…`, then restart.
3. Link your own GitHub too: from then on an unlinked person's turns, the
   admin's included, can't push.

Tokens are kept encrypted with a key from `SESSION_SECRET`; changing that secret
leaves every link needing linking again. Deploys still push `main` with the box's
`gh` login, and the pull-request watcher reads with it.

### Deploying

A minion lands its branch with `tools/land.sh`, run from its worktree. Under
the deploy lock it rebases the branch onto the local `main`, runs `node --test`,
fast-forwards `main` in the scheme repo, then runs `tools/deploy.sh`. A conflict
or a red test stops it before `main` moves; a deploy whose checks fail puts
`main` back too.

`tools/deploy.sh` on its own deploys whatever is on `main`. Restarting doesn't
interrupt turns:

1. It fast-forwards `~/claude-coordinator` to `main`, runs `node --test`, and
   boots the new code on a spare port against a copy of the database
   (`tools/boot-check.ts`: `node --check` on `public/*.js`, `/api/health`, the
   app signed in and rendered in Playwright's headless Chromium with no console
   error, the MCP server's initialize and one tool call, and a minion turn and a
   Taskmaster turn started through the runner's real arguments with
   `tools/boot-check-claude.ts` as claude). If any of that fails it puts the
   checkout back and exits non-zero; nothing restarts.
2. If everything changed since the commit the server booted from is under
   `public/`, it sends `SIGHUP`. The server re-reads `public/` and tells open
   tabs, which reload once nobody is typing. No restart, no interrupted turns.
3. Otherwise it queues the fixed-name `cc-restart-when-idle` unit (a second
   deploy joins the one already queued), which restarts straight away. Turns
   in units of their own carry on and the new server re-attaches to them; it
   only waits while turns a restart would cut off are running (`/api/health`'s
   `interruptible`: turns an older server started as its own children), and
   gives up after 2 h of that. On `SIGTERM` the old server has 5 s to finish
   its requests. Then it waits up to 30 s for `/api/health` to answer from the
   new commit, and tags it `last-good`. If it doesn't come up, it resets to
   `last-good` and restarts again. `tools/deploy.sh --now` restarts without
   waiting, cutting off those turns (#33's auto-resume picks them up); the
   tripwire asks a person before it runs.
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
commit on `main`, so fix forward. Before every restart the unit copies the
database to `backups/pre-deploy-<commit>.db` (no copy, no restart; a retry
keeps the first copy; the newest 3 are kept, rotated only after a healthy
deploy), and a rollback report names it. `src/db.ts` keeps a `schema_version`
setting: bump `SCHEMA_VERSION` with any schema or data migration, and
`test/schema-compat.test.ts` checks the last release (`last-good`, else
`origin/main`) still reads and writes the migrated database.

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
reading `~/.ssh` or the Claude login; people's Claude containers and podman's
storage; and running `server.ts` without `DATA_DIR`
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

**Plugin folders.** Every turn of every scheme, the Taskmaster's too, loads the
Citadel kit (`kit/`, see its README) from a copy pinned when the server started. A
scheme can also list folders relative to the repo root (e.g. `tools/mods/delve`) or
absolute ones; each minion turn gets `--plugin-dir <worktree>/<folder>` (or the
absolute path) for every one that exists. Turns also get `COORDINATOR_SHARED_DIR` (the
scheme's shared folder) and `COORDINATOR_FILES_DIR` (the minion's own) in their environment,
for plugins and hooks that write files people should see. A turn answering one person's
own typed message also gets `CITADEL_PERSON_ID` (their user id, the `sub` of a contraption
identity) and `CITADEL_PERSON_LOGIN`, so a contraption's hook guard can let the session read
that person's data and nobody else's; every other turn (a relay, a wake, a schedule, a resume,
GitHub, a contraption's post) has neither, not even empty. They're fixed when the turn
starts: another person's typed message waits for a turn of its own rather than steering in.
Host and container turns alike.

The Taskmaster itself runs in `acceptEdits` with only its MCP tools
pre-approved, so it can read the code and manage minions but can't run shell
commands; it hands the real work to minions.
