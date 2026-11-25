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
| Reading JSON, a value a line, from a process's output | `jsonLines(stream, on)`, `src/json-lines.ts`: no readline, which also splits inside a string at U+2028 |
| Refusing a request | `throw new HttpError(400, '…')`, `src/http.ts`, with no alias that only fills in the status |
| Answering with JSON, or a whole file | `json` and `sendFile`, `src/http.ts` (`routes/files.ts` for ranges) |
