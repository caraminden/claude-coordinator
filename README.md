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
- Each turn runs in a memory group of its own (`systemd-run`, in
  `citadel-turns.slice`), its claude's output written to a file in
  `$DATA_DIR/run/turns/` that the server tails. A host turn starts in the shared
  turn supervisor (#1343, `src/turn-supervisor.mjs`, one process per turns folder
  and version, about 21 MB in all), which runs it in a scope of its own; a turn it
  can't take at once, and container, test and dev turns, get a node wrapper of their
  own instead (`src/turn-wrapper.mjs` in a unit, about 21 MB each). A turn outlives a
  supervisor crash and a new one adopts it; `TURN_SUPERVISOR=0` goes back to a wrapper
  per turn. A restart
  leaves running turns alone: the next server re-attaches and catches up, and the
  turns' MCP calls wait for it (up to 2 min). If `systemd-run` fails, the turn
  (or landing, or ultra review) still runs, inside the server: `/api/health`'s
  `fallbacks` counts those since start, and the first of each cause each day is a Mandate
  alert for every admin (`src/fallbacks.ts`).
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
- Passwords and keys go in the secret store (`src/secrets.ts`, #838), never a chat: a minion asks
  with a secret card (ask_question `secret`), people add, replace and delete theirs and their schemes'
  in Settings → Your account, and the message box asks before sending text that looks like one
  (`public/secret-check.js`). Values are sealed in `stored_secrets`, never shown again, dropped from
  off-box copies, and reach turns only as `$CITADEL_SECRET_<NAME>` env vars (the scheme's, plus the
  person's own when they alone sent the turn's messages). A value a turn prints is masked in the chat
  and failure notes, but Claude's own session transcript keeps it, so minions are told never to print one.
  Contraptions read them by name (`GET /api/contraptions/secrets/<name>`).
- Every stream event is stored in SQLite and pushed to browsers over
  server-sent events.
- Messages sent while a turn is running are queued and sent together as the
  next turn. Messages reach Claude as `[Name]: text`.
- Tool calls stay out of the chat. Turns run with
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` so Claude can plan with
  TaskCreate/TaskUpdate, and `public/progress.js` (shared by the server and the
  browser) replays the events into a readout in the minion bar:
  "Running tests… · 3 of 7 done", expandable to each step and the tool calls made while
  it was in progress. Each turn leaves one collapsed "Turn finished · N
  actions" line in the chat, and board cards show the same summary line.
- Images pasted, dropped or attached in the composer are shrunk in the browser
  if needed, saved under `projects/<id>/uploads/<ticket>/`, and sent to Claude
  as image blocks alongside the message text.
- `projects/<id>/shared/project/` is a folder every minion and the Taskmaster can read and
  write (`--add-dir`, plus a line in the system prompt) for handoffs, specs and notes. Its
  documents, pages, pictures and clips are listed in the scheme's Files view (`public/files.js`, with what
  minions linked), where people also upload into it: `inbox/` unless they pick a folder. The Taskmaster can
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
  bug reports and feature asks to its home scheme with `POST /api/contraptions/asks`: files (16 MiB in all
  as base64, or big ones up to 200 MiB each streamed first to `POST /api/contraptions/asks/files` and named by
  the id it answers) go into that scheme's shared folder under `inbox/<contraption>/<login>/`, and the ask reaches its
  Taskmaster labelled like `message_taskmaster`'s; a non-member's feature ask is a proposal only
  (`src/contraption-asks.ts`). Its body is `{ person, kind: 'bug' | 'feature', text, summary?, item?, files? }`:
  the chat shows a header line (kind, contraption, person, `item` such as an aura's name, at most 100
  characters) and `summary` (at most 200; without one, the text's first sentence), the full text behind a
  toggle; the Taskmaster's turn reads it all. An ask to change how the contraption itself behaves (its
  skills, prompts or agent instructions) is a feature ask like any other. A `kind: 'data'` ask (#318)
  only files, for a member or not: its files, plus `<time>-ask.json` beside them with `{ contraption,
  person, item, summary, text, files, at }` (`text` optional); no chat message, no wake, and its own loop
  cap of 60 per person in 10 minutes. All kinds answer 202 `{ scheme, member, proposal, files }`, data
  adding `sidecar`, the JSON's path.
- Each scheme can have **instructions** (up to 32,000 characters), edited on the
  scheme's Settings page (linked along the foot of the overview panel's account box). They're appended
  to the system prompt of the Taskmaster and every minion, so they apply from each one's next turn. "Import from Claude Code" lists
  the instruction and memory files of the login the app runs as (`~/.claude/CLAUDE.md`
  and `rules/`, the repo's `CLAUDE.md` files, and auto-memory) to add with a tick.
  A file upload or a paste works too. The Taskmaster can read and change them
  with its `get_project_instructions` and `set_project_instructions` tools.
- **Machines** lend minions MCP servers that run on people's own computers, such as a
  Godot editor that runs builds on a laptop. Add one in Settings, on the Machines tab,
  by name (#439); the app shows its token and one install line for that computer
  (Windows, or macOS and Linux), which downloads `public/machine-agent.mjs` (Node 18+, no
  installs) and runs it in the background from then on. The agent reports what it found there:
  the names (never the commands or env) of the MCP servers in that computer's Claude Code
  config, servers its owner wrote under `"servers"` in `machine-agent.json` beside it, and
  that file's workspaces. A person ticks, in the machine's line, the one server and the folders
  it lends; the agent serves only what is ticked and what it found itself, so the app can
  name a server and never a command, and a tick needs no new token. The agent dials out to the app and holds an event stream open, so the computer
  needs no open ports and can be anywhere. Every minion turn (not the Taskmaster) gets each
  machine that is online when it starts as an MCP server named after the machine
  (`mcp__<name>__…`): the turn's shared tool server links it through the app
  (`src/pool-machine.ts`, `src/machines.ts`) on its first call, answering its start from the
  machine's remembered tool list, and the agent runs a separate copy of the MCP server per session.
  Tokens are checked by their hash; a sealed copy (#1355) lets a machine's owner (an admin, for a shared one) Show
  and Copy it again on its line, to set up another tool there. A new token or removing the machine disconnects it. With
  `MACHINES_URL` set (perigee uses its tailnet name), agents connect only there, on a second
  listener that serves nothing else, and the public address refuses them.
  An agent installed before ticks (started with `--claude-mcp <name>` or `-- <command>`)
  keeps lending what its command line says, shown as "set on that computer" until it is
  reinstalled with a new token. Each machine's notes ("never
  restart it", where the clone is) go into minion prompts while it is online. On Windows
  the install line registers a Task Scheduler task that starts the agent now and at every
  logon, in the person's own session, with no reboot; on macOS and Linux the agent installs
  itself as a launchd agent or a systemd user unit.
  **Workspace tools** (#90): the agent reads workspaces from that file, which only the computer's owner edits:
  a folder, extra read-only folders, and named tasks with a fixed argv (no shell; a minion's
  arguments are appended only to a task that says `"args": true`). With a folder ticked (an older agent: its "All its folders" switch on),
  turns also get `mcp__<name>-ws__…`: `workspaces`, `git_sync` (fetch origin, detached
  checkout; stops rather than overwrite local changes), `run_task`/`job` (one job per
  workspace, long ones return a job id), `read_file`, `list_files`, and `fetch_file`, which
  copies a file of up to 20 MB into the minion's shared files under `machine-files/<machine>/`.
  `stop_job` ends a running job and what it started. For the Windows test box (#369,
  `tools/win-test-box/`), `"screenshots": true` adds `screenshot` (the screen or one window as a PNG,
  copied over like `fetch_file`), and `"screen_lock": <file>` makes tasks (unless `"screen": false`)
  and screenshots take one lock file that the box's CI desktop jobs take too.
  A workspace its owner keeps on a branch (an Obsidian vault with Obsidian Git) sets
  `"git_sync": false`: `git_sync` refuses there, `workspaces` and the Machines page say it's off,
  and an agent whose workspaces all have it off doesn't offer the tool.
  A new folder is added on that computer, in that file; the page shows the lines to write.
  A CI runner host (`tools/ci-runner/`) is added from its own button under the list, with
  its own install line.
  The agent re-reads the file when it changes. Builds still run whatever the repo's project
  files say, so this limits what minions can ask for; it is not a sandbox.
  The Taskmaster sees them too (#307): `list_machines` gives each machine its scheme can see
  (all of them for an admin's ask, else those its asker's minion turns there would get) with its
  live state, and `check_machine` opens a session like a turn's proxy, sends MCP `initialize` and
  `tools/list` to each server a turn would get, and reports pass or fail. It calls no tool.
- **GitHub** wakes a minion about its pull request. `src/github.ts` polls each open
  minion's branch for its newest PR with one `gh api graphql` call, one minion at a time
  (every 2 minutes while a PR is open, backing off to 15 while nothing changes; 30 for
  minions without one; every turn's end looks again soon). A CI verdict on the head commit,
  a new review or comment, or a merge or close is sent into the minion as a message from
  "GitHub". The gh account is the minions' own, so its remarks, merges and closes during that
  minion's turns are skipped, as are bots. Handled events are kept in `github_seen`, so
  nothing is sent twice, and a PR's first look sends nothing.
- **Push notifications**: "Notify me on this device" (Settings → Notifications) subscribes that
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
uses the built-in `node:sqlite`. Nothing in `src/` imports a package: the devDependencies are
`fast-check`, for the property tests only (`test/lanes-property.test.ts`, `test/claims-property.test.ts`;
`docs/adr/0029-fast-check-for-tests-only.md`), and `typescript` with `@types/node`, for the type check
(`tsconfig.json` and the front end's two, `test/typecheck.test.ts`; `docs/adr/0034-typecheck-ratchet.md`). A fresh worktree gets them from `npm ci`.

## Layout

| Path | What |
| --- | --- |
| `server.ts` | HTTP server, JSON API, SSE stream, static files |
| `src/runner.ts` | Spawns `claude` turns, parses stream-json, queues messages |
| `src/wrapper-alive.ts` | Whether a turn's wrapper still runs, from its folder and `/proc`: on the thread at boot, off it for a followed turn's poll |
| `src/claude-events.ts`, `src/stream-events.ts` | Types for the Claude CLI's stream-json events and content blocks, and reading one event (what is stored, what it says the minion is doing) |
| `src/thrown.ts` | `thrown(err)`: a caught value's error fields (message, code, stderr), typed |
| `src/gh-bodies.ts` | Types for the fields Citadel reads from GitHub's REST answers (runs, jobs, errors) |
| `src/turn-launch.ts` | What a turn is launched with: pinned copies of the server files, hooks, settings, env and tool lists |
| `src/prompts.ts` | The agent instructions: the minion and Taskmaster prompts, onboarding, and the messages a turn is sent |
| `src/mcp.ts` | The MCP server: each role's tool lists in order, who may call what, and the tools no family file holds yet; a tool's definition and handler live together in its `src/mcp-<family>.ts` |
| `src/mcp-call.ts` | What every family of MCP tools shares: the turn's settings, the API call, minion number lookups, shared field text |
| `src/mcp-apps.ts` | MCP tools for apps and contraptions: definitions and handlers (make_app, deploys, releases, app reads and turns) |
| `src/mcp-ship.ts` | MCP tools for shipping and CI: definitions and handlers (hand_off_land, wakes, the ship line, runners, CI files, ship lessons) |
| `src/mcp-cards.ts` | MCP tools that put a card in front of a person: definitions and handlers (questions, plans, proposals, approvals) |
| `src/mcp-scheme.ts` | MCP tools for a scheme's settings, instructions, properties, schedules and review set: definitions and handlers |
| `src/mcp-minions.ts` | MCP tools for minions and messages: definitions and handlers (create, read, message, close, claims, plan) |
| `src/mcp-lookup.ts` | MCP tools that look things up: definitions and handlers (searches, artifacts, machines and their jobs, usage) |
| `src/mcp-types.ts` | Types only: the API answers and requests `src/mcp.ts`'s tools read (#1799) |
| `src/approvals.ts` | Approval rules, plugin folders, and the Approve / Deny cards |
| `src/inbox.ts`, `public/inbox.js` | The Needs-you inbox: a scheme's open cards and ready/try minions, as a strip at the top of the minions list |
| `src/memory.ts` | Semantic memory (#331): the memory_chunks table, the background indexer (each person's message with the final reply, and minions' titles and notes; never tool output or person notes) and search by meaning behind `/api/projects/:project/memory` and the `search_memory` MCP tool |
| `src/schedules.ts`, `public/schedules.js` | Scheduled minions: cron parsing, the schedules table, and the panel the clock in the Minions header swaps in; the server's timer starts each due run as a fresh minion |
| `src/effort-retros.ts` | Effort retros (#1751): when every minion sharing an `effortName` (named, or an unnamed start_after chain) has closed, the server starts a citadel:retro minion in that scheme; a judge that acts (Cara, 2026-11-24: "Start for real now"). Also `TroubleRetros` (#1796): a closed minion past four times its budget, or one a Taskmaster stepped up, gets one citadel:post-mortem minion, a second judge, log-only likewise |
| `src/tripwire.ts` | PreToolUse hook every turn gets: blocks known accidents (live data, checkout, units, keys) |
| `src/push.ts` | Web Push: VAPID keys and signing, payload encryption, when to notify |
| `src/machines.ts` | Relays MCP traffic between minion turns and connected machines |
| `src/turn-supervisor.mjs`, `src/supervisor-client.ts`, `src/turn-run.mjs` | The shared turn supervisor (#1343) that starts host turns' claude, each in a scope of its own; the runner's side of it; and what it and the per-turn wrapper (`src/turn-wrapper.mjs`) both run |
| `src/mcp-pool.ts`, `src/pool-client.mjs`, `src/pool-machine.ts` | The shared tool server (#1259): one process per place (a person's container, or the host) and pinned version serves every turn's `src/mcp.ts` tools and machine links over HTTP MCP, each call as the turn whose token reached it; the turn's wrapper starts it and keeps the turn registered. `TURN_POOL=0` goes back to helpers per turn |
| `src/machine-mcp.ts` | Per-turn stdio stand-in for a machine's MCP server, for a turn whose shared tool server won't start, and Codex turns |
| `public/machine-agent.mjs` | Agent people run on their own computers to connect them |
| `public/refstate.js` | Paints minion links in chat (`a.thread-ref`) by their minion's state: waiting, working, deployed (`refBucket` in `public/threadstate.js`) |
| `src/github.ts` | Watches minions' pull requests and messages them about CI, reviews and merges |
| `src/workspace.ts` | Clones scheme repos, creates per-ticket worktrees |
| `src/instructions.ts` | Finds Claude Code instruction and memory files to import as scheme instructions |
| `src/kill-wave.ts` | Turns that died together with no record of how: their notes say how many and in which container (#1938) |
| `src/turn-row.ts` | One turn's row: what a result event says of it, and its write, shared by `recordTurn` and `backfillTurns` (#1877) |
| `src/db.ts`, `src/db-schema.ts`, `src/db-rows.ts` | The SQLite database: `db.ts` opens it and holds the migrations, settings and area list; `db-schema` is the CREATE TABLE text; `db-rows` holds the row types and the option lists and limits that go with them, which `db.ts` re-exports |
| `src/auth.ts` | Per-person sign-in (and the admin's shared password), invite links, signed session cookies |
| `src/avatar.ts`, `public/avatars.js`, `public/avatar-card.js` | Speaker avatars in chat, a person's own switch (off until turned on) and picture: saved, marked on every speaker's name (drawn by `public/avatars.css`), and its account row |
| `src/access.ts`, `src/routes/people.ts`, `public/people.js` | Who sees what: news filtered by scheme membership, the turn gate, People and Members |
| `public/` | Front end (vanilla JS, no build); its files are in the rows below |
| `kit/` | The Citadel kit: a Claude Code plugin (skills, agents, hooks) every turn of every scheme loads |
| `public/progress.js` | Task-list and step tracking, shared with the server |
| `deploy/claude-coordinator.service` | systemd user unit, with drop-ins in `.service.d/`; `citadel.slice` caps it and its turns, `claude-coordinator.socket` holds the port across restarts |
| `deploy/citadel-embed.service`, `deploy/embed-install.sh` | Semantic memory's embedding model (llama-server with Qwen3-Embedding-0.6B on localhost:21434) and its installer |
| `deploy/host-tools.json`, `tools/host-tools.ts` | The tools minions asked for and a Citadel member approved (#1147, ADR 0019); `node tools/host-tools.ts install` puts them on a fresh box, `check` names what it lacks |
| `deploy/backup.sh`, `deploy/prune.sh` | Nightly database backup; pruning of long-closed minions (each with a `.service` and `.timer`) |
| `deploy/offbox.sh`, `deploy/offbox-serve.sh`, `deploy/desktop/` | The off-box copy set backup.sh refreshes, the forced command the desktop's key runs, and the desktop's pull script and setup |
| `tools/land.sh` | Lands a minion's branch: rebase onto main, test, fast-forward main, deploy, under the deploy lock; `--into build/<n>` and `--build` for build branches |
| `tools/land/` | land.sh's parts, sourced up front (definitions only): `common.sh` (retro log, phase times, gh calls), `prepare.sh` (before the line: base, number merges, conflicts, smoke), `build.sh` (build branches), `guards.sh` (guard tests, boot check) |
| `tools/deploy-queue.sh` | The line for the deploy lock, and whether another Citadel job has the CI desktop, sourced by `land.sh` and `deploy.sh`: oldest waiter first, each told its place |
| `tools/deploy.sh`, `tools/boot-check.ts` | Safe deploys: checks, front-end reloads, restarts that keep turns running, rollback |
| `tools/ci-runner/`, `src/ci-runner.ts`, `src/runner-cap.ts`, `public/runner-agent.mjs` | Every scheme's CI on self-hosted runners on Cara's desktop: the runner agent there (installed once, as SYSTEM) that adds, lists and removes a scheme's runners when a member asks through `ci_runners`, its scripts, the `runs-on` line, and the route that mints runner tokens with the scheme owner's GitHub login |
| `src/ci-store.ts`, `src/routes/ci-store.ts`, `kit/skills/ci-store/` | Citadel's own store for what CI builds, in place of GitHub's artifact storage: a job on a scheme's runner uploads to the machines address with GitHub's run token for the job (no secret), files are kept in each scheme's own folder (`projects/<id>/ci-store/`) with a `ci_files` row, read by URL or the `ci_files` tool, and swept by rule (reports 7 days, the newest 5 build runs and 10 release runs per workflow and target, 20 GiB a scheme, 60 GiB in all). The kit skill carries the upload script and the rules for workflows |
| `src/routes/all.ts`, `src/routes/app.ts`, `src/routes/projects.ts`, `src/routes/proposals.ts`, `src/routes/tickets.ts` | The HTTP routes `server.ts` mounts, one file per area: `all.ts` is the table that mounts the rest, `app.ts` the app-wide ones (status, health, settings), `projects.ts` schemes, `tickets.ts` minions and their chats, `proposals.ts` what a minion asks a person for in its chat (plans, machine notes and lending, host tools, release keys, tool-call approvals) and their verdicts |
| `src/routes/contraptions.ts`, `src/routes/desktop.ts`, `src/routes/files.ts`, `src/routes/jobs.ts`, `src/routes/machines.ts`, `src/routes/memory-curator.ts`, `src/routes/minion-jobs.ts`, `src/routes/push.ts`, `src/routes/reviews.ts`, `src/routes/schedule-api.ts`, `src/routes/skills.ts`, `src/routes/units.ts`, `src/routes/urgent.ts`, `src/routes/usage.ts`, `src/routes/workers.ts` | More routes: contraption apps, desktop update feeds, the shared folder's files, host jobs, machines, the memory curator, Web Push, the Reviewers page, a schedule's request and reply (fields, standard audit part, view), skills, systemd units, and usage |
| `src/db/artifacts.ts`, `src/db/cabals.ts`, `src/db/cards.ts`, `src/db/ci-numbers.ts`, `src/db/claude-state.ts`, `src/db/contraption-runs.ts`, `src/db/contraptions.ts`, `src/db/credentials.ts`, `src/db/deliveries.ts`, `src/db/events.ts`, `src/db/flakes.ts`, `src/db/health.ts`, `src/db/machines.ts`, `src/db/minions.ts`, `src/db/people.ts`, `src/db/push.ts`, `src/db/read-warm.ts`, `src/db/releases.ts`, `src/db/schemes.ts`, `src/db/seen.ts`, `src/db/settings.ts`, `src/db/slow-moments.ts`, `src/db/turns.ts`, `src/db/views.ts`, `src/db/wait-records.ts` | `src/db.ts`'s area files (`test/db-areas.test.ts`): a new query goes in its area's file. Artifacts, cabal boards' rows, asks and logs, CI files and pins, open and recent cards, CI numbers, saved Claude state, contraption stop and restart runs, contraptions (sessions, turns, audits, errors), credentials and secrets (OpenRouter calls too), delivery rows, the chat log's events, flaky tests, health events and host samples, machines, minions, people (users, members, what each can see), push subscriptions, the readers' warm-up, releases and what shipped, schemes and instructions, what a person has seen and pinned (the recap too), settings, the slow moments pages report (#1752), turns and what they cost, and the read-only views |
| `src/db-copy.ts`, `src/db-keys.ts`, `src/db-nocow.ts`, `src/db-view.ts`, `src/db-warmer.ts`, `src/db-writer.ts`, `src/checkpoint.ts`, `src/events-db.ts`, `src/cache-health.ts`, `src/host-check.ts` | Around the database: consistent copies, settings key builders, the no-copy-on-write file, the read-only secret-masked query (`db-view`), keeping the file in memory, the writer thread, WAL checkpoints, the chat log's own file, and the host checks a container turn asks for |
| `src/front.ts`, `src/reader.ts`, `src/reader-live.ts`, `src/read-scope.ts`, `src/only-reads.ts`, `src/handover.ts`, `src/warm-up.ts` (what a handover's new server reads before it says ready), `src/answer-time.ts`, `src/box-capacity.ts` (how many minions fit), `src/realtime.ts`, `src/loop-lag.ts`, `src/safely.ts`, `src/sd-watchdog.ts`, `src/watchdog.ts`, `src/keepalive.ts`, `src/keepalive-run.ts` (running them), `src/settled.ts`, `src/server-work.ts` | The server's threads and staying up (#1563): the front thread that owns the socket, reader threads that answer people's reads, the warm handover, answer timing, event-loop lag, keeping one failing request from taking it down, the watchdogs, and what the process is still doing |
| `src/config.ts`, `src/http.ts`, `src/proxy.ts`, `src/ports.ts`, `src/exec.ts`, `src/shell.ts`, `src/clock.ts`, `src/every.ts`, `src/pacific.ts`, `src/quote.ts`, `src/icons.ts`, `src/wording.ts`, `src/theme.ts`, `src/breathe.ts`, `src/exit-with-parent.ts`, `src/fault-points.ts`, `src/json-lines.ts` | Small shared plumbing: server.ts's settings, HTTP helpers, a stream's JSON lines, streaming to a local port, test ports, running programs, shell quoting, the clock, periodic jobs, Pacific times, icons and the words people read |
| `src/turn-*.ts`, `src/worker-wait.ts`, `src/card-wait.ts`, `src/fresh.ts` (fresh starts and their handoffs), `src/urgent.ts`, `src/start-now.ts`, `src/line-place.ts`, `src/compactions.ts`, `src/cut-offs.ts`, `src/ship-trail.ts`, `src/urgent-fixes.ts`, `src/pin-spares.ts`, `src/fallbacks.ts`, `src/sessions.ts`, `src/resumes.ts`, `src/quiet.ts`, `src/hide-tokens.ts`, `src/hook-*.ts`, `src/pre-tool-hook.ts`, `src/link-check.ts`, `src/grunts.ts`, `src/done-lines.ts`, `src/send-ids.ts`, `src/minion-queue.ts`, `src/prompt-hashes.ts`, `src/prompt-hold.ts`, `src/tool-hold.ts`, `src/prompt-cost.ts`, `src/stall-signals.ts`, `src/status-trailer.ts`, `src/minion-jobs.ts`, `src/turn-wrapper.mjs` | Turns: images, outcomes and temp files per turn, spare copies of the pinned server files, jobs `systemd-run` couldn't start in their own unit, the Claude session files a resume needs, the auto-resume waits, the worker pool and the line of turns waiting for one (`turn-line.ts`), who is marked Urgent (`urgent.ts`), whose minion has a worker of its own past the pool (`start-now.ts`), what puts one ahead inside a share (`line-place.ts`), the server's own Urgent marks (`urgent-fixes.ts`), noticing a quiet turn, hiding the GitHub token from `env`, its settings keys (`turn-keys.ts`), what a turn is given and reports (`turn-messages.ts`), the hooks every turn gets, the Stop hook that checks links, Grunts, the done-lines rule, one durable queue per minion, the jobs and waits that outlive a turn (`minion-jobs.ts`; `tools/citadel-job`), the commands a time limit cut off (`cut-offs.ts`), each ship's places and stages for the time log (`ship-trail.ts`), what each turn was launched with and what it costs, and the status line a reply ends on |
| `src/tripwire-base.ts`, `src/tripwire-blocks.ts`, `src/tripwire-git.ts` | The tripwire's pieces: base paths, the summary of what it blocks, and its git rules (`src/tripwire.ts`) |
| `src/tripwire-judge.ts` | An approval card's tripwire verdict, worked out in a worker thread so the server's thread never waits on the disk or git for it; fails closed |
| `src/time-log.ts` (where a minion's time went, cut from its stored events), `src/time-log-explain.ts` (Explain: Haiku's reading of each step, on the presser's login), `src/routes/time-log.ts`, `src/day-strips.ts` and `src/routes/day-strips.ts` (a scheme's minions that went live on a day, each cut from start to live), `src/new-minion.ts`, `src/taskmaster-files.ts`, `src/brief-lint.ts`, `src/minion-index.ts`, `src/minion-budget.ts`, `src/minion-relay.ts`, `src/held-mail.ts`, `src/needs.ts`, `src/mentions.ts`, `src/handoff-tidy.ts`, `src/held-starts.ts`, `src/reaper.ts`, `src/closing.ts`, `src/dismissed-cleanup.ts`, `src/worktree-sweep.ts`, `src/worktree-deps.ts`, `src/tmp-sweep.ts`, `src/branch.ts`, `src/builds.ts`, `src/prlinks.ts`, `src/live-facts.ts`, `src/live-state.ts`, `src/history.ts`, `src/properties.ts`, `src/property-seed.ts`, `src/first-week.ts`, `src/stuck-list.ts` | Minions: starting one and linting its brief, files relayed across schemes, searching past ones, their budgets, messages between them and what a message needs, held mail with seals, sleep and the loop guard (`held-mail`), Needs-you mentions, handoff clean-up, queued starts, what a closed one left running, dismissing one and what keeps it open (`closing`), removing a dismissed one's folders and restoring a reopened one's (`dismissed-cleanup`), sweeps of worktrees and temp files, a worktree's installed dependencies, a ticket's branch and PR, build branches, live facts, chat history, the property registry, and the first-week check |
| `src/plan-cards.ts`, `src/card-links.ts`, `src/card-twins.ts`, `src/card-starts.ts`, `src/ask-form.ts`, `src/merge-card.ts`, `src/doc-preview.ts`, `src/side-ask.ts`, `src/side-guard.ts`, `src/slash-commands.ts`, `src/show-parts.ts`, `src/mcp-media.ts`, `src/mcp-text.ts`, `src/pool-context.ts` | Cards and MCP tool answers: plan and question cards, links to them, refusing twin cards, a pick that starts its minion (#2050), forms, the PR behind a merge approval, picture previews, side asks, slash commands, and the text and media halves of `src/mcp.ts` |
| `src/ship-*.ts`, `src/armed-handoff.ts`, `src/land.ts`, `src/land-news.ts`, `src/land-reds.ts`, `src/lanes.ts`, `src/last-green.ts`, `src/rollback.ts`, `src/rollback-starters.ts`, `src/main-rollback.ts`, `src/auto-deploy.ts`, `src/deploy-watch.ts`, `src/fast-mode.ts`, `src/fix-proof.ts`, `src/critic-gate.ts`, `src/review-gate.ts`, `src/live-probe.ts`, `src/standing-checks.ts`, `src/standard-audits.ts`, `src/unit-drift.ts`, `src/unit-thp.ts`, `src/kit-sync.ts` | Shipping: the ship line and its state, risk, status and failures, ship lessons, the land tool, hand-offs armed for the pipeline lane, land lanes, last green and the rollback, telling minions cut from commits a reset took off main, auto-deploy, the post-deploy watch, fast mode, a bug fix's proof, the critic gate, the review gate, a big ship's live probe, and checks that run on a schedule |
| `src/ci-*.ts` (also `src/ci-store.ts` above), `src/flakes.ts`, `src/flake-evidence.ts`, `src/flake-fixes.ts`, `src/repeat-bugs.ts`, `src/judges.ts`, `src/incidents.ts`, `src/alert-wakes.ts`, `src/timer-alerts.ts`, `src/spend-alert.ts` | CI and what goes wrong: health, load, numbers, problems, verdicts, the land gate's alarm, mirrored runs, armed waits, flaky tests and their evidence and fixes, repeat bugs, judges, incident timelines, and the alerts that wake a Taskmaster |
| `src/app-shots.ts`, `src/shot-judge.ts`, `tools/app-shots/` | The nightly contraption screenshots (#1783): `src/app-shots.ts` starts a run a night and tells the owning scheme's Taskmaster what newly broke; `tools/app-shots/` shoots each app as a sealed copy of its deployed checkout (`sandbox.sh`, `inner.ts`) and writes the page people look at (`reports/app-shots/` in the shared folder); `src/shot-judge.ts` says what counts as broken. By hand: `node tools/app-shots/app-shots.ts --out <dir> --apps <apps.json>` |
| `src/github-link.ts`, `src/gh-api.ts`, `src/gh-helper.ts`, `src/git.ts`, `src/repo-access.ts`, `src/repo-setup.ts`, `src/scheme-repo.ts`, `src/scheme-icon.ts`, `src/scheme-refs.ts`, `src/catalogue.ts`, `src/credentials.ts`, `src/secrets.ts`, `src/claims.ts`, `src/ship-lane.ts`, `src/decisions.ts`, `src/decisions-load.ts`, `src/ideas.ts`, `src/memory-curator.ts`, `src/memory-files.ts`, `src/memory-storms.ts`, `src/container-relief.ts`, `src/instructions-save.ts`, `src/msg-settings.ts`, `src/mandate-items.ts`, `src/review-*.ts`, `src/rule-*.ts`, `src/welcome.ts` | Schemes and their rules: linking GitHub (OAuth, `gh` reads, repo access), setting a scheme's repo up, its icon, cross-scheme links, the catalogue, linked accounts and saved secrets, claims and the ship-script lane's skip and ship-together, the decisions page, the ideas ledger, the memory curator and memory notes, saving Settings text, message settings, Mandate items, the review set, one home per rule, and the welcome |
| `src/claude-link.ts`, `src/account-pick.ts`, `src/codex*.ts`, `src/openrouter.ts`, `src/azure-speech.ts`, `src/costs.ts`, `src/usage-ledger.ts`, `src/outside-spend.ts`, `src/cpu-ledger.ts`, `src/host-load.ts`, `src/host-signals.ts`, `src/pressure.ts`, `src/memory-ease.ts`, `src/container-room.ts`, `src/growth-stop.ts`, `src/load-stretch.ts`, `src/long-jobs.ts`, `src/host-job.ts`, `src/host-tool*.ts`, `src/containers.ts`, `src/machine-jobs.ts`, `src/machine-lend.ts`, `src/emulator-lease.ts`, `src/tool-suggest.ts`, `src/plugin-scan.ts`, `src/skills.ts`, `src/png-matte.ts`, `src/image-size.ts` | Accounts, spend and the box: each person's Claude plan and which account a turn uses, Codex, OpenRouter and Azure speech, what turns cost, the usage ledger, outside spend, CPU and load readings, easing off as memory runs low (#1748), each container's memory room (#1982), host jobs and host tools, rootless containers, jobs on people's machines, the emulator lease, skills and plugins, and picture helpers |
| `src/apps.ts`, `src/app-services.ts`, `src/app-snapshots.ts`, `src/app-copy.ts`, `src/app-copy-run.ts`, `src/appname.ts`, `src/contraption*.ts`, `src/make-app.ts`, `src/relay.ts`, `src/replay*.ts`, `src/pwa-check.ts`, `src/fcm.ts`, `src/backup*.ts`, `src/backup.html`, `src/artifact*.ts`, `src/chunked-uploads.ts`, `src/uploads.ts`, `src/apk-*.ts`, `src/apk-version.init.gradle`, `src/build-cache.ts`, `src/build-output.ts`, `src/desktop-*.ts`, `src/release*.ts`, `src/previews.ts`, `src/artifacts.ts` | Contraptions, files and releases: the app proxy, each app's service and data snapshots, the apps' agents, asks and errors, `make_app`, the relay between apps, chat replay, push to apps, the `/backup` chat (frozen; `backup.html`) and backup checks, artifacts, uploads, Android APK builds and releases, desktop update feeds, release targets, and previews |
| `src/inbox.ts` (`homeView`) | Home: every minion waiting on you across the schemes you belong to (`public/home.js`, #1140) |
| `src/waits.ts`, `src/frozen-ships.ts`, `src/wait-tail.ts`, `src/waits-readout.ts`, `src/chains.ts`, `src/wake.ts`, `src/outbox.ts`, `src/presence.ts`, `src/stats.ts`, `src/status-page.ts`, `src/growth-alarm.ts`, `src/ultrareview.ts`, `src/review-backfill.json` | What a minion waits on and wakes for, who waits on whom (the Chains page), the one outbox of "send this later", presence, stats, the Status page, the growth alarm on the box (#1762), frozen ships and checks (#1881), and the ultrareview trial |
| `public/app.js`, `public/core.js`, `public/resync.js`, `public/base.js`, `public/rail.js`, `public/navstack.js`, `public/page-scope.js`, `public/boot-guard.js`, `public/error-beacon.js`, `public/slow-moments.js`, `public/sw.js`, `public/index.html`, `public/appswitch.js`, `public/look.js`, `public/frames.js`, `public/extlinks.js`, `public/hidden.js`, `public/units.js`, `public/update-when.js`, `public/context-menu.js`, `public/app-menu.js` | The front end's shell: boot, shared helpers, the rail and navigation, page scope, the service worker, the page itself, the slow-load recorder (any wait over 2 s, split into server, network and tab time, shown on the Status page), the app switcher, the look of Citadel's own pages, and its right-click menu, and the one rail.js gives every app |
| `public/thread*.js`, `public/chattext.js`, `public/bubbles.js`, `public/cards.js`, `public/askcard.js`, `public/cardreply.js`, `public/replies.js`, `public/narration.js`, `public/eventcut.js`, `public/heldmsg.js`, `public/composer.js`, `public/paste.js`, `public/slash-commands.js`, `public/selectact.js`, `public/pick*.js`, `public/plan-diff.js`, `public/show-part.js`, `public/strike.js`, `public/annotate.js`, `public/recap.js`, `public/grunts.js`, `public/progress-ui.js`, `public/time-log*.js` (what its line opens to: the ribbon), `public/sidethread.js`, `public/wait.js`, `public/wait-tail.js`, `public/chains.js`, `public/waiting*.js`, `public/briefs.js` | A minion's chat: the thread and its head and groups, message text and bubbles, cards and their replies, held messages, the composer and pasting, slash commands, pickers, plan diffs, parts shown inline, struck text, image marks, recaps, Grunts, the progress bar, side threads, what a minion waits on, and the Chains page of who waits on whom |
| `public/project.js`, `public/schemes.js`, `public/scheme-switch.js`, `public/schemecounts.js`, `public/sidebar.js`, `public/home.js`, `public/mine.js`, `public/closedlist.js`, `public/propfilter.js`, `public/shared-read.js`, `public/properties.js`, `public/reorder.js`, `public/welcome.js`, `public/where.js`, `public/unused.js`, `public/help*.js`, `public/ideas.js`, `public/decisions.js`, `public/memory.js`, `public/files.js`, `public/artifacts.js`, `public/artifact-bridge.js`, `public/bridge-host.js`, `public/skills.js`, `public/settings*.js`, `public/minion-rules.js`, `public/models.js`, `public/model-table.js`, `public/reviews.js`, `public/shipping.js`, `public/ultrareview.js`, `public/status.js`, `public/presence.js`, `public/seen.js` | Pages and lists: a scheme's page, the scheme switcher and counts, the sidebar, Home and Mine, closed and filtered lists, properties, help, ideas, decisions, memory, files, artifacts and their bridge, skills, Settings, the models table, Reviewers, the ship line, the Status page, presence and seen marks |
| `public/ci*.js`, `public/code-map.js`, `public/work-flow.js`, `public/flowmath.js`, `public/codemath.js`, `public/releases.js`, `public/day-strips.js` (Status: start to live, minion by minion), `public/release-extras.js`, `public/releasemath.js`, `public/contraptions.js`, `public/jobs.js`, `public/machine-setup.js`, `public/claudeusage.js`, `public/codexusage.js`, `public/cost.js`, `public/prompt-cost.js`, `public/payer.js`, `public/secret-check.js`, `public/schedule-text.js`, `public/wco-hint.js`, `public/login-map*.js`, `public/drawers.js`, `public/workers.js`, `public/box-capacity.js` (how many minions fit), `public/worker-line*.js` | The CI page and its tabs (Code: which files to split), releases, contraptions, jobs, setting up a machine, Claude and Codex usage, costs, whose plan pays, secret checks, schedule wording, the sign-in map, drawers, the worker pool's tile, and the line for a worker with its Urgent marks |
| `public/ui/` | Citadel UI (`citadel:contraption-ui`): the components, tokens and parts served to every app at `/apps/_citadel/ui/`; `test/ui-contract.json` is its contract |
| `public/types.d.ts`, `public/types/` | The API's shapes as the pages get them, for JSDoc: the shared core (ticket, scheme, event, card, view) in `types.d.ts`, and one file per area in `types/` (chat, list, ci, releases, usage and so on); a new shape goes in its area's file (#2128) |
| `tools/citadel-*`, `tools/heavy-*`, `tools/claude-pace`, `tools/ci-*`, `tools/lane.sh`, `tools/lanes`, `tools/mem-room`, `tools/test-gate.ts`, `tools/light-check*.sh`, `tools/own-check.sh`, `tools/ship-format.sh`, `tools/ship-runs.ts`, `tools/land-core.sh`, `tools/land.local.sh`, `tools/guard.sh`, `tools/flake-proof.sh`, `tools/test-deps.sh`, `tools/test-alone.sh`, `tools/burn-in.sh`, `tools/kit-land-drift.sh`, `tools/kit-tests.ts`, `tools/run-tests.sh`, `tools/suite-runner.ts`, `tools/affected.ts`, `tools/quick-train.ts`, `tools/size-room.ts`, `tools/known-flakes.ts` | Commands on every turn's PATH and the ship and test machinery: `citadel-test`, `citadel-heavy` (and its shim and units), the nested `claude` pacer, `citadel-dev-copy`, `citadel-wait`, `citadel-where`, `citadel-replay`, `citadel-android`, `ci-failures`, ship lanes, how much memory heavy work has room for, the light and own checks, the formatting of a ship's own files, a ship's room in the size list after the ships in line, ships' CI runs before and after a moment, the shared core of `land.sh`, the push guard, flake proofs and the test runners |
| `src/types-only.ts`, `tools/types-only.ts` | Is a change types-only (#2143): a file's tokens compared with base's once Node strips the types, comments, redundant parentheses and line breaks no semicolon reads are gone. Self-review's `TYPES ONLY` fact and the critic gate read it |
| `tsconfig.json`, `tsconfig.public.json`, `tsconfig.sw.json`, `tools/typecheck.ts` | The type check (#1789): tsc over server.ts, `src/`, `tools/`, `test/` and `kit/`, and the front end's JSDoc (`public/`, #2010), plus a count of explicit `any`, `as unknown as` and `@ts-ignore` per file, held to `test/typecheck-baseline.json`, which only goes down (`test/typecheck.test.ts`) |
| `src/code-counts.ts`, `tools/code-counts.ts` | The Releases page's Code tab: each scheme's files counted from git once a day, in a process of its own (kept in `DATA_DIR/code-counts/<scheme id>.json`) |
| `src/work-flow.ts`, `src/db/flow.ts`, `tools/work-flow.ts` | The Releases page's Flow tab: each minion's kind, way to main and ending, from its chat, releases and git |
| `src/cabal-board.ts`, `src/cabal-cards.ts`, `src/routes/cabals.ts`, `src/mcp-cabal.ts`, `public/cabal.js`, `public/cabal-card.js` | A cabal's board (#2090): a lead (the cabal's Overseer) and its members, each row's state, merges, claims, start_after, spend and risk read from facts, notes, asks and the lead's log; the `cabal_board` tool, the ledger panel in the lead's chat and the board's page, and the one card each open cabal is in the minions list (#2092) |
| `src/cabal-start.ts` | A cabal lead's hands (#2091): the forming card whose go approves the roster, `cabal_start` from an approved row, the width and its next-up starts when a member merges, closes or is sealed, and `cabal_member` (unseal, stop, reseal its own members) |
| `tools/doc-map.sh`, `tools/who-touches`, `tools/who-uses`, `tools/stale-docs`, `tools/handoffs-sweep.ts`, `tools/commit-titles.sh`, `tools/open-requests.ts`, `tools/ship-numbers.ts`, `tools/review-escapes/`, `tools/tier-scorecard.ts`, `tools/stall-split.ts`, `tools/typing-lag.ts`, `tools/has-cost.ts`, `tools/advisor-trial.ts`, `tools/watchdog*`, `tools/memory-cap-trial.sh`, `tools/taskmaster-room-trial.sh`, `tools/prompt-hold-readout.ts`, `tools/events-unsplit.ts`, `tools/codex-login-check.ts`, `tools/parse-check.ts`, `tools/win-test-box/`, `tools/android/`, `tools/plugins/`, `tools/drills`, `tools/jobs-runner/` | Helpers and measurements: map a doc's sections, see who touches a file, who uses a file or symbol and which tests reach it, find stale docs, sweep handoffs, count requests and typing lag, ship numbers and review escapes, the trials, Windows test box setup, Android and plugin helpers, the fault drills and the host jobs runner |
| `tools/dev-copy.ts`, `tools/fmt`, `biome.json`, `test/format.test.ts`, `test/format-own.test.ts`, `tools/dev-seeds.ts`, `tools/dev-seeds-flow.ts`, `tools/dev-seeds-cabal.ts`, `tools/ui-shot.ts`, `tools/ui-sweep.ts`, `tools/app-ui-gate.ts`, `tools/boot-check-claude.ts`, `tools/progress-reporter.ts`, `tools/failed-files-reporter.ts`, `tools/fix-replay.ts`, `tools/judge-replay.ts`, `tools/judge-replays/`, `tools/prompt-eval`, `tools/prompt-evals/`, `tools/skill-evals/`, `tools/skill-trigger-eval` | Dev copies and their seeded states, screenshots and the whole-app UI sweep, the app UI gate, the test reporters, and the replays and evals for fixes, judges, prompts and skills |

## Running

Configuration comes from the environment; `src/config.ts` reads it once for `server.ts`, with each setting's type and default:

| Variable | Default | |
| --- | --- | --- |
| `COORDINATOR_PASSWORD` | (required, 12+ chars) | The admin's master password: it signs in as the admin whose login is typed (or the first admin for any other login). Never hand it out; invite people instead |
| `COORDINATOR_ADMIN` | `Cara` | Name of the admin made on first start, when the database has no people yet; their login is the name in lower case |
| `SESSION_SECRET` | (required, 32+ chars) | Signs session cookies, and encrypts people's linked accounts: changing it unlinks everyone's GitHub |
| `CITADEL_CONTRAPTIONS_DIR` | `~/.config/citadel/contraptions` (another `DATA_DIR`: its `contraptions/`) | Where each contraption's key folder goes (`<name>/identity.pub`, `<name>/contraption.key`), which its own service reads |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | (unset, and no GitHub App either: turns use the box's gh login) | The OAuth App people link their own GitHub through (below) |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` / `GITHUB_APP_SLUG` | (unset: no limited links) | The GitHub App behind the limited way to link GitHub, and its URL name for the install link (below) |
| `CITADEL_EMBED_URL` / `CITADEL_EMBED_MODEL` | `http://127.0.0.1:21434` / `Qwen3-Embedding-0.6B-Q8_0` | Semantic memory's embedding service, and the model name stored with each vector: a new name embeds everything again |
| `CITADEL_MEMORY_SCHEMES` | (unset: every scheme) | Comma-separated scheme ids whose chats get indexed for search by meaning |
| `HOST` / `PORT` | `127.0.0.1` / `8573` | Listen address |
| `DATA_DIR` | `~/.local/share/claude-coordinator` | Database, clones, worktrees |
| `CLAUDE_BIN` | `claude` | Claude Code executable |
| `APPS_DOMAIN` | (unset: contraptions at `/apps/<name>/` on Citadel's host) | Each contraption on its own host, `<name>.<APPS_DOMAIN>` (live: `citadel.zip`), so its page can't reach Citadel's API or login; people are shown `https://<name>.<APPS_DOMAIN>/` as its link while the app keeps serving under `/apps/<name>/`; needs `*.<APPS_DOMAIN>` to reach the app with `Host` intact ([ADR 0005](docs/adr/0005-contraptions-on-subdomains.md)) |
| `CITADEL_PUBLIC_URL` | `https://citadel.zip` (a dev copy or preview: the host it was reached at) | Citadel's address in links handed to someone else: invite and reset links, a machine's setup url, the desktop feed (`publicOrigin` in `src/http.ts`) |
| `MACHINES_URL` | (unset: agents use the app's address) | Private address machines' agents connect to, e.g. `http://perigee.tail59477f.ts.net:8574`; the app listens there for agents only |
| `PUSH_SUBJECT` | the app's address, from the first subscribe | VAPID contact (`https://…` or `mailto:…`) push services see |

**A dev copy** (to try a change, curl the API or take screenshots): `tools/citadel-dev-copy start|seed|env|stop`
(`--help`) runs one on its own port and a copy of the data. Never start `server.ts` by hand from a worktree:
without `DATA_DIR` and `PORT` it opens the live database. `node tools/ui-shot.ts` drives a page on it.

On perigee the secrets live in `~/.config/claude-coordinator/env` (mode 600,
never committed) and the app runs as a user service:

```sh
ln -s ~/claude-coordinator/deploy/claude-coordinator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-coordinator
journalctl --user -u claude-coordinator -f
```

The service runs with `UMask=0077`, so the database and everything it writes are
private (mode 600). `citadel.slice` caps the service and everything it runs (host turns, lands,
each person's container) at `MemoryMax=22G` and `MemorySwapMax=12G` of perigee's 29G, which is shared
(`resources.conf` puts the service in it; the numbers behind it are in the file). `citadel-turns.slice` gives host turns no cap of their own and protects their first 8G from reclaim (`MemoryLow=8G`, #1338: turns slow down rather than being killed at their own slice's line), `citadel-builds.slice` another 10G beside it for ships, kit-sync and fast-verify, `citadel-heavy.slice` the heavy commands a turn runs itself, each in a scope of its own (`tools/heavy-unit`: throttled from 8G, and past 10G the kernel kills only that command, never its turn), `citadel-taskmasters.slice` 6G (2G of it kept from reclaim) and more CPU for Taskmaster turns, on the host and in each person's Taskmaster container, and the shared tools pool, which oomd passes over, and each person's other container's own unit caps it at 14G (throttled from 12G). `contraptions.slice` caps the apps at 5G, once their units name it. systemd-oomd's rules for these slices (who it kills first, and when) are drop-ins installed apart: `deploy/oomd.md`. `claude-coordinator.socket` holds port
8573 while the server restarts, so requests then wait instead of failing
(`socket.conf` makes the service use it). `priority.conf` keeps the server out of swap and
ahead of the turns for CPU; it and the host settings that go with it are in `deploy/priority.md`:

```sh
mkdir -p ~/.config/systemd/user/claude-coordinator.service.d
# link only files the live checkout has: a link to a missing unit file breaks every new turn's unit (#504)
for f in citadel.slice citadel-turns.slice citadel-builds.slice citadel-heavy.slice citadel-taskmasters.slice contraptions.slice; do test -e ~/claude-coordinator/deploy/$f && ln -sf ~/claude-coordinator/deploy/$f ~/.config/systemd/user/ || echo "missing: $f, land it first"; done
ln -s ~/claude-coordinator/deploy/claude-coordinator.socket ~/.config/systemd/user/
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/resources.conf ~/.config/systemd/user/claude-coordinator.service.d/
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/socket.conf ~/.config/systemd/user/claude-coordinator.service.d/
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/priority.conf ~/.config/systemd/user/claude-coordinator.service.d/
ln -s ~/claude-coordinator/deploy/claude-coordinator.service.d/watchdog.conf ~/.config/systemd/user/claude-coordinator.service.d/
systemctl --user daemon-reload
```

The socket takes effect at the next restart after that; until then the server
binds the port itself.
`watchdog.conf` (#1135) restarts a hung server: link it only once the live server pings
(`src/sd-watchdog.ts`), then restart, since the server reads the watchdog's limit at start;
`tools/watchdog-trial.sh` tries it on a scratch unit first.

**Backups.** `deploy/backup.sh` takes an online copy (`VACUUM INTO`, one read transaction) at 04:00 into
`$DATA_DIR/backups/`, checks the copy restores (integrity check plus the core
tables), and keeps 7 dailies and 4 weeklies (hard links), mode 600. Hand-made
`backups/coordinator-before-<what>.db` copies go once they are 7 days old.
Session state (`claude_state`, most of the bytes) lives in `state.db` beside
`coordinator.db`, attached by the server; it gets its own `state-<day>.db`, 3
dailies and no weeklies. The chat log (the `events` table) lives in `events.db`
beside it (#1169), attached as `chat`; it gets `events-<day>.db` and
`events-weekly-<week>.db`, kept like the main ones. Previews copy all of it, the
boot check only open minions' chats, and the pre-deploy copy only `coordinator.db`.
Then `deploy/offbox.sh` refreshes `$DATA_DIR/offbox/`, the copy
set Cara's Windows desktop pulls each morning over SSH (dailies and weeklies with
linked-account secrets stripped, the newest `state-*`, and each contraption's
newest 7 days of `~/.local/share/<app>/backups/<day>/`); setup is in
`deploy/desktop/README.md`. To restore, stop the service and copy a backup over
`coordinator.db` (and a `state-*` one over `state.db`, an `events-*` one over
`events.db`), removing their `-wal`/`-shm`. With the service stopped,
`node tools/events-unsplit.ts <coordinator.db> --service-stopped` puts the chat log
back in the main file, for a release older than the one that reads `events.db`.

**Pruning.** `deploy/prune.sh` lists, and with `--apply` deletes, the session
state (`claude_state`) of minions closed over 14 days ago. Worktrees are the
server's: daily, it removes a dismissed minion's worktree 3 days after its latest
dismissal, and Grunt worktrees (`.claude/worktrees/agent-*`) no running turn can
be using, keeping branches and saving work not on them to `refs/citadel/saved/`
first; a reopen brings the folder and that work back (`src/worktree-sweep.ts`).
`--stale-backups` also removes the ad-hoc `coordinator.db.backup-*` and
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

**Installed or not.** Every unit and drop-in in `deploy/` is checked against `~/.config/systemd/user/` at boot and every 6 hours (read-only, `src/unit-drift.ts`): Settings > Units (admins) lists each as installed, missing or different with its fish install command, and Citadel's members get one push when one newly goes missing or different. A unit kept out on purpose goes in `deploy/not-installed.txt`.

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

**Android emulator.** `tools/citadel-android` (on every turn's PATH) drives one shared headless
emulator, the `citadel` AVD that `tools/android/install-sdk.sh` makes. It runs in a WSL distro on
Cara's desktop, started on demand and stopped after 15 idle minutes; a tunnel from there puts its
starter (`127.0.0.1:18590`) and its console and adb ports on this box's loopback, and the adb server
stays here (`deploy/citadel-android-adb.service`). Setup and the switch-over:
`deploy/desktop/android/README.md`. The `citadel:android-app` kit skill has
the loop.

**Semantic memory.** `deploy/citadel-embed.service` runs llama-server with
Qwen3-Embedding-0.6B on `127.0.0.1:21434`, at nice 10 on 4 threads. Every minute the
server embeds what was said since its last pass in the indexed schemes, and minions and
the Taskmaster there get the `search_memory` tool. Without the service, indexing waits
and search answers 503; nothing else changes. To install it (downloads llama.cpp and the
model, about 660 MB, checked against pinned hashes):

```sh
bash ~/claude-coordinator/deploy/embed-install.sh
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
unit file to install), with the host network, `--userns=keep-id` and a memory limit
(throttled past 12 GB, killed past 14). Their Taskmasters' turns run in a second one,
`citadel-claude-<user id>-tm`, on the same volume, login and mounts but with its own
limit (3 GB and 4) in `citadel-taskmasters.slice`, so minions filling the first can't
slow or kill them (#1882; `tools/taskmaster-room-trial.sh` measures it).
It mounts the data dir's `projects/`, its own turns' folder `run/turns/person-<user id>/`
(never the host's turns or another person's), the schemes' memory folders,
Claude Code's versions folder and the tool folders (read-only), and never `~/.ssh`,
`~/.config/gh`, the server's `~/.claude`, the database or the user bus. A turn goes
in with `podman exec -d … node src/turn-wrapper.mjs`; its liveness is a heartbeat
file. Usage is kept per person (`usage:user:<id>`). If Anthropic turns the login
down mid-turn, the link is marked expired and the turn says so. Unlink signs out,
stops both containers and deletes the volume. A turn in a container lands with the
`land` tool (mcp__thread), which runs `tools/land.sh` on the host for it, since
podman and systemd aren't reachable from inside, and a land.sh in the container can't see
the host's landings in line. That goes for every scheme, so landing is the one thing a
container turn runs outside its container: its worktree's `tools/land.sh`, as the server's
user and with the box's GitHub login. The tripwire keeps turns away from
`citadel-claude-*` containers and podman's storage.

**Codex reviews (#330).** The image also has the Codex CLI, pinned, so self-review
can get a second opinion from another model family on the person's own ChatGPT
plan: `citadel-codex-review` (`src/codex-review.ts`, on every turn's PATH) drives
`codex app-server` in a read-only, ephemeral thread and prints the review. The
person signs in from Settings → Your account (`src/codex-link.ts`), which runs
`codex login --device-auth` in their container and shows OpenAI's link and code; the
login stays in `~/.codex/auth.json` in their volume, which the tripwire won't let a
turn read. The image's `/etc/codex/requirements.toml` (`deploy/claude-container/codex/`)
runs Citadel's tripwire as Codex's only hook, failing closed: the hook reads the
turn's config from the file `$CITADEL_CODEX_TRIPWIRE` names, allows shell commands
only, and blocks the tripwire's ask tier. A review won't run on the host or in a
container built before this, which have no managed hook. The server login's turns run
on the host, so once it has signed in to Codex (#341's Codex container), the runner
names that container in their Codex config and a review from them runs there (#398):
`podman exec` of a copy of the driver and the turn's tripwire, put in the person's
mounted turns folder, against the same worktree path; that copy checks the hook and
sign-in itself. A host turn also starts that container if it stopped. It reads the person's Codex
usage first and skips the review when the 5-hour or weekly window is 80% used or
running ahead of an even pace to its reset, so reviews never max out their plan.
`--image <path>` (repeatable, #408) attaches a screenshot or art sheet as one of Codex's
local image inputs, for critique's cross-family pass on visual work; it takes only image
files inside the worktree or the turn's shared folders.

**People's own GitHub.** With an OAuth App set up, each person links their GitHub
in Settings → Your account, and a turn pushes and opens pull requests as the
person it runs for (who sent its messages; a relay counts as its sender's
person). A turn for someone who hasn't linked gets no GitHub login at all, so it
commits but can't push, and says so. Without the OAuth App, turns use the box's
own `gh` login as before. To set it up, once:

1. On github.com: Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers) → New OAuth App.
   Homepage `https://citadel.zip`, and a redirect URI per hostname people
   reach Citadel at (up to 10; #489): `https://citadel.zip/api/github/callback`
   and, for the old alias, `https://cara.apps.webplatformisbestplatform.net/api/github/callback`. Citadel sends GitHub the one for the hostname the person
   is on, so a hostname left out fails to link with "redirect_uri mismatch". Leave wildcard matching,
   "Enable Device Flow" and "Expire user access tokens" off.
2. Generate a client secret, and add both to `~/.config/claude-coordinator/env`
   as `GITHUB_CLIENT_ID=…` and `GITHUB_CLIENT_SECRET=…`, then restart.
3. Link your own GitHub too: from then on an unlinked person's turns, the
   admin's included, can't push.

**A limited GitHub link (#464).** Beside the OAuth App's full access, a person can link through a
GitHub App instead. That token reaches a repo only when the repo's owner installed the App on it and
the person already has access to it
([GitHub's docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)),
so nothing else in their account. Settings → Your account then offers both ways and lists what a
limited link reaches. To set it up, once:

1. [Register a new GitHub App](https://github.com/settings/apps/new). Homepage
   `https://citadel.zip`, callback URL
   `https://citadel.zip/api/github/callback` (add one per hostname people
   reach Citadel at, up to 10, as for the OAuth App). Setup URL
   `https://citadel.zip/api/github/installed` (an App registered earlier with the old host there keeps working), with **Redirect on update**
   ticked: installing the App links nothing, so this brings people back from GitHub and, if they have
   no link yet, straight on to Link GitHub (limited). It takes one URL, so someone who installs the App
   from another hostname comes back on this one and may have to sign in there once. Leave "Request user authorization (OAuth) during
   installation" and "Enable Device Flow" off. Untick **Expire user authorization tokens**: GitHub's refresh kills the old
   token at once, which would cut off a person's other running turns
   ([refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)).
   Untick Webhook → Active.
2. Repository permissions: **Read and write** for Actions, Administration, Contents, Issues, Pull
   requests and Workflows; **Read-only** for Checks, Commit statuses and Metadata. Administration is what
   collaborator invites, CI runner tokens and making a repo use; it only works for a person who is
   already an admin of that repo. No account or organization permissions.
3. "Where can this GitHub App be installed?": **Any account**, since other people's and organizations'
   repos need it too.
4. Create it, then on the App's page press **Generate a new client secret**. Add three lines to
   `~/.config/claude-coordinator/env`: `GITHUB_APP_CLIENT_ID=…` (the Client ID, not the App ID),
   `GITHUB_APP_CLIENT_SECRET=…`, and `GITHUB_APP_SLUG=…` (the name in the App's public URL,
   `github.com/apps/<this>`). No private key is needed. Then restart.
5. Install the App (its page → Install App) on each account that owns a scheme's repo, choosing the
   scheme repos or all. Only a repo's owner can do this for their own repos; Settings → Your account
   links to the install page and says the order: install on your repos, then link.

If GitHub hands back an expiring token anyway, Citadel links nothing, tells the person it's on
Citadel's side, and Settings → People shows the admins who was refused and the setting to untick.

A scheme owner on a limited link needs the App on the scheme's repo for invites, CI runner tokens and
the server's own reads of the repo (fetches, pull-request state, merges) to work, and a repo moved to another account needs the App installed by its new owner.

Tokens are kept encrypted with a key from `SESSION_SECRET`; changing that secret
leaves every link needing linking again. Deploys still push `main` with the box's
`gh` login, and the pull-request watcher reads with it.

### Deploying

A minion lands its branch with `tools/land.sh`, run from its worktree. Under
the deploy lock it rebases the branch onto the local `main`, waits for the full
suite to pass on that exact commit, fast-forwards `main` in the scheme repo, then
runs `tools/deploy.sh`. The suite runs on Cara's desktop
(`.github/workflows/tests.yml`, on a scratch branch `land/<branch>`); when no
runner is online or CI doesn't answer in time, `land.sh` prints `CI FALLBACK` and
runs it on perigee instead (`LAND_CI=0` forces that). A conflict
or a red test stops it before `main` moves; a deploy whose checks fail puts
`main` back too.

Usually the minion doesn't run it itself: it hands the land off with the
`hand_off_land` tool (mcp__thread, #706) and ends its turn, so a clean land costs no
model calls. The server refuses uncommitted work at once, runs `tools/land.sh` in the
worktree as the `land` tool does (a host job under `run/landings/<minion>/`, which
outlives the restart it queues), and polls it every 5 s (`LandHandoffs` in
`src/land.ts`). On exit 0 it posts the shipped line (commit, the minion's summary and
risk label, live or waiting) and dismisses the minion, or sets pending-deploy when the
restart is still to come. In a scheme that owns contraptions, a clean land on `main`
first deploys them (#712, through auto-deploy's start, `deployApps` in `src/land.ts`) and
waits: the shipped line says whether each went live, a failed one wakes the minion with
its log, and `deploy: false` on the hand-off skips it. Exit 75 seals it until the scheme's runners are back. Any
other exit, a cut-off run included, wakes the minion with the end of the output. A
message for the minion while its land waits (a person's or a relay, not a GitHub
notice) keeps it open: it is told the result instead of dismissed. A build minion's
`--into build/<n> --full` isn't handed off, since it isn't the end of its work.

A big feature can run as a build: a branch `build/<n>` its minions merge into and
that lands on `main` once (the design is `specs/build-branches.md` in the scheme's
shared folder). `tools/land.sh --into build/<n> <test files>` merges a feeder in:
it rebases onto the build, runs only the named test files and moves the branch,
with no CI, no deploy and `main` untouched. `--into build/<n> --full` is the build
minion's merge of `main`, on the full suite in the lands' line, and `--build` lands
the build: `main` comes in by merge, not rebase, so the build's merges and its
feeders' commit hashes survive, then the gate and deploy as above, then the branch
is deleted. A plain land refuses a branch that carries a build's commits.

Landings and deploys wait for the deploy lock in a line (`tools/deploy-queue.sh`),
oldest first: each takes a numbered ticket in `.git/cc-deploy/queue/` of the live
checkout, and only the oldest ticket tries the lock. A waiter prints its place, an
estimate from the last few landings, and what the one ahead is doing. It has no
time limit while the line moves; it gives up only after 15 minutes with no change
at the head of the line (no new head, no new phase), which means the holder is
stuck and a person needs to look. A waiter whose process is gone drops out by
itself, so a stopped run loses its place: run `land.sh` in the background with a
long timeout.

The queued restart has a lock of its own, the restart lock (`.git/cc-deploy/restart.lock`),
from its database copy until it has its verdict and has reported. So it restarts at
once, and the next landing in line rebases and waits for CI beside it. That landing
takes the restart lock before it moves `main` or the live checkout, so neither moves
while a restart is still being judged. If the restart is rolled back and its commit
comes off `main`, the landing behind rebases without it and waits for CI again.

When the deploy's boot check fails, `deploy.sh` leaves `.git/cc-deploy/refusing` in the
live checkout, and removes it when a boot check next passes. While it is there, each
landing runs the boot check on its rebased commit before its CI run: a commit that
fails is refused at once ("deploy has been refusing since ..."), with no CI run spent,
and one that passes (the fix, say) lands as usual. To turn that off, set
`LAND_PREFLIGHT=0` for one landing, or `touch ~/claude-coordinator/.git/cc-deploy/preflight-off`
for all of them.

`tools/deploy.sh` on its own deploys whatever is on `main`. Restarting doesn't
interrupt turns:

1. It fast-forwards `~/claude-coordinator` to `main`, runs `node --test` (unless
   `land.sh` just had it pass on that same commit, in CI or here, with no files outside the commit
   in its worktree or here), and boots the new code on a spare port against a copy of the database
   (`tools/boot-check.ts`: `node --check` on `public/*.js`, `/api/health`, the
   app signed in and rendered in Playwright's headless Chromium with no console
   error, the file viewer's details of a linked and a shared file, and a minion
   turn and a Taskmaster turn started through the runner's real arguments with
   `tools/boot-check-claude.ts` as claude: each turn's MCP server answers
   initialize and read-only calls, the Taskmaster's including `read_ticket` on
   the longest open chat and the scheme instructions, and no launch argument
   passes 100 KiB, with the busiest scheme's worktree folders mirrored). If any
   of that fails it puts the checkout back and exits non-zero; nothing restarts.
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
   new commit, checks again 30 s later (the same 30 s to answer, as the first
   minute after a restart is slow, and the same server process), and only then
   tags it `last-good` and reports. If it doesn't come up or stay up, it resets
   to `last-good` and restarts again. `tools/deploy.sh --now` restarts without
   waiting, cutting off those turns (#33's auto-resume picks them up); the
   tripwire asks a person before it runs. It takes a place in the line and
   runs the checks again first; for a restart that is already queued and
   waiting on turns, `touch ~/claude-coordinator/.git/cc-deploy/now` (the
   same person's OK) sends it ahead within 10 s instead.
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

The limits are environment variables, for a person who needs to change one for
a run (the defaults are set for perigee; each script's comments say more):

| Variable | Default | What it limits |
|---|---|---|
| `LAND_CI_START` | 90 s | `land.sh`: wait for a runner to take the CI job while none is online, then fall back |
| `LAND_CI_START_ONLINE` | 900 s | `land.sh`: the same wait while a runner is online but busy |
| `LAND_CI_TIMEOUT` | 540 s | `land.sh`: wait for the CI run to finish once a runner took it, then fall back |
| `LAND_CI_DOWN` | 600 s | `land.sh`: after a landing's CI wait ran out, the next landings skip CI for this long |
| `LAND_BUILD_WAIT` | 3600 s | `land.sh --into`, `--full`, `--build`: wait for the run on the same build ahead of it |
| `DEPLOY_QUEUE_STALL` | 900 s | the line: give up when nothing at its head has moved for this long |
| `DEPLOY_TEST_TIMEOUT` | 600 s | `run-tests.sh`: the suite on perigee (a ship's fallback gives it longer: `fallback_limit` in `land.sh`) |
| `DEPLOY_BOOT_TIMEOUT` | 600 s | `deploy.sh`: the boot check, from outside (it gives up by itself at 180 s, counted afresh up to three times) |
| `DEPLOY_UNKNOWN_WAIT` | 60 s | the queued restart: a server that is up but doesn't answer, before it restarts anyway |
| `CITADEL_HEAVY_MAX_WAIT` | 3600 s | `citadel-heavy`: give up (exit 75) when no slot has changed hands for this long |
| `CITADEL_HEAVY_HEAD_STALE` | 60 s | `citadel-heavy`: a head of the line silent this long is stopped, and jobs go past it |
| `CITADEL_HEAVY_HERE` | unset | `citadel-heavy`: `1` keeps a job on perigee (as `--here`), never on the repo's CI |
| `CITADEL_HEAVY_CI_SLOTS` | 1 | `citadel-heavy`: heavy jobs one repo may have on its CI at once; the rest wait on perigee |
| `CITADEL_HEAVY_CI_QUEUE` | 600 s | `citadel-heavy`: a CI job no runner takes this long, while nothing else runs on the repo's CI either (the desktop is off), is cancelled and runs on perigee; while the runners are busy it keeps waiting |
| `CITADEL_HEAVY_PLAIN_SLOTS` | 1 | `citadel-heavy`: perigee slots plain jobs share, at nice 19; deploy and APK builds get one more of their own |
| `CITADEL_HEAVY_JUDGE` | on | `citadel-heavy`: `0` sends every job to the line, as before #1629; otherwise only heavy jobs queue and light ones run here at once |
| `CITADEL_HEAVY_MIN_RUN` | 180 s | `citadel-heavy`: a job is heavy only when its last runs' median is at least this long… |
| `CITADEL_HEAVY_MIN_CPU` | 75 % | `citadel-heavy`: …and their median CPU time (over all cores) is at least this share of it; jobs that run Claude are always light |
| `CITADEL_HEAVY_GUESS` | light | `citadel-heavy`: what a job with no past runs counts as; `heavy` is `--heavy` for every job |
| `CITADEL_PACE_SPACING`, `CITADEL_PACE_HOLD` | 60 s, 600 s | `claude-pace` (a turn's nested `claude`, #1748): while Citadel eases off memory, one nested session of a turn starts per spacing; while it's tight they hold, at most this long |

## Permissions

Headless turns can't show a permission prompt, so every minion runs in
`bypassPermissions`: full access as the service user. What would still prompt
goes to the `approve` tool (below), which shows a card only for a tripwire ask
or a scheme's approval rules and denies anything else. The Taskmaster's prompts
are denied (`--permission-prompts none`).

**Needs approval (Minion rules).** A scheme can list Claude Code permission rules, such as
`Bash(gh pr merge:*)` or `mcp__*__merge_pull_request`, in the "Needs approval" list on the "Minion rules"
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

## stale-docs (#1164)

`tools/stale-docs` (on every turn's PATH, plain JS, any scheme's repo): `stale-docs refs` fails when a backticked path in CLAUDE.md, README.md, `.claude/skills/*/SKILL.md` or `.claude/rules/*.md` isn't in the repo (a repo's `.stale-docs-allow` lists the on-purpose ones, each with a reason; nested CLAUDE.md/AGENTS.md and a copied skill's other `.md` files count, `template/` folders don't). `stale-docs refs --new-since <rev>` reports only pairs not already dead at `<rev>`: land.sh's smoke check runs it in every scheme's repo (#1395), so a plain ship that adds a dead path is refused before the line and old debt never blocks one; `stale-docs shared --dir <shared folder> --refs <repo> <memory folder> --pins <file>` lists which `handoffs/` and `specs/` files nothing points at, and `stale-docs archive --list <approved list> --refs <the same paths>` moves only those to `archive/`, never deleting.
