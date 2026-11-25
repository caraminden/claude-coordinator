# 0032: Citadel type-checks every ship, as a ratchet, and counts `any`

Status: accepted, 2026-11-24. Minion #1789.

- **Cara, 2026-11-24**, on the Taskmaster's card about unifying coding style: she picked "Typecheck Citadel" ("Add the
  check to the ship gate, starting from the errors there today so the count can only go down"). Starting it the same
  day: "let's make sure citadel and the rest of our typescript schemes don't cheat and use 'any'".
- **Why:** Node strips Citadel's types and never checks them, so nothing caught a wrong field, a missing argument or a
  dead comparison until it ran. The first run found 1,416 errors over about 1,000 files.
- **The rule:** `tsconfig.json` (strict, no emit, `erasableSyntaxOnly`, `verbatimModuleSyntax`) covers `server.ts`,
  `src/`, `tools/`, `test/` and `kit/` (not the kit's templates, which only run once copied). `test/typecheck.test.ts`
  rides the suite, so every ship runs it. It fails when a file's tsc errors, or its escapes (an explicit `any` in a
  type, a `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`), go above `test/typecheck-baseline.json`. Lower counts
  pass; `node tools/typecheck.ts --update` writes them down and can never raise one. Moving or splitting code re-files its counts with `--update --moved`, refused when a repo total went up.
- **Escapes** are counted with Node's own `module.stripTypeScriptTypes`: an `any` it blanks was a type. No parser of
  our own.
- **What it costs:** `typescript` (7.x, the native compiler) and `@types/node` join `fast-check` as devDependencies;
  nothing that runs imports them, as in ADR 0029. About 2 s a suite run. A worktree made before this needs `npm ci`
  once, or the test says so.
- **The front end (#2010; Josh, 2026-11-25, picked "Check Citadel's front end": "turns the check on so errors can only
  go down"):** `tsconfig.public.json` checks `public/**/*.js` with `checkJs`, the DOM types and no Node types, every
  script its own module; `tsconfig.sw.json` checks the service worker with a worker's globals. Same strict rules as the
  server, so an untyped parameter is an error: 8,384 to start with. `SCRIPTS` in the config block counts a script's
  escapes: an `any` (or `*`) in a JSDoc type and every `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`, in any
  comment or case. A `.js` with a `.d.ts` beside it is checked all the same (its importers read the `.d.ts`). About
  1 s more a run.
- **Not covered:** that a `.d.ts` matches the `.js` beside it; the two agents (`public/*-agent.mjs`, Node programs);
  scripts inline in HTML; and, as in TypeScript, `Function`, `JSON.parse` and the like, which give `any` without the
  word. A call with too few arguments to a function whose parameters have no JSDoc passes (each untyped parameter is an
  error of its own already).