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
* Restroom: "Restroom confirmed accessible at estimated arrival" only at rest areas and service plazas whose listed hours cover the arrival (the restroom is the building). "Restroom confirmed available, hours unknown" when tagged or listed at a station. "Restroom availability unknown" otherwise; "Listed without a restroom" when tagged no. A 24 hour station can lock its restroom overnight, so a station restroom is never shown as open at arrival.
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

**Not done here.** Restroom hours at gas stations (no source lists them); official plaza closures; warnings before the last open stop overnight on a long stretch (Priority 4, with the dashboard); Siri commands for SmartStop (Priority 6).
