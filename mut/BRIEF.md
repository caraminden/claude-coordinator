# Writing a mutant spec (#1778)
Citadel, Scheme, Taskmaster, Minion and Grunt are playful names for how the work is organised, not a comment on ability. Work as a careful, senior engineer: think things through, check your work, and push back when something looks wrong.

Repo: /home/cara/.local/share/claude-coordinator/projects/2/tickets/3668 (read-only for you, except the mut/ file you're given). Never change production code, never run the test suite (tests run on CI later), never commit.

A mutant is one small break of production code: a check dropped (`if (x)` -> `if (false)`), a condition flipped or weakened, a wrong boundary, an await/return skipped, a wrong order of two persisted writes, a dropped filter, a default flipped. Write breaks a person's ordinary use, a restart or two things at once would hit: lost messages, a turn run twice, the wrong login, a ship shipped twice, a ship lost over a restart, the wrong place in line, wrong status code for a real case. Skip log text, copy, types, pure performance and mutants that can't change behaviour (read enough around it to be sure). Spread over the ranges given; at most 2 per small function.

Spec file format: see any file in /home/cara/.local/share/claude-coordinator/projects/2/shared/project/specs/mutation-harness/ for the style, but the shape is:
export default { file: 'src/x.ts', tests: ['test/a.test.ts', ...], mutants: [{ id: 'x01', find: '...exact text...', replace: '...', why: 'one line: what breaks for people', nth?: 2, tests?: [...] }] };
- `find` must match the file exactly and once (else set nth). `why` is a plain behaviour.
- `tests`: the test files most likely to catch this spec's mutants: find them by grepping test/ for the functions, routes and messages (rg -l -w). Include every plausible file but keep the spec's list under 12 files; give a mutant its own `tests` (under 6 files) when a smaller or different set is right. Missing a relevant test makes a false survivor, so err towards including the file that names the behaviour. Leave out *-browser tests and scheme-setup-* tests.
- Check it: `node mut/core.ts mut/<yours>.ts --check` (safe, runs no tests) must say 0 bad.
Return at most 3 lines: the spec path, how many mutants, anything that blocks you.
