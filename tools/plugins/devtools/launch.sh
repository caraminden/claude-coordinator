#!/bin/sh
# Starts Chrome DevTools MCP on the same Playwright chrome-headless-shell that tools/ui-shot.ts uses
# (kit/skills/critique/scripts/ui-measure.mjs findChrome), found at startup because the folder name
# (chromium_headless_shell-1248) changes with every Playwright upgrade. $CHROME overrides it.
# --headless without --browserUrl talks to the browser over a pipe, so it opens no port to pick.
set -eu
browser=${CHROME:-$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-[0-9]*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -n 1)}
if [ -z "$browser" ]; then
  echo "devtools plugin: no Playwright chrome-headless-shell in ~/.cache/ms-playwright (run: npx playwright install chromium-headless-shell)" >&2
  exit 1
fi
exec mise x npm:chrome-devtools-mcp@1.12.0 -- chrome-devtools-mcp \
  --headless --isolated "--executablePath=$browser" --no-usage-statistics --no-performance-crux
