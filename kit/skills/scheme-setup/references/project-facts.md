# Project facts: the keys, and the real-hardware ledger

**Project facts** opens with: *The kit's skills and agents read this repo's paths and commands
from here. "None" means that skill step is skipped or uses its default.* Then one bullet per
key, `- **Key:** value`, every key present, "none" written out where it is none. The one
exception is Real-hardware ledger: only a native-app scheme has that line.

| Key | What to write | Read by | When none |
|---|---|---|---|
| Check commands | Each command, exact, and what it checks: tests, build, lint, type check. A fresh minion worktree has no dependencies (no `node_modules`), so a check command that needs them installs them when they are missing (`npm ci` when the lockfile is there and `node_modules` isn't), or the first run in a new worktree is red. Then how a UI change is checked (a dev copy, preview, screenshot). A dev server: the command that starts it, printing its pid, and the stop by that pid (a kill by name or pattern is refused) | check-runner, bug-fixing, self-review | check-runner falls back to `package.json` or `Makefile`; UI: "none named yet" |
| Front end | Its folder, the framework, whether it builds | self-review (front-end-only changes rate low) | nothing rates low as front end |
| High risk by file | Files whose every edit is high risk: auth, save formats, migrations, deploy and restart code. Always `tools/guard.sh`, `.githooks/`, `.claude/settings.json`, and `tools/land.sh` and `tools/land.local.sh` when written | self-review | the guard files alone |
| How a change ships | The shipping answer in one line, and the pusher of main | self-review, guard.sh, pre-push | never none: ask (above) |
| UI rules | Where the UI rules live. Your own prompt carries the scheme instructions: name their UI section if they have one | retro | retro checks no UI rules |
| Glossary | Path of the glossary file | domain-modeling, diagnosing-bugs, improve-codebase-architecture | domain-modeling creates `GLOSSARY.md` when first needed |
| Decisions log (ADRs) | Path and format. A single file that every minion appends to (not one file per decision) gets `<path> merge=union` in `.gitattributes`, so two appends rebase without a conflict; only for an append-only log, never JSON or code (union would corrupt it) | bug-fixing, domain-modeling, fresh-eyes, retro, improve-codebase-architecture | first ADR goes in `docs/adr/` |
| Retros | Retro folder | retro | `docs/retros/` |
| Bug classes of its own | The stack's recurring bug kinds beyond bug-fixing's (a Godot signal wired twice, a stale save version) | bug-fixing | bug-fixing's classes only |
| Agent instructions | Prompts, guides and tool descriptions an agent reads beyond the kit, `CLAUDE.md`, `AGENTS.md` and `.claude/` (an app's system prompt, a guides folder) | self-review (Agent instructions lens) | those alone |
| Numbered things | What minions number in parallel and could both take the same "next" of: migration files, a version, ledger ids. Entries split by `;`: `files <glob with NNNN>`, `ids <glob> "<regex>"`, `version <glob> "<regex>"` (the format is in `land.sh`'s header). Only with `tools/land.sh`, which refuses a change that clashes | land.sh | no check |
| Docs test | A test that checks the paths docs name, if one exists | retro | skipped |
| Real-hardware ledger | Native-app schemes only: `docs/unproven.md`, written as below | self-review | no line |

**The ledger** (native-app schemes only) lists what nobody has yet seen work on real hardware.
Write `docs/unproven.md` with a title, then this paragraph with the platform filled in, and no
entries yet:

> What this app does that nobody has yet seen work on a real <platform> machine; CI's VMs
> can't show it. A PR that leaves something unchecked on real hardware adds an entry here,
> under an area heading (Capture, Colour, Install), numbered after the highest number so far.
> Each entry says what is unproven and what a failure would look like, and ends with its PR
> or commit. A run on real hardware deletes what held and swaps what broke for its bug
> minion's number. Numbers are never reused.
