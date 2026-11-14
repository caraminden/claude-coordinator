# CLAUDE.md

Citadel: a shared web UI that runs headless Claude Code sessions as minions.
What it does, its layout and how to run it: `README.md`. Node 24+ runs the TypeScript
directly; there are no dependencies and no build step.

## Working rules

- Never push to main on GitHub yourself: `tools/deploy.sh` does that after each deploy. Work on your
  minion branch; when and how it lands in the local `main` and deploys follows the scheme
  instructions ("Shipping fixes"). No plain force pushes: `--force-with-lease`, and only on your own
  branch. `tools/guard.sh` and `.githooks/pre-push` enforce the push rules.
- PR descriptions follow `.github/pull_request_template.md`.
- A land that refuses or fails is not a jammed lock. Read land.sh's `queue:` lines (they name the holder) and
  `git log main` first: if lands are landing, yours failed for its own reason, so fix that and run it again. Only
  `queue: nothing has moved for 15 min` means the holder is stuck; then message the Taskmaster and don't retry.
- While your own background job runs (a test run, a build, a server you're checking), wait for
  it inside the turn with one blocking command rather than ending the turn: a minion's turn is one
  `claude -p` process, the board shows it idle once that exits, and the job may not outlive it.
- Never put `effort` on a skill (Grunts: the `citadel:subagents` skill).
- `src/backup.html` and `src/backup.ts` (the /backup chat with the Taskmaster, for when the front end breaks) are
  frozen on purpose: leave them out of restyles and refactors; `test/backup.test.ts` pins the page's hash.

## Compact instructions

When this conversation is compacted, keep each person's asks and decisions in their own words
with their times, every open question and who owes the next step, the branch, PR, head and what
is committed or pushed, the files written, and the checklist. Drop test and build logs, diffs,
file contents and finished subagent reports, keeping one line for what each concluded.

## Project facts

The kit's skills and agents read this repo's paths and commands from here. "None" means that
skill step is skipped or uses its default.

- **Check commands:** `npm test` (`node --test test/` through `tools/citadel-node`, so it escapes ananicy's idle `node` rule: `deploy/priority.md`; failing if it leaves processes running: `test/leak-guard.ts`; it also lints the `.ps1` files with pwsh, `test/ps1-lint.test.ts`). The full suite's home is Cara's desktop, not perigee: `tools/land.sh` waits for
  `.github/workflows/tests.yml` on the commit it lands, and runs the suite on perigee only as a loud fallback (`CI FALLBACK`;
  `LAND_CI=0` forces it when CI itself is broken). A red CI run: `tools/ci-failures` (on every turn's PATH, `--help`) prints its failing tests. Before landing, a minion runs only the test files its change touches, with `citadel-test test/<name>.test.ts ...` (leak guard, a 300 s limit, only the failures shown, the full output in `$TMPDIR/citadel-test.log`), never the full suite on perigee. No build step. A UI change is
  also checked in a dev copy or preview (scheme instructions, "UI checks"), with `node tools/ui-shot.ts`:
  `.claude/rules/ui-checks.md` (loads when a session reads a file in `public/` or `docs/design-system/`).
- **Front end:** `public/`, plain JS with no build step.
- **High risk by file (self-review):** auth (`src/auth.ts`); deploy and restart code
  (`tools/deploy.sh`, `tools/land.sh`, `tools/boot-check.ts`, `deploy/`); the tripwire
  (`src/tripwire.ts`, `tools/guard.sh`, `.githooks/`); who sees what and whose turns run
  (`src/access.ts`); the kit's scheme-setup templates, which other schemes copy
  (`kit/skills/scheme-setup/templates/`). `src/db.ts` holds every query: judge an
  edit there by what it does.
- **How a change ships:** the scheme instructions, "Shipping fixes" (`tools/land.sh`).
- **UI rules:** the scheme instructions, "UI checks"; tokens, parts and design rules in the living
  design-system home, `docs/design-system/index.html` (a token or part change updates it in the same
  commit). Citadel UI (`public/ui/`, served to apps at `/apps/_citadel/ui/`) follows the
  `citadel:contraption-ui` kit skill.
- **Medium risk at least (self-review):** a change to `test/ui-contract.json`, Citadel UI's contract
  with every app: it means an app-visible change to `public/ui/` or theme.css. Additive only.
- **Agent instructions:** the prompt text in `src/prompts.ts` and the MCP tool descriptions in
  `src/mcp.ts`, besides the kit, `CLAUDE.md` and `.claude/`.
- **Glossary:** none. The names people read (Scheme, Taskmaster, Minion, Grunt) are in the scheme
  instructions; code keeps the old identifiers.
- **Decisions log (ADRs):** `docs/adr/`.
- **Retros:** none yet; the first goes in `docs/retros/`.
- **Bug classes of its own:** none beyond the bug-fixing skill's.
- **Rubrics:** docs/rubrics/
- **Numbered things:** none: `MIGRATIONS` in `src/db.ts` is keyed by table and column, and the
  version in `package.json` never moves. `tools/land.sh` has no collision check; the kit's
  template does.

## Skills, subagents (Grunts) and rules

The shared skills and agents live in the Citadel kit (`kit/`, see its `README.md`), which every
turn of every scheme loads; they show up namespaced, as `citadel:<name>` skills and
`citadel:<name>` subagent types. Some are copies of open-source packs, listed with their sources
in `kit/skills/THIRD_PARTY.md`. A fix to one lands here and reaches every scheme. This repo has
no skills or agents of its own. `.claude/rules/ponytail.md` loads whenever a session reads a code
file (plugins can't carry rules).

Rules for one area of the repo are path-scoped in `.claude/rules/` and load only when a session reads
a matching file; editing this file or a rule: `.claude/rules/agent-docs.md`. `tools/doc-map.sh <doc>` prints
a long doc's sections with their line ranges, for reading only the part you need.
