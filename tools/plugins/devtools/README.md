# devtools

An optional Claude Code plugin folder, picked from the Plugins picker by minions that open a page (UI minions): Chrome DevTools MCP, pinned, headless and isolated, talking over a pipe, so it opens no port. `launch.sh` runs it through a pinned `mise x` on the same Playwright chrome-headless-shell that `tools/ui-shot.ts` uses (`CHROME` overrides it), so nothing new is installed.

Cost: about 1.1k tokens and a 160 MB node process on every turn it loads, plus the browser while a page is open. That is why it is split from `tools/plugins/lsp`.

Credits are in `THIRD_PARTY.md` at the repo root.
