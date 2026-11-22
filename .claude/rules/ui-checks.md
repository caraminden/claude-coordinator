---
paths:
  - "public/**"
  - "docs/design-system/**"
  - "tools/ui-shot.ts"
  - "tools/dev-copy.ts"
---

# Checking a UI change

Moved from CLAUDE.md's "Check commands" (it points here). A UI change is also checked in a dev copy
or preview (scheme instructions, "UI checks"): shoot and drive its pages with
`node tools/ui-shot.ts <#route>...` (its header: widths, dark, steps, display-mode), under a second a shot
on the dev copy it starts and keeps, then `citadel-dev-copy stop`. It is also the page driver: a check like
"click this, did that appear" is one command, `--step 'fill .composer textarea | hi' --step 'click .send-group > button'
--step 'wait .msg.user | hi'`, and its `open()` gives a script a signed-in page. A scratch server takes its port from
`freePort()` (`src/ports.ts`), and a page that isn't Citadel's gets `test/browser.ts` (headless Chromium over a pipe,
no port, no dependency).

Every other dev server and browser debugging port follows the ports rule in `citadel:contraption-ui` ("Ports for dev
servers and browsers"); `freePort()` does it for a script.
