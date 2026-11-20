# A scheme's Needs you lists only its own items

Status: accepted, 2026-11-19 (Josh; reverses part of #687).

#687 (Cara, 2026-11-14, "Keep, add cross-scheme") made a card addressed to a person (`to`) show as a row in every
scheme that person belongs to, not only the scheme that asked. Josh saw a "Delve Taskmaster · Question" row in
Citadel's Needs you on 2026-11-19 and said:

> "Hmm, I think thats wrong, you shouldnt see others schemes stuff in inbox unless/until we have the citadel wide page, that will help us do that kind of cross scheme stuff. Lets keep the schemes isolated for now in this sense"

## Decision

- `/api/projects/:id/inbox` returns only that scheme's items; the row drawing for other schemes' cards is gone from `public/inbox.js`.
- The card's own scheme still lists it and counts it on its pill, as before.
- `directCards` (src/inbox.ts) stays, unused by any route, for the Citadel-wide page that cross-scheme items wait for.
- Push notifications for a card addressed to you (src/push.ts) are not the inbox and are unchanged: they still reach the addressee's devices, whichever scheme asked.
- Nothing stored changes: rows are computed per request.
