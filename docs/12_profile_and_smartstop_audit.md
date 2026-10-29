# 12. Profile, SmartStop and overnight driving: audit (2026-10-28)

Starting point: `main` at 798b8e5 (no commits after it). This audit covers what the next four pull requests change, in the order the owner set: persistent profile, Shell first and Overnight Drive Mode, SmartStop and stop confidence, Road Ahead and the adaptive dashboard, design and navigation, Siri, and removal of games and achievements.

## 12.1 What is saved today

| Data | iOS | Web | Notes |
|---|---|---|---|
| Vehicle (one) | UserDefaults `vehicle` (JSON) | `ea.settings.vehicle` | Web also keeps 8 recent vehicles (`ea.vehicles`); iOS has no list |
| MPG basis, custom MPG or range | Inside the iOS vehicle | `ea.settings` (global, not per vehicle) | |
| Favorite brands | UserDefaults `favoriteBrands` | `ea.settings.favoriteBrands` | Order is kept but cannot be changed in either interface |
| Fuel reserve | `bufferMiles` | `ea.settings.bufferMiles` | |
| Voice, speed alert, gas gap length, Live Activity, tolls | UserDefaults keys | `ea.settings` | |
| Exit lookahead | `exitLookaheadMiles` | `ea.window` (separate key) | |
| Theme | follows the system | `ea.settings.theme` | |
| Home and 10 recent places | `places.json` (Application Support) | `ea.places` | No saved or favorite places beyond Home |
| Saved trip plans | `saved.json` | none | |
| Trip history, pace history | `history.json`, `pace_history.json` | `ea.history`, `ea.paceHistory` | |
| Active trip, fuel reading | `active.json`, UserDefaults `fuelReading` | `ea.active`, `ea.fuel` | Trip state, correctly separate |
| API keys | UserDefaults `googleKey`, `nrelKey` | `ea.googleKey`, `ea.nrelKey`, `ea.proxyURL` | |
| Data manifest (last good) | Application Support `Data/` | `ea.dataManifest` | Data, correctly separate from preferences |
| Plate game | `@AppStorage("plates")` | `ea.plates` | To be removed (12.4) |

Starting or ending a trip, data updates and rollback do not touch preferences on either platform (checked in the code paths: `endTrip`, `DataUpdater`, `loadCoreData`).

## 12.2 Bugs and gaps found

1. **iOS, damaged files erase history.** `TripLibrary` decodes `history.json`, `saved.json` and `places.json` all or nothing. One damaged or unreadable record gives an empty list, and the next write replaces the file, so every trip in it is lost.
2. **iOS, vehicle can silently disappear.** A vehicle record that no longer decodes (for example after a format change) loads as "no vehicle"; choosing one again then overwrites the old record.
3. **iOS, keys in UserDefaults.** The Google and NREL keys are stored in plain preferences; they belong in the Keychain.
4. **iOS, demo launch overwrites the profile.** The `-demoVehicle` screenshot argument writes a Camry and Shell into the real preferences (simulator only today, but the demo should never touch the profile).
5. **No schema version or migration** on either platform; every format change risks problems 1 and 2.
6. **Web, failed saves are silent.** `store.set` reports failure (storage blocked or full) but no caller checks it, so the app can say "saved" when nothing was.
7. **Web, damaged settings are replaced.** If `ea.settings` cannot be parsed, defaults load and the next change overwrites the damaged copy; nothing is kept to recover from.
8. **Web, storage can be evicted.** Safari deletes script written storage (localStorage, IndexedDB, service worker caches) after "seven days of Safari use without user interaction on the site". Web apps added to the Home Screen "are not part of Safari and thus have their own counter of days of use", so using the app resets it ([WebKit blog, March 2020](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)). The app does not say so and does not ask the browser for persistent storage.
9. **Web, shared origin.** Every GitHub Pages site under `altecbx.github.io` shares one origin, so another page published from the same account could read ExitAtlas storage, including any API key entered there. The key proxy avoids keeping keys in the browser at all.
10. **Missing preferences:** multiple vehicles with a default; brand priority order; fuel grade; 24 hour and restroom requirements; maximum detour; price versus brand; overnight window; saved places beyond Home; favorite hotel and restaurant brands; favorite service categories; web saved trip plans.
11. **No way to move a profile** between the website and the iOS app, or to back it up.

## 12.3 Plan for storage

| Category | iOS | Web | Lifecycle |
|---|---|---|---|
| Profile (vehicles, fuel and overnight preferences, places, display, voice) | `Application Support/profile.json`, schema versioned, written atomically | `ea.profile`, schema versioned | Permanent; migrated, never reset by trips or data updates |
| Saved trip plans, trip history, pace | existing files, read record by record | existing keys | Permanent |
| Current trip, fuel reading | existing | existing | Ends with the trip |
| Offline datasets | bundle and `Data/` sets | service worker cache | Replaced by data updates |
| Live data (prices, chargers, speed limits) | memory | memory | Minutes |
| API keys | Keychain | browser storage, never exported; proxy preferred | Until removed |

One profile format (JSON) is shared by both platforms and by import and export, with the same validation and migration code in Swift (`ExitAtlasCore`) and JavaScript (`web/js/engine`) tested on the same fixtures. Each field is validated separately, so one damaged value falls back to its default without touching the others, and an unreadable profile is kept aside as a copy before anything is written. Web storage stays in localStorage: the profile is a few kilobytes, IndexedDB would add code without more durability (Safari applies the same eviction to both), and the app will request persistent storage where browsers support it.

**Cross platform sync is not built.** The website and the iOS app keep separate profiles. Sync would need an account system and a server holding personal location data; export and import of the same profile file gives the same result with no account. Units stay in miles: the data, exit numbers and road signs are all in miles.

## 12.4 Not wanted and to be removed

The license plate game (web and iOS), the Road Trip Passport achievements and the Passport share card. Trip history, real miles per state and the trip card stay; the state map of miles driven stays as plain statistics.

## 12.5 Files that change

* Profile: `Sources/ExitAtlasCore/Profile/` (new), `web/js/engine/profile.js` (new), `App/ExitAtlas/Model/UserSettings.swift`, `SavedTrips.swift`, `AppModel.swift`, `web/js/app/services.js`, `main.js`, `views.js`.
* SmartStop and overnight: `Sources/ExitAtlasCore/Planning/` (StopPlanner, FuelPlanner, new opening hours and SmartStop), `web/js/engine/fuel.js`, `discovery.js` and new modules, the data pipeline (station hours and restroom tags).
* Road Ahead, dashboard and navigation: `App/ExitAtlas/Views/`, `web/js/app/views.js`, `design/tokens.json`.
* Siri: `App/ExitAtlas/Intents/TripIntents.swift`, `Sources/ExitAtlasCore/Trip/TripAnswers.swift`.

## 12.6 Priority 1 delivered: permanent profile

| Gap (12.2) | Fix | Checked by |
|---|---|---|
| 1. Damaged files erase history | `TolerantList` reads `history.json` and `saved.json` record by record; a file with unreadable records is copied aside (`<name>.corrupt-<time>`) before anything is written | `ProfileStoreTests.testTolerantList` |
| 2. Vehicle disappears | Vehicles live in the profile and are checked one by one; one bad vehicle is dropped and listed, the others stay | Shared fixture `damaged` (both platforms) |
| 3. Keys in UserDefaults | `KeychainStore` (this device only, after first unlock); the UserDefaults copy is removed only after the Keychain holds the key | Linux run of `UserSettings` with a stand in Keychain; the real Keychain only on a device |
| 4. Demo overwrites the profile | `-demoTrip` uses a temporary profile, temporary trip files and in memory keys | Code path; CI screenshots run in demo mode |
| 5. No schema | Schema 2 with migration from the version one keys on each platform; the old keys are left as they were | Fixtures `web_v1`, `ios_v1`; test M |
| 6. Silent failed saves | Every write is read back; a refusal is shown in Settings ("browser storage is full", "blocked", or the file error) | Web test and browser run with a full store |
| 7. Damaged settings replaced | The damaged text is kept; an unreadable profile falls back to the copy before the last change | Test L, browser run |
| 8. Safari eviction | Persistent storage is requested after the first save; Settings explains the Home Screen counter and offers export | Browser run (the request's answer depends on the browser) |
| 9. Shared origin | Not changed: keys stay in their own browser keys, are never exported, and the key proxy keeps them off the phone | |
| 10. Missing preferences | Vehicles with a default, brand order, grade, 24 hours, restroom, detour, price over brand, overnight window, saved places, saved trips (web), favorite services, hotel and restaurant brands, appearance on iOS | Fixture `full` round trip on both platforms |
| 11. No way to move a profile | Export and import of one file on both platforms; iOS saved trips travel as `plans` | Test S, `testTripPlansRoundTrip` |

Acceptance tests covered here: A, B, C, I, J, K, L, M, N, S. The SmartStop and overnight tests (D to H, O, P), the dashboard (Q) and the removals (R) come with the next pull requests. The iOS screens are checked in CI screenshots on the simulator; nothing here has run on a device.

## 12.7 Priorities 2 and 3: SmartStop, Overnight Drive Mode and stop confidence

**What SmartStop answers.** Where to stop next for fuel: one recommendation and up to two alternatives, each with short reasons, from the gas stations at the exits ahead and the service plazas with fuel on the highway (restroom stops add rest areas and welcome centers). It extends the existing range planner: the candidates are the same exits, now one candidate per station, plus the fuel plazas the planner did not consider. The engine is `web/js/engine/smartstop.js` and `Sources/ExitAtlasCore/Planning/SmartStop.swift`, with the opening hours reader beside each (`openinghours.js`, `OpeningHours.swift`).

**Sources, as evaluated.**

| Source | What it gives | Coverage on interstate exits | Cost and terms | Used as |
|---|---|---|---|---|
| OpenStreetMap, current tags from the OSM API (`stations.json`) | opening_hours, toilets, check date, current brand, stations removed or no longer fuel | Hours for 2,295 of 19,679 stations (1,822 of them 24/7); restroom tag on 106; check date on 538 of those with hours; 274 no longer gas stations; 106 rebranded (fetched 2026-10-28) | Free, ODbL 1.0 | "Reported" hours; restroom confirmed when tagged; removed stations never offered |
| Google Places API (New), Nearby Search | currentOpeningHours (business hours for the coming week, special hours included), restroom (yes or no) | Unknown until used; only exits whose prices were looked up | Enterprise and Enterprise + Atmosphere fields. Google bills a request "at the highest SKU applicable to your request" ([usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)); the price lookup already asks for fuelOptions (Enterprise + Atmosphere), so adding hours and restroom adds no charge. Driver's key or the owner's proxy; not stored | "Verified" store hours; restroom confirmed when listed |
| Rest areas and service plazas (`restareas.json`, OSM plus FHWA 2019 survey) | Facility hours, toilets tag, truck spaces | Restroom tag on 58% of facilities | Free (ODbL, public domain) | Plaza and rest area hours, restroom, parking |
| State DOT and turnpike plaza listings | Official plaza hours and closures | Separate per state, no common feed found in this work | Varies | Not used |
| Commercial POI providers | Station hours and amenities | Not measured | Quote only | Not used |

No source used here lists restroom hours at gas stations (`toilets:opening_hours` appears on none of the 19,679).

**Stop confidence: labels, not a score.** There is no defensible way to turn these sources into a number, so each stop shows statuses with their source and date.

* Hours at the estimated arrival, in the stop's own time zone: "Verified open at estimated arrival" (Google business hours), "Reported open, verification limited" (OpenStreetMap, with its check date), "Reported closed at estimated arrival" (either source closed and none open), "Hours unavailable" (nothing listed, or hours the reader cannot parse: open ends like "18:00+", sunrise, months; 18 of the 2,295).
* Restroom: "Restroom listed, open at arrival per listed hours" only at rest areas and service plazas whose listed hours cover the arrival (the restroom is the building). "Restroom listed, access hours unknown" when tagged or listed at a station. "Restroom availability unknown" otherwise; "Listed without a restroom" when tagged no. A 24 hour station can lock its restroom overnight, so a station restroom is never shown as open at arrival.
* Facilities evaluated separately in "What is known at arrival": pumps (OpenStreetMap hours), store (Google hours), restroom, restroom hours, plaza or rest area hours, parking (FHWA truck spaces where surveyed).

**Overnight Drive Mode.** Auto by default from 12:00 AM to 4:00 AM, using each stop's estimated arrival in that stop's time zone (a station across the Central time line is judged by Central time), never the current clock alone. On and Off override it, in Settings and on the fuel screen. When it applies (and the "Open at arrival" and "Restroom" preferences are set to overnight, the default), stops listed open at arrival and stops with a confirmed restroom rank first, and the screen says plainly when no stop ahead has a confirmed restroom or listed hours.

**Ranking, in order (deterministic; ties by station id).**
1. Never offered: stations already passed, stations the driver skipped on this trip ("Not this one"), stations removed from OpenStreetMap or no longer gas stations, stops reported closed at arrival, stops beyond the range.
2. Set aside unless nothing else is left: stops below the reserve (fuel), detours measured over the driver's limit, stops listed without a restroom when a restroom is needed. When every stop is below the reserve, the nearest comes first and the reasons say how much range is left on arrival.
3. Open at arrival (verified, then reported, then unknown) and confirmed restroom (accessible, then available, then unknown), when each applies; for a restroom stop the restroom comes first.
4. Cheaper fuel, only when "Cheaper fuel over favorite brands" is on and Google prices are loaded.
5. The favorite brands in the driver's order (Shell first by default).
6. Fuel stops: the later stop, which uses more of the range (the planner's existing rule). "Best stop ahead": the smaller measured detour, then the nearer stop.
7. Measured detour.

Alternatives come from other exits first. When the driver's first choice brand is not picked, the screen says why (closed at arrival, out of range, below the reserve, over the detour limit, skipped, or less confirmed hours or restroom). Detours are the routed round trip from the exit data; where the data has no routed time, the screen says "Detour not measured".

**Checked by.** Shared fixtures run by both engines (`Tests/ExitAtlasCoreTests/Fixtures/smartstop`): opening hours (24/7, weekday ranges, past midnight, added rules, holidays, unparseable), local time across zones and the end of daylight saving time, stop confidence (D, E, O), rankings (F, G, H and the overnight, skip, detour, price and alternative rules), and six cases on the real Miami to Manhattan route recorded by the web engine and matched by the Swift engine (P), which also checks that both read stations.json and the route the same way. Web: the demo trip in a browser (fuel card and sheet, overnight on, skip). iOS: CI build and simulator screenshots; nothing on a device.

**Not done here.** Restroom hours at gas stations (no source lists them); official plaza closures. The warning before the last open stop overnight came later (12.10), and the Siri commands with Priority 6 (12.9).

## 12.8 Priorities 4 and 5: Road Ahead, adaptive Drive screen, navigation and design

**Navigation.** Three areas: Drive, Ahead and Trip. Settings, vehicles, places and the profile open from the person button at the top of every screen (a sheet on iOS, a view on the web), so nothing moved out of reach and no tab was added. Every setting that existed before is still there.

**Adaptive Drive screen (acceptance test Q).** The screen always has the same cards: instruments (speed, posted limit, highway), state progress (the signature card), one focus card, a one line "Then" strip with the next two items, and the destination. A fixed priority picks the focus card (`web/js/engine/dashboard.js`, `Sources/ExitAtlasCore/Trip/DashboardFocus.swift`, shared fixtures in `Tests/ExitAtlasCoreTests/Fixtures/dashboard`):

1. Fuel below the reserve.
2. A planned stop within 15 miles (with the exit to leave at).
3. A stretch without gas within 25 miles that the range may not cover.
4. The fuel stop within 30 miles.
5. Overnight Drive Mode: the SmartStop pick with its hours and restroom confidence, or without a range reading, the best restroom stop in the next 60 miles.
6. A rest area before the next exit within 10 miles.
7. The next exit.

The strip takes the next two items (the fuel stop or "Enter range", a gas gap, the planned stop, the rest area, the next exit), never repeating the focus. More alerts replace less urgent ones; they never add cards. Landscape shows two columns (instruments and focus left, state progress and destination right).

**Road Ahead.** The Exits screen becomes Road Ahead: exits, rest areas, state lines, stretches without gas and now planned stops in route order, the SmartStop pick marked on its row with its hours confidence, the distance window, and category filters in one scrolling row. Exit and rest area details open on tap. Not added: road alerts (no verified source is integrated).

**Design.** A new `tint` token (sign green in light mode, a brighter green in dark mode, 4.5:1 or better on cards and the background, checked by `web/tests/design.test.js`) for tabs, switches and links; buttons with white text keep sign green.

**Checked by.** Shared focus fixtures on both engines; web screenshots in light and dark, portrait and landscape (Playwright); iOS simulator screenshots in CI (Road Ahead and Settings from the person button). Nothing on a device.

## 12.9 Priorities 6 and 7: Siri commands and the removals

**Siri and Shortcuts (iOS).** Three new App Shortcuts, nine in all (Apple allows ten). Each answer is built in the engine (`TripAnswers`, tested on Linux) from the same SmartStop ranking the app shows, and says what is not confirmed:

| Phrase | Answer |
|---|---|
| "Find the next Shell in ExitAtlas" (31 brands; any brand works inside the app) | The nearest station of that brand in the next 150 miles that is still listed, with its distance, time and hours label. When it is reported closed at arrival, it says so and gives the next one. |
| "Find an open gas station with a restroom in ExitAtlas" | SmartStop with "open 24 hours" and "restroom" required, in the next 60 miles, within your range. When nothing ahead is confirmed it says so ("No stop ahead has a confirmed restroom. Restroom availability is unknown at these stops.") rather than naming a station as open. |
| "What is the best stop in the next 50 miles in ExitAtlas" (25, 50 or 100) | The SmartStop pick with its reasons (first choice brand, hours label, detour) and one alternative. |

A station restroom is never spoken as open at arrival: only rest areas and plazas with listed hours can be (acceptance test E). Example from the test on the Miami to Manhattan route: "The best match: Exxon at exit 363B, 56 miles ahead, about 1 hour 5 minutes. Reported open, verification limited. About a 4 minute detour. No stop ahead has a confirmed restroom. Restroom availability is unknown at these stops. Alternative: Shell at exit 318, 11 miles ahead, about 12 minutes."

**Removed (acceptance test R).** The license plate game, the Road Trip Passport achievements ("Next up", badges) and the Passport share card, on the web and iOS, with their code (`passport.js`, `Passport.swift`, the plate views and actions). Nothing links to them any more.

**Kept.** Trip history, real GPS miles and the trip card. Miles and trips per state now show as plain statistics in Settings, "Your travels" (`travels.js`, `TravelStats.swift`). No stored data is deleted: the trip history file and the old plate list (`ea.plates`, `@AppStorage("plates")`) stay as they were. On the web only "Erase profile and trip history" removes them, as before; the iOS app has no erase action, so they stay until the app is deleted.

**Also fixed.** The iOS SmartStop card marked every reason with a checkmark, including "Hours unavailable"; reasons now use a neutral dot, as on the web.

**Checked by.** `SmartStopAnswerTests` (brand, best stop and restroom answers on a real route; the restroom notice is not repeated), `DiscoverTravelTests` and `web/tests/discover.test.js` (statistics from history, simulated trips excluded), a web check that no screen shows the Passport, achievements or plates while the stored history and plate list are unchanged, and the iOS screenshot test, which fails if "License plate game" is reachable. Siri phrases are compiled in CI; speaking them needs a device and was not done.

## 12.10 Overnight: the last stop listed open before a long stretch

The request asked for "warnings before the last known suitable opportunity along a long stretch without services". The gas gap warning (no gas for N miles) already existed; this adds the overnight case, where the stations exist but none is listed open at the time you would reach it.

**Rule** (`lastOpenBeforeGap` in `web/js/engine/smartstop.js` and `SmartStop.swift`, shared fixtures in `Fixtures/smartstop/cases.json`):

* Only a stop listed open at its arrival time (Google business hours or OpenStreetMap hours) can be named.
* The stretch after it ends at the next stop listed open, at a stop reached after the overnight window that is not reported closed, or 150 miles ahead (the route's end when nearer). Stops already passed, skipped ("Not this one") or no longer listed are left out.
* It counts when it is at least as long as "Flag stretches without gas over" (40 miles by default; no new setting) and has stops reached overnight in it. A stretch with no stations at all is a gas gap and keeps its own warning; one with no overnight arrivals is not an overnight stretch.

**Shown.** When the stop is within 25 miles, it takes the Drive screen's focus card, after fuel below the reserve, a planned stop, a gas gap the range may not cover and the fuel stop within 30 miles, and before the general overnight card: "Last stop listed open for 53 mi", the stop with its hours label, and how many stops after it have no hours listed open. Nothing is added to the strip.

**Spoken** once per stop, within 6 miles, under the existing "Last gas before a long stretch" switch: "Overnight, Shell at Exit 49 in 5 miles is the last stop listed open for 53 miles." It is not spoken for the exit whose last gas was just announced.

**How often.** On the Miami to Manhattan route, evaluated as if every arrival were overnight, there are 8 such stretches of 40 miles or more in 1,281 miles; an overnight window of four hours covers about 250 miles of driving, so about one or two a night. Most stations have no hours in OpenStreetMap (2,295 of the 19,679 bundled stations do), so these stretches mean "not listed", not "closed"; the card and the voice say "listed open" for that reason.

**Checked by.** Seven shared fixture cases on both engines (the warning, a plain gas gap, the overnight window ending, an open ended stretch, a closed and a skipped stop, a daytime stretch of closed stops, and unknown hours before the first open stop), four dashboard fixture cases (it takes the focus, too far away, the fuel stop and a gas gap outrank it), voice tests on both platforms, the web demo in a browser at mile 400 with Overnight Drive Mode on (light and dark), and an iOS simulator screenshot test that launches the demo at mile 400 with `-overnight on`. Not checked on a real overnight drive.
