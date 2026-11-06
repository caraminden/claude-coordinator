# The worst-case data pass

Pages get built against kind data: short names, two-digit counts, every field filled. This pass
feeds a view the worst data a real person could produce, screenshots it, and lists what broke.
`citadel:self-review` asks for it on a UI change that draws data (step 3); run it on the views the
change touches. Ideas from Emil Kowalski's `break-ui` (credited in `THIRD_PARTY.md`).

## Rules

- **Plausible, never random.** Every value is one a real person could type, or the longest the
  server accepts. Forty `a`s prove nothing and get waved away. No limit anywhere is a finding of its own.
- **Change the data, not the page.** The values go in where real data does: the dev copy's
  database or API, or a fixture the page already loads. Never on the live database, and never by
  editing the markup or CSS, which tests your edit.
- **Mix the failures across the first rows** (row 1 the long name, row 2 the emoji, row 3 the
  one-letter one), since those are what's on screen.
- **Report before fixing.** Some breaks are a call (wrap or cut?): list them, fix the clear ones.

## What to feed (pick what the view draws)

| Kind | Values |
|---|---|
| Names and titles | `Aleksandra Wiśniewska-Kowalczyk`; `Jo`; `Đặng Thị Ngọc Hân` (stacked accents, clipped by a tight line height); `王秀英` (no spaces); `نور الهدى` (right to left); `🦊 Fox` and `👩🏽‍💻 Priya` (emoji first: `charAt(0)` splits them); a title of the longest length the field allows |
| Unbroken strings | an address like `first.last+notifications@northwind-holdings.example.com`; a long URL with a query; a branch like `ticket/1234-make-the-sidebar-remember-collapsed-sections`; a path; a UUID; `Benachrichtigungseinstellungen` |
| Text with markup | `<b>hi</b>`, `&amp;`, `**bold**`: each shows as typed unless the field is markdown; a line break in a one-line field |
| Counts and numbers | 0, 1 ("1 minions"?), 1284 (separator?), 1000000, a negative, `null`, a value that changes live (width jump without `tabular-nums`) |
| Lists | none, one, exactly a page, a page plus one, and the realistic upper bound (a few hundred rows: does it stay smooth?), two items with the same name |
| Time | just now, 11 months ago, a date in the future, a run of 1,284 hours |
| State | loading, an error from the server, some optional fields missing, every status value at once, no permission |

## Where to look

Screenshot each at desktop (1280 px) and phone (390 px), plus 320 px for anything in a column, dark
mode, and 200% zoom (text grows, fixed boxes don't). What usually breaks, and the usual fix:

| You see | Fix |
|---|---|
| Text runs past its box or pushes a button off the row | `min-width: 0` on the text column (`minmax(0, 1fr)` in a grid), `flex-shrink: 0` on the button |
| An address or URL runs off the edge | `overflow-wrap: anywhere` on it |
| A chip wraps or an icon squashes | `flex-shrink: 0` and `white-space: nowrap` on it; decide what gives way instead |
| A cut name with no way to read it | `data-tip-overflow` with the whole name (rule 18) |
| Accents cut at the top | no fixed `height` or `overflow: hidden` on text (rule 18) |
| "1 minions", `NaN`, `1284` | `Intl.PluralRules` or two strings; guard nulls; `toLocaleString()` |
| A blank where a field was missing | leave the line out, or keep its height on purpose |

Cut where the start says it all (a description, a preview), cut in the middle where items differ at
the end (paths, branches, file names), wrap names a person needs whole, and never cut a number.

## Report

One row per break, worst first: **Broken** (unreadable, unreachable, wrong), **Ugly** (readable
but visibly wrong) or **Fragile** (fine now, one realistic step from breaking). Each row: the value,
the screenshot, what happened, the fix with `file:line`. Then a line of what held up, so the next
person knows what not to touch.
