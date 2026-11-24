# Step 8 in full: week-one basics

Nearly every scheme spent its first week on follow-up minions for these (onboarding review, 2026-11-19, section 3). The gaps are from Citadel's onboarding review (`reports/scheme-onboarding-review-2026-11.md` in Citadel's shared folder, section 3). Each sub-step ends in a line for the done note: done, or "not this kind of scheme".

**8a. Icon** (closes the review's "icon done again after setup": about 14 minions across 10 schemes). One icon, drawn with code (no image generator), serves as the scheme's icon and the app's.
1. Draw `assets/icon/icon.svg` (a simple mark in the scheme's accent colour; under 256 KB, no scripts). Citadel takes a scheme's favicon from the first of `assets/icon/icon.svg`, `assets/icon/favicon.svg`, `web/public/icon.svg`, `public/icon.svg`, `public/favicon.svg` or `favicon.svg` in the repo's main (so use the first); commit it to the scheme's main, so shipping step 9 sets the scheme icon.
2. A contraption also uses the same drawing as its `icon.svg`, renders the 192 and 512 PNGs and a maskable PNG from it (`citadel:contraption-ui`, `references/installing.md`), and its `manifest.webmanifest` lists them.
*Done when* the SVG is committed at that path, and, for a contraption, the manifest's icons are the same drawing. Step 9's ship puts it on main, which is when the scheme's icon shows; check that after step 9.

**8b. Contraption: registered and live** (closes TripPresenter #6, about 15 h with nothing live, and Mandate #23). Skip 8a's contraption half and 8b to 8d when the scheme's app is not a contraption (an app Citadel serves under `/apps/<name>/`). The onboarding plan's contraption answer says whether it is one.
1. Call `deploy_contraption` for the app. A refusal that names the app as unknown means it is not registered.
2. Not registered: an app that doesn't exist yet is made by your own Taskmaster's `make_app` (a folder of this scheme's repo, registered and on for its members: `citadel:contraption-ui`, `references/api.md`); ask it for that rather than building one by hand. An app that already exists in its own repo: ship its `citadel-app.json` to main first, then ask your own Taskmaster (`message_coordinator`) to call `adopt_app` (`name`, `title`, `folder` of the manifest: `""` for the repo root) on a member's turn. It registers the app with a free port, its icon and this scheme as home, switches it on for the members, deploys it and answers with the deploy's outcome; it needs no one from Citadel's scheme. An app in a repo that isn't this scheme's own is still admin-only (the Citadel Taskmaster's `register_contraption`).
3. Your Taskmaster's `adopt_app` deploys at once: wait for its answer, then carry on from the deploy's outcome. Don't close with the deploy open.
4. Run `deploy_contraption` until one run went live, clear its **To do** lines, and take a screenshot of the live app for the done note.
5. In CLAUDE.md, write the deploy line ("deploys with `deploy_contraption`") as fact only once a run went live.
*Done when* one `deploy_contraption` run went live and its screenshot is in the done note. Only a Taskmaster that can't register it (it says so) lets the note list "registered and first deploy" as open, with the message you sent.

**8c. Top bar** (closes VA #57 and #66, ToC #139, Mandate #117). The contraption's page header is the kit's `<header class="cui-topbar">`, first in the page (`citadel:contraption-ui`, rule 24). *Done when* the live screenshot shows it.

**8d. Nightly backup** (closes VA #51), for a contraption that keeps data (a database or files). The convention: the app writes `$DATA_DIR/backups/<day>/` before 04:00 PST, from a timer in `citadel-app.json` (`timers`, see `references/api.md` of `citadel:contraption-ui`). `on_calendar` is systemd time on the server's own clock, Pacific, the same clock as Citadel's 04:00 ship; use `*-*-* 03:30:00`. Citadel ships them off the box. Its own snapshots of `DATA_DIR`, taken before a deploy that changes the app's `migrations` (#1137), are only for roll backs and stay on the box, so they don't replace this backup. *Done when* the timer is in `citadel-app.json` and one run wrote a `backups/<day>/` folder, or the app keeps no data.

**8e. Pin every agent you wrote**

(Closes TWI #52, TP #26, VA #65, Trans #75, Delve #125.) Every agent file you adapted in step 5 (`.claude/agents/*.md`) has `model:` and `effort:` lines, never `inherit`, picked by its job from the table in `citadel:subagents` ("Model and effort per job"). *Done when* `grep -L '^model:' .claude/agents/*.md` and the same for `effort:` list nothing, and `grep -l '^\(model\|effort\): *inherit' .claude/agents/*.md` lists nothing.

