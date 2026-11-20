# {{title}}

A Citadel app (a contraption) at /apps/{{name}}/, in the folder `apps/{{name}}/` of this scheme's repo.
The idea it was made for: {{idea}}

Node 24+ runs the TypeScript directly: no packages, no build step. Citadel's API, the identity header,
deploys and the UI kit: the `citadel:contraption-ui` skill (its `references/api.md`).

## Working rules

- Every request outside the open paths in `server.ts` (`OPEN`) needs a signed-in person: `src/identity.ts`
  checks the header. Don't add an open path for data.
- Key people's data on `sub`, never on login.
- The database is `$DATA_DIR/app.db`. A schema change is a new `migrations/NNNN-what.sql`; a shipped migration
  is never edited. They run at start (`src/db.ts`).
- Anything new kept in DATA_DIR goes into the nightly backup (`src/backup.ts`), or it isn't backed up.
- PORT, BASE_PATH, DATA_DIR, CITADEL_KEYS and CITADEL_URL come from Citadel: never hard-code them.
- Pages are on Citadel UI (`/apps/_citadel/`); follow the `citadel:contraption-ui` skill for any front-end work.

## Project facts

- **Check commands:** `npm test` in `apps/{{name}}/` (`node --test test/`, with the kit's fake Citadel in
  `test/fake-citadel.ts`). A UI change is also checked by screenshot at 1440 and 390 px.
- **Front end:** `public/`, plain JS, no build step.
- **How a change ships:** the scheme's own way; a ship to main redeploys the app when it touched `apps/{{name}}/`.
- **Health:** `/apps/{{name}}/healthz` (204 once the database opens); Citadel's deploy waits for it.
