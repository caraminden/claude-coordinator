# Dogfood pass: use it like a person, on a dev copy

Read this when a change adds a page, a view or a flow (not for a one-part fix), or when someone asks
to "QA", "dogfood" or "bug-hunt" an app. It's exploratory: you use the app the way a person would
and write down what goes wrong, with proof. Ideas from vercel-labs/agent-browser's `dogfood` skill
(credited in `THIRD_PARTY.md`); we drive our own headless browser and run none of its tools.

## Set up

- A dev copy or preview, on a copy of the data, at a port you picked and checked free. Never the
  live app: you'll create, edit and delete things.
- A headless browser you started (Citadel's tests use Playwright's `chrome-headless-shell` over
  the DevTools protocol, `test/browser.ts`), at desktop (1280 px) and phone (390 px) widths.
- A findings file in your temp folder, appended to as you go, so an interrupted turn loses nothing.

## Go through it

1. **Map it.** Screenshot the starting view and list the places to visit: each item in the app's
   navigation, each tab, each dialog or drawer.
2. **Do the real jobs end to end:** create something, edit it, find it again, delete it and undo,
   with realistic text (the values in [worst-case-data.md](worst-case-data.md) where it counts).
3. **At each view:** press every control, open every menu and row, submit each form empty and
   wrong, reload (does the URL bring you back? rule 21), go Back, switch to phone width, and read
   the console and failed requests. Spend the time on the core jobs, not the corners.
4. **Write each finding when you find it**, before moving on.

## What counts as proof

- **Retry it once first.** What doesn't happen twice isn't a finding yet; note it as flaky.
- **Something visible on load** (clipped text, a wrong label, a console error at start): one
  screenshot with the spot named.
- **Something that takes steps** (a button that does nothing, a state that sticks): numbered steps,
  a screenshot before, at the action and after, so a reader can follow it without a browser.
- Judge from what the page shows, not from the code: the point is what a person meets.

## Report

Five to ten findings with full proof beat twenty vague ones. Each: a severity (**critical**: blocks
a core job or loses data; **high**: a feature broken with no way round; **medium**: works, with a
noticeable problem or a way round; **low**: cosmetic), a category (looks, works, flow, words, speed,
console, access), the steps and the screenshots, linked. End with the counts by severity and the
two or three that matter most. Fix the ones your change caused; the rest go to your reply as
"noticed", not into this change.
