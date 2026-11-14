---
paths:
  - "src/backup.html"
  - "src/backup.ts"
  - "test/backup.test.ts"
---

# The backup page is frozen

`src/backup.html` and `src/backup.ts` (the /backup chat with the Taskmaster, for when the front end breaks) are
frozen on purpose: leave them out of restyles and refactors; `test/backup.test.ts` pins the page's hash.
