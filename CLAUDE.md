# CLAUDE.md

Citadel: a shared web UI that runs headless Claude Code sessions as minions.
What it does, its layout and how to run it: `README.md`. Where does X live: the "## Layout" table there (read on
demand; `test/layout-map.test.ts` fails when a module under `src/`, `src/routes/`, `src/db/`, `public/` or `tools/` has no row). Node 24+ runs the TypeScript
directly; the only dependencies are dev-only (fast-check, and typescript for the type check) and there is no build step.

## Working rules

- Never push to main on GitHub yourself: `tools/deploy.sh` does that after each deploy. Work on your
  minion branch; when and how it lands in the local `main` and deploys follows the scheme
  instructions ("Shipping fixes"). No plain force pushes: `--force-with-lease`, and only on your own
  branch. `tools/guard.sh` and `.githooks/pre-push` enforce the push rules.
- PR descriptions follow `.github/pull_request_template.md`.
- A land that refuses or fails is not a jammed lock. Read land.sh's `queue:` lines (they name the holder) and
  `git log main` first: if lands are landing, yours failed for its own reason, so fix that and run it again. Only
  `queue: nothing has moved for 15 min` means the holder is stuck; then message the Taskmaster and don't retry.
- A feature, rule, setting or page about running or managing a scheme is built for every scheme, not Citadel's alone: open `.claude/skills/every-scheme/SKILL.md` first, and a review asks whether it ran in another scheme.
- Never put `effort` on a skill (Grunts: the `citadel:subagents` skill).
- `src/backup.html` and `src/backup.ts` (the /backup chat with the Taskmaster, for when the front end breaks) are
  frozen on purpose: leave them out of restyles and refactors; `test/backup.test.ts` pins the page's hash.

## Plugins

- An empty or short LSP result in a turn's first ~30 s means the server is still indexing: retry, it doesn't mean "no usages".
- UI minions can pick DevTools (`tools/plugins/devtools`) from the Plugins picker to open a page and read its console.

## Compact instructions

When this conversation is compacted, keep each person's asks and decisions in their own words
with their times, every open question and who owes the next step, the branch, PR, head and what
is committed or pushed, the files written, and the checklist. Drop test and build logs, diffs,
file contents and finished subagent reports, keeping one line for what each concluded.

## Project facts

The kit's skills and agents read this repo's paths and commands from here. "None" means that
skill step is skipped or uses its default.

- **Check commands:** `npm test` (`node --test test/` through `tools/citadel-node`, so it escapes ananicy's idle `node` rule: `deploy/priority.md`; failing if it leaves processes running, and each file failing on the processes, units, ports and temp entries it leaves: `test/leak-guard.ts`, `test/leak-file.ts`; it also lints the `.ps1` files with pwsh, `test/ps1-lint.test.ts`, and type-checks, `test/typecheck.test.ts`, the front end too with JSDoc types (`tsconfig.public.json`): red means a file gained a tsc error, an explicit `any`, an `as unknown as` or a `@ts-ignore`; `node tools/typecheck.ts <file>` lists them, fix with real types (`unknown` and a narrowing), and after lowering counts run `node tools/typecheck.ts --update`, or `--update --moved` after moving code between files; `node tools/typecheck.ts` is the few-second pre-ship check, run before every hand-off that touches `.ts` or `public/` `.js`, and `citadel-test --affected` runs the tests you changed and the same-named ones for any `.ts` or `.mjs` change; the rest is CI's). The full suite's home is Cara's desktop, not perigee: `tools/land.sh` waits for
  `.github/workflows/tests.yml` on the commit it lands, and runs the suite on perigee only as a loud fallback (`CI FALLBACK`;
  `LAND_CI=0` forces it when CI itself is broken). A change that adds a table or column also runs `test/host-check.test.ts` (every hash or secret column is listed in `src/db-view.ts`), `test/db-setup.test.ts` (a new database's setup is at most 15 commits: create new tables in one transaction) and `test/schema-compat.test.ts` (take the next free `SCHEMA_HISTORY` number from main's tip), and one that adds a test reading a fake's log runs `test/raw-log-read.test.ts`: a feeder's land skips them, and they refuse the build's full land (Build 1 retro). A red CI run: `tools/ci-failures` (on every turn's PATH, `--help`) prints its failing tests. Before landing, a minion runs only the test files its change touches, with `citadel-test --affected` (only the tests you changed since main, the ones named after a source file you changed, and the repo-wide list; the tests that merely use a changed file are CI's, and one line says how many; `--wide` is the whole pick, `tools/affected-map.txt`'s rules and importers too, format: the shared folder's `specs/affected-tests-map.md`) or `citadel-test test/<name>.test.ts ...` (leak guard, a time limit sized by the file count: 300 s up to 10 files, then 30 s a file, at most 1500 s, and a run stopped there reruns only its unfinished files once (`--timeout` sets a limit with no rerun); only the failures shown, the full output in `$TMPDIR/citadel-test.log`), never the full suite on perigee. No build step. A UI change is
  also checked in a dev copy (`tools/citadel-dev-copy`, never `server.ts` by hand: `.claude/rules/dev-copy.md`) or preview (scheme instructions, "UI checks"), with `node tools/ui-shot.ts`:
  `.claude/rules/ui-checks.md` (loads when a session reads a file in `public/` or `docs/design-system/`).
- **Verifier's copy:** `node tools/review-escapes/verifier-copy.ts <scratch folder>`; it prints how to boot the copy and make states (scripted turns, restart, a second person, the clock).
- **Front end:** `public/`, plain JS with no build step.
- **High risk by file (self-review):** auth (`src/auth.ts`); deploy and restart code
  (`tools/deploy.sh`, `tools/land.sh` and its parts in `tools/land/`, `tools/boot-check.ts`, `deploy/`); the tripwire
  (`src/tripwire.ts`, `src/tripwire-git.ts`, `src/tripwire-base.ts`, `tools/guard.sh`, `.githooks/`); who sees what and whose turns run
  (`src/access.ts`, and `turnPerson` in `src/runner.ts`: whose Claude login a turn runs on); the kit's scheme-setup templates, which other schemes copy
  (`kit/skills/scheme-setup/templates/`). `src/db.ts` (setup, migrations, settings) and its area files `src/db/<area>.ts` hold every query, a new one in its area's file (`test/db-areas.test.ts`): judge an
  edit there by what it does. A change that `node tools/types-only.ts` calls `same` (the file's code unchanged once
  types and comments are stripped) is judged by what it does too: by-file high risk doesn't apply to it, though the
  pipeline lane still orders a pipeline file (#2143).
- **How a change ships:** the scheme instructions, "Shipping fixes" (`tools/land.sh`).
- **UI rules:** the scheme instructions, "UI checks"; tokens, parts and design rules in the living
  design-system home, `docs/design-system/index.html` (a token or part change updates it in the same
  commit). Citadel UI (`public/ui/`, served to apps at `/apps/_citadel/ui/`) follows the
  `citadel:contraption-ui` kit skill.
- **Medium risk at least (self-review):** a change to `test/ui-contract.json`, Citadel UI's contract
  with every app: it means an app-visible change to `public/ui/` or theme.css. Additive only.
- **Agent instructions:** the prompt text in `src/prompts.ts` and the MCP tool descriptions in
  `src/mcp.ts` and its `src/mcp-*.ts` families, besides the kit, `CLAUDE.md` and `.claude/`. A big change to a minion or Taskmaster prompt runs
  `tools/prompt-eval run --base main` (in the background, not through citadel-heavy) once before it ships; 2 or more cases fell makes it high risk
  (Josh, 2026-11-19, "Drop needs a go"; `tools/prompt-evals/README.md`). A change to the pre-ship reviewer (`kit/agents/reviewer.md`,
  self-review's section 2, the lenses) makes `test/reviewer-benchmark.test.ts` red until the benchmark is rerun and recorded;
  planted bugs named falling by 2 or more makes it high risk (`tools/review-escapes/README.md`, "When the reviewer changes"; `bench.ts status` also counts new lessons).
- **Rule homes:** `src/rule-homes.ts` names each registered rule's one home and the pointer used
  everywhere else; `test/rule-homes.test.ts` fails on a copy in the repo, and the Settings text is
  checked when it is saved.
- **Glossary:** `kit/skills/citadel-words/SKILL.md` (`citadel:citadel-words`, every scheme's too): each word
  people read and the name code keeps for it, and the retired words. `test/citadel-words.test.ts` ties
  `public/help-words.js` and `src/wording.ts` to it.
- **Decisions log (ADRs):** `docs/adr/`.
- **Retros:** none yet; the first goes in `docs/retros/`.
- **Bug classes of its own:** none beyond the bug-fixing skill's.
- **Numbered things:** none: `MIGRATIONS` in `src/db.ts` is keyed by table and column, and the
  version in `package.json` never moves. `tools/land.sh` has no collision check; the kit's
  template does.

## Skills, subagents (Grunts) and rules

The shared skills and agents live in the Citadel kit (`kit/`, see its `README.md`), which every
turn of every scheme loads; they show up namespaced, as `citadel:<name>` skills and
`citadel:<name>` subagent types. Some are copies of open-source packs, listed with their sources
in `kit/skills/THIRD_PARTY.md`. A fix to one lands here and reaches every scheme. This repo's one
own skill is `.claude/skills/every-scheme` (Citadel's minions only); it has no agents of its own. `.claude/rules/ponytail.md` loads whenever a session reads a code
file (plugins can't carry rules).

Rules for one area of the repo are path-scoped in `.claude/rules/` and load only when a session reads
a matching file; editing this file or a rule: `.claude/rules/agent-docs.md`. `tools/doc-map.sh <doc>` prints
a long doc's sections with their line ranges, for reading only the part you need.
