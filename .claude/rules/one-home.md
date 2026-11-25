---
paths:
  - "server.ts"
  - "src/**"
  - "tools/**"
---

# One way to do it: shared helpers and their homes (#1790)

Before writing a helper of these kinds, use its home. `test/one-home.test.ts` finds a copy in `server.ts`, `src/` or
`tools/` by its shape. A copy that truly has to differ goes in that test's `kept`, with a one-line why.

| For | Use |
|---|---|
| Waiting some milliseconds | `import { setTimeout as sleep } from 'node:timers/promises'`; `sleep(ms, undefined, { ref: false })` where the wait must not hold the process open |
