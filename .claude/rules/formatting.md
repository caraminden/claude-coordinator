---
paths:
  - "**/*.ts"
  - "**/*.js"
  - "**/*.mjs"
---

# Formatting

The standard is Biome with `biome.json`. Run `tools/fmt <files>` (or `tools/fmt --own`: every file your branch changed, and untracked ones) before
each commit, and format only files you changed. `test/format-own.test.ts` refuses a ship with an unformatted file of its own
before it joins the line, and shows the same on every `citadel-test` run. `tools/land.sh` formats a ship's own files in a
commit of its own first (`tools/ship-format.sh`), so that refusal is the case it couldn't; still format as you go, so
your review and tests see what ships.
