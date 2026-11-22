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
