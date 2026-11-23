---
paths:
  - "server.ts"
  - "tools/dev-*"
  - "tools/citadel-dev-copy"
  - "tools/ui-shot.ts"
  - "public/**"
---

# A dev copy of Citadel

Moved from every Citadel minion's prompt (#1574). For a dev copy of Citadel, use
`citadel-dev-copy start|seed|env|stop` (`--help`; new seed states go in tools/dev-seeds.ts) rather than
server.ts by hand, which opens the live database, and drive a page with
`node tools/ui-shot.ts <#route> --step '<verb> <selector>'` (its header lists the steps).

Limits that cost minions time: a dev copy refuses service reads (409) and has no sample data or deploy target, so rows that need them can't be shot (stub a fetch with `ui-shot --step 'eval <js>'`, then re-navigate the hash); it has no shared folder (copy the retro log in); and it caches `public/` until restarted, so restart it between edits.
