# 15. Premium navigation experience: audit and plan (2026-10-29)

Starting point: `main` at 739bb81 (newer than the 49757ad named in the request; the only change since is the sheet swipe fix, #21). Evidence: the iOS screenshots CI took on 49757ad (run 40843840560, iPhone 16e simulator, iOS 26.2, 47 screens, light and dark) and web screenshots taken with Playwright on the same commit (390×844, 375×667 and 844×390, light and dark). The five screen mockup named in the request is not in the repository or this session; it was requested from the owner and this plan follows the written description until it arrives. Nothing here claims to match the mockup.

## 15.1 What the app is today (audit)

| Area | iOS (SwiftUI) | Web | Works | Visual and functional problems seen in the screenshots |
|---|---|---|---|---|
| Drive | `DriveView.swift`: instrument card (speedometer, posted limit, shield, state), state progress card, one focus card, Then strip, destination card, in a ScrollView | `views.js` `dashboard()`: same cards | Speed limits (OpenStreetMap through Valhalla), state progress, focus rule with 9 kinds (`DashboardFocus`), simulation labels | Five stacked cards: on a 6.1" phone the next exit starts at the bottom edge behind the tab bar; on the web it is cut in half. The state card repeats facts (miles left twice, "You will drive 112 mi in Georgia", two progress captions). Scrolled content slides under the floating top bar and the "SIMULATED GPS" label overlaps numbers. No map on Drive at all. Landscape exists on iOS (two columns) but was never captured. |
| Focus priority | `DashboardFocus.choose` (both engines, shared fixtures) | `engine/dashboard.js` | Priorities: fuel below reserve, serious alert within 50 mi, planned stop, gas gap, alert within 10 mi, fuel stop, last open overnight, overnight, rest area, next exit | Recomputed on every GPS fix with no memory, so a ranking change at a threshold can flip the card back and forth. Fuel below reserve outranks a serious hazard 1 mile ahead. |
| Road Ahead | `ExitsView.swift`: List with a 5 to 100 mi segmented control, 8 category chips, alert status row, rows in route order | `exitsView()`: same | Route order, state lines, rest areas, gas gaps, SmartStop tag, alerts, planned stops | Reads as a settings style list. A category filter removes alerts from the list with no sign they exist. State lines are a tinted row, not a landmark. The SmartStop pick is a small tag. |
| Alerts | `AlertCard` (Drive), `AlertRow`, `AlertStatusView` | `alertCard()`, `alertRow()` | Matching, direction, dedupe, expiry, per source status, "No source connected" for police | Every alert uses the same card; only "serious" gets a red outline. No amber or informational tier. No detail view. |
| SmartStop | `FuelView`, `SmartStopSections`, focus cards | `fuelSheet()` | Shell first, overnight 12 to 4 AM rules, hours and restroom confidence labels, alternatives | The fuel sheet opens with paragraphs of rules; the pick, its hours and its restroom status are mixed with technical text. No one tap restroom stop (task 40 still open). |
| Maps | Trip tab: MapKit route map | Trip tab: offline SVG of state shapes, no tiles | Route and position | The web has no road map anywhere. |
| Design tokens | `Tokens.swift` generated from `design/tokens.json` | `tokens.css`, same source | One source, contrast tests in `design.test.js` | Dark surfaces are neutral grey (#161A20 on #0A0C0F); no navy, no route blue token, no fills for danger or info, no elevation. |
| Google mode | PR #15, separate `ExitAtlasGoogle` target | n/a | Compiles in CI; consent, key, Google map, ExitAtlas panel below the map | Not run on a phone. The panel has no SmartStop line. |
| Profile | `ProfileSettings.swift`, `ProfileRules.swift` | `engine/profile.js` | Saved settings, migrations, import and export, shared fixtures | No setting for the Drive presentation. |

## 15.2 Most important differences from the target

1. Drive is a scrolling stack of cards, not a navigation screen: no map, and the next exit is below the fold.
2. No Navigation View at all, on either platform.
3. Information is repeated instead of summarized (state card).
4. The adaptive card can flicker and a routine pick can outrank a hazard just ahead.
5. Alerts have one visual weight; filters hide them silently.
6. Road Ahead looks like a list, not a route timeline.
7. The best stop and its restroom facts are buried; no restroom shortcut.
8. Surfaces are flat grey; there is no deliberate night palette, route color or elevation.
9. Scrolled content collides with the floating top bar.
10. No automated check that the essentials fit on screen, no landscape or small phone screenshots.

## 15.3 Drive: proposed hierarchy

One Drive tab, two presentations, switched by a small control in the top bar (map and gauge icons) and saved in the profile as `drivePresentation` (`map` or `focus`, default `map`). Both use the same components and the same adaptive card.

```
Navigation View (portrait)                Focus View (portrait)
┌─────────────────────────────┐          ┌─────────────────────────────┐
│ status · weather · ⧉ · End ·👤│ top bar  │ status · weather · ⧉ · End ·👤│
│ ┌─────────────────────────┐ │          │ ┌──────┐ ┌───┐  [95] I-95 N │ instruments row
│ │[95] I-95 N  Exit 366 1.6│ │ guidance │ │  56  │ │ 70│  FL Florida  │
│ │ Gas · Food   or maneuver│ │          │ └──────┘ └───┘              │
│ └─────────────────────────┘ │          │ NEXT STATE Georgia   18 mi  │ state line
│ (56)(70)               (🚻) │ speed    │ 3 exits left · 5:59 AM ▓▓▓░ │
│                             │          │ ┌─ EXIT 366 ─ Gas Food 1.6 ┐│ next exit
│         MAP (route,         │          │ └──────────────────────────┘│
│      puck, next exit,       │          │ ┌ adaptive card ───────────┐│ one card
│   alert, best stop, line)   │          │ └──────────────────────────┘│
│                             │          │ 925 mi · ETA 3:12 AM · 9 st │ trip strip
│ ┌ adaptive card ──────────┐ │          └─────────────────────────────┘
│ └─────────────────────────┘ │
│ FL→GA 18 mi · 3 exits │ ETA │ trip strip
└─────────────────────────────┘
```

* Guidance banner: the next maneuver from the route's own steps when one comes within 10 miles (fork, off ramp, merge onto another road, arrival), else the next exit with its services. The demo route has 79 steps (forks, ramps, merges with road refs), so this is real data. Discovery mode has no steps and shows the next exit.
* Speed: current speed and the posted limit (existing Valhalla limits); nothing is shown where the limit is unknown.
* Map: the route ahead in route blue, the part behind dimmed, the vehicle, and only: the next exit, the alert in the adaptive card, the recommended stop, the next state line. No other places.
* Adaptive card: one of alert, planned stop, fuel, gas gap, last open overnight, overnight restroom, rest area, state line approach, next exit (Navigation View only; in Focus View the next exit always has its own row).
* Trip strip: state, miles to the next state, exits left, ETA and miles remaining. Tapping opens the Trip tab.
* Restroom shortcut (🚻): opens the best restroom stop in the next 60 miles with up to two alternatives.
* Landscape: map on the left two thirds, guidance, adaptive card and trip strip in a right column; Focus View keeps its two columns.
* Budget at 390×844 (portrait, Focus View): top bar 103, instruments 96, state line 132, next exit 92, adaptive card 104, trip strip 56, tab bar 83: 666 of 844 points, so everything is visible without scrolling. At 375×667 the trip strip may need a scroll; speed, state line, next exit and the card must not.

## 15.4 Adaptive card rules (both engines, shared fixtures)

* Order: a serious alert within 10 mi; fuel below reserve; a serious alert within 50 mi; planned stop within 15 mi; gas gap risk; alert within 10 mi; state line within 5 mi (new); fuel stop within 30 mi; last open overnight; overnight; rest area; next exit.
* Stability (new `FocusStabilizer`): a card stays at least 30 seconds unless something of higher rank qualifies; a candidate must qualify on two readings in a row (about 2 seconds) before it replaces the card; a passed or expired alert does not come back for 10 minutes.
* A routine fuel pick never hides a serious alert within 10 miles.

## 15.5 Road Ahead, alerts and stops

* Timeline: a route line down the left with nodes in route order (exits, rest areas, the SmartStop pick, state lines, alerts, gas gaps, planned stops); state lines are full width landmarks ("FL → GA, 112 mi in Georgia"); the SmartStop pick is a highlighted card ("BEST STOP AHEAD").
* Filters: All, Alerts, Fuel, Rest, States (replacing the eight category chips; food and lodging stay on each exit and in Find along route). Under any filter but All and Alerts, a pinned line says how many alerts are hidden and switches to Alerts on tap.
* Alert tiers: urgent (red: serious alerts), caution (amber: closures, crashes, hazards, work zones that close lanes), information (blue: work zones with lanes open, minor or unknown severity). Card: what, where (highway and direction, "in your direction" or "direction not reported"), how far, how recent, source and verification. Tap opens a detail sheet.
* Best stop card: name, exit, distance, hours line with its status, restroom line with its status, detour labeled as an estimate; up to two alternatives; the reasons behind "Why this stop". A 24 hour listing never makes a restroom "open".

## 15.6 Design system

`design/tokens.json` stays the single source. Changes: dark surfaces move from neutral grey to charcoal with a navy cast (bg #07090D, card #11151C, raised #161C26), new `navy`, `route`, `route-casing`, `route-passed`, `info`, `info-fill`, `danger-fill`, `success-fill`, `map-*` night colors, and an elevation token; light mode keeps its contrast. The contrast test gains the new pairs. Highway signs keep their MUTCD colors.

## 15.7 Maps

* iOS: MapKit (already used on the Trip tab; no per request cost for apps): `.standard(elevation: .realistic, emphasis: .muted, pointsOfInterest: .excludingAll)`, following camera with pitch, route polylines and our own annotations.
* Web: MapLibre GL JS (BSD 3 clause, bundled in the site and loaded only for Navigation View) with OpenFreeMap vector tiles (OpenStreetMap data; "no registration, no user database, no API keys", commercial use allowed, attribution added by MapLibre; [openfreemap.org](https://openfreemap.org/), read 2026-10-29). Offline or when tiles fail, the route, vehicle and markers still draw on a plain background and the screen says the map is offline. Tiles are not stored by the app.
* Neither map shows Google content, and nothing from Google's navigation is redrawn anywhere.

## 15.8 Google mode (PR #15)

Continue the existing branch; no second integration. Add the SmartStop line to its ExitAtlas panel and align the panel with the new tokens, rebase on main, keep it a draft. The device test plan is docs/14 §14.7, extended with battery (percent per hour, Google mode against regular mode), build and download size (App Store Connect), costs (destinations counted in Settings against the Google Cloud console) and the interaction with ExitAtlas GPS. Police alerts stay "not verified" until a drive records them.

## 15.9 Files

* Engine (both, shared fixtures): `dashboard.js` / `DashboardFocus.swift` (state line kind, order, `FocusStabilizer`), new `guidance.js` / `Guidance.swift` (next maneuver), alert tier helper in `roadintel.js` / `RoadIntel.swift`, `profile.js` / `ProfileRules.swift` / `ProfileSettings.swift` (`drivePresentation`).
* Web: `views.js` (Drive, Ahead, alerts, stop card), `main.js` (presentation, map lifecycle, filters), new `navmap.js` (MapLibre), `app.css`, `tokens.css` (generated), `sw.js`, `index.html`, `web/vendor/maplibre-gl/`.
* iOS: `DriveView.swift` (split into Drive, Focus, Navigation files), new `NavigationMapView.swift`, `ExitsView.swift`, `AlertViews.swift`, `SmartStopViews.swift`, `FuelView.swift`, `Theme.swift`, `Tokens.swift` (generated), `UserSettings`, `ScreenshotTests.swift`.
* Tests: dashboard, guidance, alert tier and profile fixtures; web layout checks (Playwright: essentials inside the viewport at 375×667, 390×844 and 844×390, both themes, both presentations); iOS UI tests that check the same frames, plus landscape and dark screenshots.
* Docs: this file; docs/06 screens; README.

## 15.10 Order of work

Kept: every engine (route matching, SmartStop, Road Intelligence, speed limits, weather, profile), all data, signs and shields, the sheets that work. Rebuilt: only the Drive layout, the Road Ahead presentation, the alert and stop cards, and the tokens.

1. This audit (docs only).
2. Engine: focus order and stability, state line kind, guidance, alert tiers, `drivePresentation`, with fixtures in both engines.
3. Web Drive: tokens, Focus View, Navigation View with MapLibre, presentation control, layout checks. Live on the site as each part passes.
4. iOS Drive: Focus View, Navigation View with MapKit, presentation control; screenshot rounds through CI before merging (the only iPhone simulator available is CI's).
5. Road Ahead timeline, filters and alert tiers (web, then iOS).
6. Best stop card and restroom shortcut (web, then iOS).
7. Google mode panel on PR #15 (stays a draft).
8. Validation: full test suites, screenshot sets, real device checklist.

## 15.11 Limits

* No iPhone simulator runs in this workspace; iOS screens come from CI (iPhone 16e). A smaller device is added to CI if its simulator is installed on the runner.
* The website cannot track GPS after the browser is suspended, and it cannot embed Google's navigation; its Navigation View is MapLibre with the app's own data.
* Map tiles need a connection on both platforms; offline, the route and the app's own data still show.
* Battery use is not measured here; nothing claims an improvement.
