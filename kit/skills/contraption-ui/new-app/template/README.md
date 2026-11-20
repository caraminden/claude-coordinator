# {{title}}

{{idea}}

A Citadel app, served at /apps/{{name}}/; Citadel runs it from `citadel-app.json`.

Tests: `npm test`. Layout: `server.ts` (routes), `src/` (identity, database, backup), `migrations/`,
`public/` (the page), `tools/backup.ts` (the nightly timer's command), `citadel-app.json` (how Citadel runs it).
