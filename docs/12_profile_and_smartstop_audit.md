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
