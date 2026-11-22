# 0029: fast-check is Citadel's first devDependency, for tests only

Status: accepted, 2026-11-22. Minion #1657, from #1654's formal-verification report (shared folder, `reports/formal-verification-2026-11.md`).

- **Cara, 2026-11-22**, on #1654's card: she picked "Lane and claim tests" and, for the library, "fast-check, tests only".
- **Why:** interleaving bugs in `src/lanes.ts` (#259, #1464's two fixes) and `src/claims.ts` (#1334) were found in
  production, not by example tests. fast-check's `fc.scheduler()` reorders promise resolutions at random and shrinks a
  failure to a short counterexample; a 30-line spike found #1464 on the pre-fix `lanes.ts` within 1 to 18 tries on 20 of
  20 seeds. Writing our own scheduler was ruled out.
- **The rule:** `fast-check` stays in `devDependencies`; nothing in `src/`, `server.ts` or `public/` imports it, and the
  live checkout needs no `node_modules`. Citadel keeps "no dependencies" for what runs. TLA+, Quint and separate specs
  are out of scope: tests on the real code only.
- **What it costs:** a lockfile (`package-lock.json`), `npm ci` in a worktree (`src/worktree-deps.ts` does it for a new
  minion) and in `tests.yml`. A suite run on a tree without `node_modules` fails the two property tests on their import.
- **The tests:** `test/lanes-property.test.ts`, `test/claims-property.test.ts`. A fixed seed (20261122) in every run,
  `FC_SEED=<n>` to try another; fast-check prints the seed and the shrunk counterexample on failure.
