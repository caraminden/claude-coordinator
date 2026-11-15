# lsp

A Claude Code plugin folder that every Citadel minion loads: TS 7's own language server (`tsc --lsp --stdio`), run through a pinned `mise x` so nothing is installed on the host. Not the marketplace's typescript-language-server, which under-reports on TS 7 repos.

- `"diagnostics": false` because Citadel has no `node_modules`, so every file would report "Cannot find module node:crypto".
- Right after the server starts it is still indexing, and find-references can come back empty or short. Retry after ~30 s.
- Cost: nothing until used, then about 75 MB.

Chrome DevTools is its own optional folder, `tools/plugins/devtools`. Credits are in `THIRD_PARTY.md` at the repo root.
