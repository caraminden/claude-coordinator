# Claude Coordinator

A shared web UI for running headless Claude Code sessions as **tickets**. Several
people sign in, open a project, and talk to its **coordinator**: a long-lived
Claude session that creates, messages, renames and closes the project's other
tickets. A sidebar lists the tickets (running, waiting for input, errored,
closed), and any ticket can also be opened and chatted with directly. Each
ticket is one Claude Code session working in its own git worktree.

This is the proof-of-concept stage: tickets, chat, live output and a board.
Planned next: approve/deny buttons for permission requests, artifacts, and
runners on other people's own Claude logins.

## How it works

- Each chat message spawns one `claude -p --output-format stream-json` process
  in the ticket's working directory, with `--resume <session_id>` after the
  first turn. Idle tickets cost nothing, and a restart loses nothing.
- Every stream event is stored in SQLite and pushed to browsers over
  server-sent events.
- Messages sent while a turn is running are queued and sent together as the
  next turn. Messages reach Claude as `[Name]: text`.
- Opening a project creates its coordinator ticket on first visit. Its turns
  run with an extra MCP server (`src/mcp.ts`) whose tools call this app's API
  with a bearer token that only reaches that project's tickets (never the
  coordinator itself). The token is passed in the environment, not on the
  command line, so other users on the box can't read it from `ps`.
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
| `src/workspace.ts` | Clones project repos, creates per-ticket worktrees |
| `src/db.ts` | SQLite schema and queries |
| `src/auth.ts` | Shared-password login, signed session cookies |
| `public/` | Front end (vanilla JS, no build) |
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

Headless turns can't show a permission prompt, so each ticket picks a mode when
it is created:

- **bypassPermissions** (default, for tickets started by hand or by the
  coordinator): full access as the service user.
- **acceptEdits**: edits files freely; tools that need approval, such as most
  shell commands, are refused.
- **plan**: read and plan only.

The coordinator itself runs in `acceptEdits` with only its MCP tools
pre-approved, so it can read the code and manage tickets but can't run shell
commands; it hands the real work to tickets.
