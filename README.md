# Claude Coordinator

A shared web UI for running headless Claude Code sessions as **tickets**. Several
people sign in, open a project, and talk to its **coordinator**: a long-lived
Claude session that creates, messages, renames and closes the project's other
tickets. A sidebar lists the tickets (running, waiting for input, errored,
closed), and any ticket can also be opened and chatted with directly. Each
ticket is one Claude Code session working in its own git worktree.

This is the proof-of-concept stage: tickets, chat, live output and a board.
Planned next: runners on other people's own Claude logins.

## How it works

- Each chat message spawns one `claude -p --input-format stream-json --output-format stream-json` process
  in the ticket's working directory, with `--resume <session_id>` after the
  first turn. Idle tickets cost nothing, and a restart loses nothing.
- Every stream event is stored in SQLite and pushed to browsers over
  server-sent events.
- Messages sent while a turn is running are queued and sent together as the
  next turn. Messages reach Claude as `[Name]: text`.
- Tool calls stay out of the chat. Turns run with
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` so Claude can plan with
  TaskCreate/TaskUpdate, and `public/progress.js` (shared by the server and the
  browser) replays the events into a readout in the thread bar:
  "Running tests… 3/7", expandable to each step and the tool calls made while
  it was in progress. Each turn leaves one collapsed "Turn finished · N
  actions" line in the chat, and board cards show the same summary line.
- Images pasted, dropped or attached in the composer are shrunk in the browser
  if needed, saved under `projects/<id>/uploads/<ticket>/`, and sent to Claude
  as image blocks alongside the message text.
- `projects/<id>/shared/project/` is a folder every thread and the coordinator can read and
  write (`--add-dir`, plus a line in the system prompt) for handoffs, specs and notes. Its
  documents and pages show as a "Shared" group on the artifacts shelf. The coordinator can
  also read and write the repo's Claude Code memory folder, still with no shell.
- Opening a project creates its coordinator ticket on first visit. Its turns
  run with an extra MCP server (`src/mcp.ts`) whose tools call this app's API
  with a bearer token that only reaches that project's tickets (never the
  coordinator itself). The token is passed in the environment, not on the
  command line, so other users on the box can't read it from `ps`.
- Each project can have **instructions** (up to 16,000 characters), edited from the
  overview panel. They're appended to the system prompt of the coordinator and every
  ticket, so they apply from each one's next turn. "Import from Claude Code" lists
  the instruction and memory files of the login the app runs as (`~/.claude/CLAUDE.md`
  and `rules/`, the repo's `CLAUDE.md` files, and auto-memory) to add with a tick.
  A file upload or a paste works too. The coordinator can read and change them
  with its `get_project_instructions` and `set_project_instructions` tools.
- **Machines** lend threads MCP servers that run on people's own computers, such as a
  Godot editor that runs builds on a laptop. Add one in the overview panel's Machines
  section; the app shows a one-time token and a command to run there, which downloads
  `public/machine-agent.mjs` (Node 18+, no installs) and starts it with the MCP server's
  command. The agent dials out to the app and holds an event stream open, so the computer
  needs no open ports and can be anywhere. Every thread turn (not the coordinator) gets each
  machine that is online when it starts as an MCP server named after the machine
  (`mcp__<name>__…`): a small stdio proxy (`src/machine-mcp.ts`) relays through the app
  (`src/machines.ts`), and the agent runs a separate copy of the MCP server per session.
  Tokens are stored hashed; a new token or removing the machine disconnects it.
- Projects with a repo URL are cloned once; each ticket gets
  `git worktree add -b ticket/<id>-<slug>` from the default branch.

No dependencies: Node 24+ runs the TypeScript directly (type stripping) and
uses the built-in `node:sqlite`.

## Layout

| Path | What |
| --- | --- |
| `server.ts` | HTTP server, JSON API, SSE stream, static files |
| `src/runner.ts` | Spawns `claude` turns, parses stream-json, queues messages |
| `src/mcp.ts` | MCP server giving the coordinator its ticket-management tools |
| `src/approvals.ts` | Approval rules, plugin folders, and the Approve / Deny cards |
| `src/machines.ts` | Relays MCP traffic between thread turns and connected machines |
| `src/machine-mcp.ts` | Per-turn stdio stand-in for a machine's MCP server |
| `public/machine-agent.mjs` | Agent people run on their own computers to connect them |
| `src/workspace.ts` | Clones project repos, creates per-ticket worktrees |
| `src/instructions.ts` | Finds Claude Code instruction and memory files to import as project instructions |
| `src/db.ts` | SQLite schema and queries |
| `src/auth.ts` | Shared-password login, signed session cookies |
| `public/` | Front end (vanilla JS, no build) |
| `public/progress.js` | Task-list and step tracking, shared with the server |
| `deploy/claude-coordinator.service` | systemd user unit |

## Running

Configuration comes from the environment:

| Variable | Default | |
| --- | --- | --- |
| `COORDINATOR_PASSWORD` | (required, 12+ chars) | Shared sign-in password |
| `SESSION_SECRET` | (required, 32+ chars) | Signs session cookies |
| `HOST` / `PORT` | `127.0.0.1` / `8573` | Listen address |
| `DATA_DIR` | `~/.local/share/claude-coordinator` | Database, clones, worktrees |
| `CLAUDE_BIN` | `claude` | Claude Code executable |

On perigee the secrets live in `~/.config/claude-coordinator/env` (mode 600,
never committed) and the app runs as a user service:

```sh
ln -s ~/claude-coordinator/deploy/claude-coordinator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-coordinator
journalctl --user -u claude-coordinator -f
```

Turns run as the service's user with that user's Claude Code login, so every
ticket currently uses Cara's account.

## Permissions

Headless turns can't show a permission prompt, so every ticket runs in
`bypassPermissions`: full access as the service user. Anything that would still
prompt is denied (`--permission-prompts none`).

**Needs approval.** A project can list Claude Code permission rules, such as
`Bash(gh pr merge:*)` or `mcp__*__merge_pull_request`, in the overview panel's
"Needs approval" section (or the coordinator's `set_project_settings` tool). Its
threads then run with:

```
--permission-mode bypassPermissions
--permission-prompts host
--permission-prompt-tool mcp__thread__approve
--settings '{"permissions":{"ask":[<the rules>]}}'
```

`ask` rules are still checked in `bypassPermissions`, so only matching calls
prompt; everything else runs as before. (`--permission-prompts none` would deny
them outright, even with a prompt tool.) The prompt goes to the thread MCP
server's `approve` tool, which posts an Approve / Deny card in the chat and waits
until someone signed in clicks; the chat records who. Only a person's Approve
allows the call. Cards live in memory with the turn that asked: Stop, a failed
turn or a server restart expires them, and an expired card denies. The turn runs
with `MCP_TOOL_TIMEOUT` raised to a week so a card can wait overnight; a timeout
also denies. With rules set, anything else that would prompt in
`bypassPermissions` gets a card too, instead of being denied.

Rules are guardrails against mistakes, not a sandbox: a Bash rule matches how a
command starts, and a thread with full shell access could reach the same result
another way. Projects with no rules (the default) run exactly as before. The
coordinator is never affected.

**Plugin folders.** A project can also list folders relative to the repo root
(e.g. `tools/mods/delve`); each thread turn gets `--plugin-dir <worktree>/<folder>`
for every one that exists in its worktree.

The coordinator itself runs in `acceptEdits` with only its MCP tools
pre-approved, so it can read the code and manage tickets but can't run shell
commands; it hands the real work to tickets.
