# 0023: Releases, CI and Status are one page, opened on the scheme you're in

Date: 2026-11-21. Minion #1423. Reverses #1049's "All only from Citadel" (ebc741ed), and folds the CI page (#968) and
the Status page (#1123) into Releases.

Cara, 2026-11-21: "Lets combine Releases and CI into one button that has the colored dot and is called "Releases" it
should have the all schemes with their CI status on the left like this, then the tabs of CI on the right, but the main
page would be the page we currently call releases. Also, I thought I asked for this, but maybe it just hasnt been
released yet, when you open that page from Citadel it shouldnt show the "all" screen it should just show Citadel. On the
same note, when you open it from a scheme you should see the full list like in the screen shot, not the one that has the
button to open "All Schemes""

Cara, 2026-11-21, later the same day: "In fact, maybe status should just be a tab in there too, we can still have the
two links and the two colored indicators, just have them open to different tabs? For that matter we could add a status
indicator to Releases and make it looks like the other 2 buttons? so we would have 3 buttons, for different tabs on the
same page, and the releases status indicator would show if there is an issue with test failures or other things
stopping deployments, CI indicates issues with runners being down or overworked, and Status is about app performance"

## Decision

- One page, `#/p/<id>/releases/<scope>[/<tab>]` (scope a scheme id or `all`). The CI page's list of schemes is on the
  left on every tab; the right side is tabs: Releases (the default, the old Releases page), Overview, History, Test
  health, Numbers, Status. Clicking a scheme keeps the tab.
- Three top bar chips styled alike, each with its dot, each opening its own tab for the scheme you're in: Releases,
  CI (Overview) and Status. Only Home opens All (#1282). The chip's × goes back to where you were.
- All is one row at the top of the list: Releases' board of every scheme and every app's Status. It has no CI tabs
  (there is no one CI for All); `#/…/ci/all` opens that scheme's Overview.
- Each row's dot follows the open tab: the Releases signal on Releases, the CI signal on the CI tabs, the Status
  verdict on Status (a scheme's apps; the server's verdict only on the row of the scheme that ships it).
- Phones use the CI page's pattern: the list above the tabs, all-clear rows behind "N more". #820's scheme picker goes.
- Old links keep working: `#/…/ci[/<tab>]`, `#/…/status[/all]`, `#/…/releases/<scope>/<change>` (the highlight), and
  CI alert links (`/c/#/p/<id>/ci`).

## Which dot a problem lights

| Problem | Dot |
| --- | --- |
| A workflow red on the default branch (`red:`) | Releases |
| The ship line still (`land:slow`) | Releases |
| A change or a deploy stuck in its stage over 30 min | Releases |
| Failed ship tries in the last 12 h not shipped yet | Releases |
| A run stuck in the queue (`stuck:`), hung (`hung:`), or never started (`nostart:`) | CI |
| The ship gate fell back to the suite on perigee (`land:fallback`) | CI |
| A CI desktop offline or overloaded | CI |
| A problem key nobody sorted yet | CI |
| The Citadel server's or an app's verdict (stalls, restarts, memory, errors) | Status |

## Not chosen

- Keeping #820's phone picker: the list above the tabs is the same on every width and shows every dot at once.
- Opening Citadel's page on All (#1049): Cara asked for Citadel to open on Citadel, like every other scheme.
- Folding Citadel's own server verdict into every scheme's Status dot: every row turned red on one server problem.
