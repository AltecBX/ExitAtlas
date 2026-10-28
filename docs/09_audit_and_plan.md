# 9. Product audit and plan (2026-10-28)

This is the starting point for the next generation of ExitAtlas: what exists today, verified against the code and tests rather than the README, what is broken, what competitors do, and the order of work. Research notes with sources are in `docs/research/` (gathered with research agents on 2026-10-28; every claim carries a URL and unverified items are marked UNVERIFIED).

**How it was checked**
* Code read file by file: the Swift engine (25 sources, 9 test files), the iOS app (27 sources, 1 UI test file), the web app (18 modules, 6 test files), the data pipeline and every document.
* Tests run here: web 51 of 51 pass (Node 22); Swift engine 47 of 47 pass (Swift 6.3.3 on Linux, the same toolchain as CI). The iOS app builds and runs its UI tests only in CI on macOS.
* Interface: headless Chromium at iPhone SE, 15 Pro, 15 Pro Max and landscape sizes, light and dark, on the bundled demo route.
* Not checked: a real drive with the iOS app; a real drive with the fuel, price and EV features of the web app; gas prices with a real Google key.

## 9.1 Feature inventory

"Tested" means an automated test checks the behavior with real route geometry and independent expected values. The iOS app has no unit tests of its own; its two UI tests check only that the Drive and Exits screens render, so iOS rows rely on the engine tests underneath.

### Class 1: implemented and tested (web and iOS)

| Feature | Engine and tests | Notes |
|---|---|---|
| State segmentation: ordered states, exact border crossings, reentry, brief crossings, stretches outside every state | `RegionSegmenter` / `RegionIndex`; fixture tests on 4 real routes against a shapely/pyproj oracle, published I-95 lengths within 0.06 mi | Same results in Swift and JavaScript |
| Exits matched to the route with direction | `ExitMatcher`; tests against OSM node membership, reversed route test | Exit numbers never used for counting |
| Exits remaining before each state line, miles per state, state completion | `TripSnapshot`; node membership test | Web now shows the completion percent as a number |
| GPS map matching, dead reckoning in tunnels, off route detection | `RouteProgressTracker`; 6 tracking tests | |
| Driven miles per state across reroutes | `TripLedger`; reroute test on Richmond to New York | |
| Time zones and local crossing times | `TimeZoneResolver`; Atlanta to Nashville test | |
| Discovery mode (no destination) | `HighwayDiscovery`; locks onto I-95 Northbound on the third fix | Release after misses is untested |
| Search along the route, every requirement at the same exit | `AlongRouteSearch`; multi criteria test | |
| Stop planner by drive time | `StopPlanner`; hotel about 3 hours ahead test | Distance window untested |
| Voice for state lines (5 mi warning, "Welcome to") and exits | `VoiceAnnouncements` (Swift) and `announcer.js` (web), shared logic; tests drive a real route through a reroute | Fixed in this milestone, see 9.2 |
| Simulated demo drive | `GPSSimulator` | Clearly labeled as a simulation |

### Class 2: in the web version, missing from iOS

| Feature | Web files | iOS today |
|---|---|---|
| Speedometer with posted limit (OSM `maxspeed` via Valhalla), next limit change, over limit alert | `web/js/app/limits.js`, `views.js` (cluster) | No speed display at all |
| Vehicle picker over every EPA vehicle since 2000, verified tank sizes (20 makes, 6,925 versions), EV range | `vehicles.json`, `views.js` (vehicleSheet), `tools/data-pipeline/build_vehicles.py` | Manual MPG and tank steppers; `vehicles.json` is bundled but never read |
| Fuel stop from miles to empty with a buffer, favorite brands anywhere in range, last chance warning, fuel voice | `web/js/engine/fuel.js` | Tank percent slider, reserve fixed at 2 gal, brands only filter priced stations (and there are no prices) |
| Gas prices with the driver's own Google key | `web/js/app/prices.js` | None |
| EV charging stops (Tesla or all DC fast) along the route | `web/js/app/chargers.js`, `fuel.js` | Category filter only |
| Pace model: recent pace blended into trip pace with a personal prior from earlier trips | `web/js/engine/tracking.js` (`PaceModel`) | Older single ratio model, calibrated from MapKit (biased on trips with stops) |
| Saved places (Home and recents) | `main.js` (places) | Saved whole trips only |
| Offline resume after reload | `main.js` (persist, resume) | Resume recomputes the route, so it needs a connection |
| Landscape two column dash, sign style cards, state ledger ribbon, text that follows the reader's size | `css/app.css`, `views.js` | Portrait layout; fixed font sizes; colors now from the shared tokens |

### Class 3: partial or needs improvement

| Area | Today | Gap |
|---|---|---|
| Rest areas | Milestone 3: timeline items on the driver's side with amenities as tagged, hours, truck parking (9.10) | Closures and open status unknown; amenity tags missing for 37%; some plazas missing from the source |
| Exit names | Shown when present | Empty for about 92% of exits in the source data |
| Coverage | Signed interstates | Turnpikes and US routes without an interstate number show no exits (Florida's Turnpike) |
| Voice | State lines, exits, fuel, rest areas, last gas before a gap, time zone changes (milestone 3) | No planned stop message; untested on a real drive |
| Stop planner | Ranked by time, detour, favorite brand and listed restrooms, with reasons; "Add to trip" reroutes (milestone 3) | No price, hours, pets or EV compatibility in the ranking (no data yet) |
| Speed limits | OSM data through the public FOSSGIS Valhalla server | Coverage gaps show "No limit data"; fair use server |
| Gas prices | Driver's own Google key, one exit at a time | Not tested with a real key; cannot be cached or ranked across a shared feed (Google terms) |
| EV chargers | DOE AFDC with `DEMO_KEY` | The demo key allows 30 requests an hour and 50 a day per IP; carrier NAT can exhaust it |
| Routing and search | Public OSRM demo and Nominatim | Fine for personal use; not allowed for a published app at scale (9.6) |
| Accessibility | Web: some labels, text now scales | iOS: fixed font sizes, missing VoiceOver labels on state badges and map; no landscape design |
| iOS tests | Engine tests only | No app unit tests; UI tests assert two strings |
| Trip history | Ledger, lifetime miles and states (iOS), trip history list | No per trip map, passport, or shareable summary; discovery miles are not kept on iOS |

### Class 4: not implemented

Live Activities and Dynamic Island; CarPlay; Home and Lock Screen widgets; Siri and Shortcuts questions ("How far to Georgia in ExitAtlas"); voice search inside the app; rest areas as timeline items with verified amenities; a stop ranking engine (price, detour, hours, brand and restaurant preferences, pets, EV compatibility); business hours and open status; hotel pet policies; traffic, closures, work zones and weather alerts; Discover Ahead (scenic and historic places); Road Trip Passport and achievements; shareable trip summaries; passenger features; automatic offline data refresh; a backend for keys and caching; turn side (left or right off the ramp); a "report a problem" loop; Android.

## 9.2 Defects found

| ID | Where | Defect | Status |
|---|---|---|---|
| V1 | Web and iOS voice | State line and "Welcome to" messages keyed by segment index, which restarts at 0 on every new plan, so after a reroute they could stop for the rest of the trip | **Fixed** (PR #3). Shared logic keyed by state and odometer; tests on a real route through a reroute (the old web code fails the new test) |
| T2 | iOS `TripController.reroute` | Force unwrap of the destination after dropping passed stops: crash near the end of a trip | **Fixed** (PR #3) |
| T6 | iOS resume | Silent when no route is found | **Fixed** (PR #3) |
| L1 | iOS `LocationService` | A finished or failed location stream left a stale task, so tracking could not restart | **Fixed** (PR #3) |
| F2 | Swift `FuelPlanner` | At or below the reserve the station list was empty | **Fixed** (PR #3), with a test |
| C1 | Design | Light amber text at 4.4:1 contrast | **Fixed** (PR #3): 5.7:1, enforced by a test |
| T3 | iOS ETA calibration | Routes straight to the destination, skipping stops, then compares with a profile that includes them; pace comes out too low on multi stop trips | Open: replace with the web pace model (Milestone 2) |
| T4 | iOS reroute and calibration tasks | A late result can apply to a newly started trip | Open (Milestone 2) |
| T5 | iOS discovery | Miles driven in discovery mode are not kept in history | Open (Milestone 2) |
| E1 | Engine tracker | If the route is never matched (start away from the route), no reroute fires and no miles are credited | Open (Milestone 2, both engines) |
| E2 | Engine ledger | Distance during the off route confirmation window (3 fixes and 6 s) is credited nowhere | Open (small undercount; Milestone 2) |
| F1, F3, F4 | Swift `FuelPlanner`, `FuelView` | Per station ETA set to trip arrival; brand match is a substring test; plan recomputed on every view pass | Open: replaced by porting `fuel.js` (Milestone 2) |
| M1 to M5 | iOS `MapKitRouteService` | Highway label parsed from instruction text; uniform time per leg; unused options; no throttling handling; deprecated `MKPlacemark` | Open (Milestone 2 and 6) |
| L2, L3 | iOS location | Permission state never shown; planning from "Current location" before permission may time out | Open (Milestone 2) |

## 9.3 Documentation corrected

README (web only labels, test counts, CI details), docs 02 (vehicle data size, Google price terms), 03 (data files, where the UI still does geometry), 04 (statuses describe iOS, trip persistence built, no cap on alternatives, web prices and EV), 06 (tracking status scope, Resume card, alternatives), 07 (test counts), and five code comments that described behavior the code does not have.

## 9.4 Competitors (summary of docs/research/2026-10-28_competitors.md)

* **Pit Stop** ([App Store](https://apps.apple.com/us/app/pit-stop-road-trip-exit-guide/id6795296025), [site](https://www.pit-stop-app.com/)) is the closest rival and is moving fast: first release 2026-08-01, v1.4 on 2026-10-10. Offline OSM plus Overture data refreshed over Wi-Fi, a CarPlay driving app with brand logo rows, rest areas inline at mile markers since v1.2, a Lock Screen and Dynamic Island strip and spoken alerts for last gas, state lines and time zone changes in v1.4. One time purchase. Per its listing, no miles or exits left per state, no crossing times, no gas prices and no fuel planner.
* **iExit** ([App Store](https://apps.apple.com/us/app/iexit-interstate-exit-guide/id401746066)) leads on ratings (4.8 from 37,669 on iOS) and has CarPlay. Recurring 2026 complaints in its review feed: wrong gas prices with no fix, no sort by price within a distance ("best priced stations in the next 100 miles"), stale exit numbers and businesses, losing the highway lock, CarPlay freezes, ads.
* **Pike** ([App Store](https://apps.apple.com/us/app/pike-next-exit-guide/id6759123383)) is built on OpenInterstate like ExitAtlas and adds turn left or right badges, round trip detour estimates and one tap "add as a stop" to an Apple or Google Maps trip.
* **GasBuddy, Roadtrippers, Nexit**: price accuracy, ads, subscription and cancellation complaints; no CarPlay for GasBuddy or Nexit.
* **Unique ground for ExitAtlas**: no app reviewed shows miles or exits left in a state or local crossing times. That is the identity to protect and to bring to the Lock Screen and CarPlay.
* **Gaps to fill**: cheapest reachable fuel within range with source and age on every price; rest areas with verified amenities and a truck only flag; visible data age and a correction path; no ads; lock status with a manual override.

## 9.5 Apple platform (summary of docs/research/2026-10-28_apple_platform.md)

* **Live Activity first.** Up to 8 hours active (12 on the Lock Screen), 4 KB of state, started only from the foreground (or an App Intent or a push). Local updates from the running app are documented, with no published budget (unverified in practice); push updates need a server. On iOS 26 and later a Live Activity also appears on the CarPlay Dashboard and the Apple Watch Smart Stack, non interactive, using the `.small` supplemental family ([WWDC25 session 216](https://developer.apple.com/videos/play/wwdc2025/216/)). No CarPlay entitlement is needed for that.
* **CarPlay app**: the best fit is the **driving task** category ("road status" apps), with fueling (plus EV charging) as a fallback. Driving task allows list, grid, information, point of interest, tab bar, alert and action sheet templates, depth 2 (3 on iOS 26.4+), refresh at most every 10 s (points of interest every 60 s), no custom maps and no search template. The entitlement is requested at [developer.apple.com/carplay](https://developer.apple.com/carplay/) and is not guaranteed.
* **Siri and Shortcuts**: up to 10 App Shortcuts, each phrase must include the app name and at most one parameter from an enum or entity ("How far to Georgia in ExitAtlas"). In CarPlay Siri answers by voice only.
* **Location**: keep `CLLocationUpdate.liveUpdates(.automotiveNavigation)` with `CLBackgroundActivitySession` and `CLServiceSession` (what the app does today); When In Use authorization is enough.
* **Widgets**: roughly 40 to 70 refreshes a day; fine for a trip summary, not for live distances.

## 9.6 Data, infrastructure and legal (summary of docs/research/2026-10-28_infrastructure_and_legal.md)

* **Public servers** (OSRM demo, Nominatim, FOSSGIS Valhalla) are acceptable for a personal app with fair use; not for an App Store app (non commercial clause, 1 request per second for all users combined, a remote off switch required by the Nominatim policy). What breaks first: the AFDC demo key, then a Nominatim block that stops search for every user.
* **Recommended stacks** (estimates; the research note has the assumptions): personal web app $0 a month (public servers with an off switch and client identification, or Stadia Maps free tier; AFDC behind a small Cloudflare Worker with a registered key). App Store app with about 10,000 monthly users: about $140 to $270 a month plus a fuel price license, for example self hosted Valhalla and Photon on one 32 GB server or Stadia Maps Standard ($80), Cloudflare Workers ($5), MapKit for the map on iOS.
* **Gas prices**: Google Places prices may be shown without a map with attribution, never next to a non Google map, never cached; a shared "cheapest ahead" ranking needs a licensed feed (OPIS, TomTom or HERE fuel prices, quote only). GasBuddy and AAA do not allow reuse. EIA weekly regional averages are public domain and can label estimates.
* **Hazards**: NWS alerts are open; USDOT WZDx work zone feeds are public domain but coverage is patchy (none for Georgia or South Carolina); state 511 feeds need written permission.
* **Interstate shield**: a live AASHTO service mark ([USPTO registration 835,635](https://tsdr.uspto.gov/statusview/rn0835635)). Labeling actual routes, as every map app does, is low risk; ask AASHTO in writing before an App Store launch and keep the shield out of the icon and branding. US Route shields and MUTCD colors are public domain.
* **Fonts**: Overpass (SIL Open Font License) is bundled for sign lettering. Clearview files are commercial. Pit Stop's website also uses Overpass; ExitAtlas uses it only inside sign elements, with the system font everywhere else.
* **Brand logos**: brand names as text are nominative use; logos need permission (App Review 5.2.1). ExitAtlas shows names as text.

## 9.7 Design system (delivered in Milestone 1)

* `design/tokens.json` is the single source for colors (light and dark), type sizes, spacing and radii; `tools/design/build-tokens.mjs` generates `web/css/tokens.css` and `App/ExitAtlas/Design/Tokens.swift`. A test fails when either is stale or when a text or sign color pair drops below its WCAG minimum (7:1 for primary text, 4.5:1 for everything else).
* Sign vocabulary follows MUTCD meanings, not any app's layout: green guide signs for exits, blue for motorist services and rest areas, brown for parks and attractions, yellow for warnings. Business names are text, never logos.
* The **state ledger ribbon** (the whole route split into states in proportion to their miles, with where you are) leads the state card. No competitor reviewed has it; it is the visual signature.
* Web components: exit tab, advance guide sign for the next exit (name or services, distance and time), service plaques that name the nearest places, state ribbon, state completion percent. Type follows the reader's text size (Safari maps `-apple-system-body` to Dynamic Type); nothing a driver reads is smaller than 12 px.
* Screenshots for review: iPhone SE, 15 Pro, 15 Pro Max and landscape, light and dark (PR #3).
* Decided 2026-10-28 (Jerry): keep the drawn Interstate shield and Overpass for sign lettering. The AASHTO letter stays on the release checklist (milestone 6).

## 9.8 Feature to code map

| Proposed feature | Reuse | New |
|---|---|---|
| iOS parity: vehicle picker, miles to empty fuel stops, favorites, EV stops, saved places, speedometer | Engine geometry, `vehicles.json`, the web modules as the reference behavior, `Tokens.swift` | Swift ports of `fuel.js`, `limits.js`, `chargers.js`, `PaceModel`; SwiftUI views. Prefer moving each into `ExitAtlasCore` with tests shared through the existing fixtures |
| Rest areas in the timeline | `InterstateDataset` places (category 4), `ExitMatcher` projection, `TripSnapshot.upcomingExits` | A route item type for rest areas and service plazas projected onto the route by direction; amenity fields from OSM tags in the data pipeline; "verified" vs "unknown" in the schema |
| Stop ranking engine | `AlongRouteSearch`, `StopPlanner`, `planStop` (fuel), favorites, prices | A scoring module (reachability, detour, price, preferences, hours) with explainable reasons; "add to trip" that reroutes through `findRoutes` / `MapKitRouteService` |
| Voice: time zone, last gas, rest areas, planned stops; frequency controls | `VoiceAnnouncements` and `announcer.js` (shared), `TimeZoneResolver`, fuel planner | New message kinds and settings categories with tests |
| Live Activity, Dynamic Island, CarPlay Dashboard | `TripSnapshot` (next state, miles and exits left, crossing time, next exit, ETA) | Widget extension target in `App/project.yml`, `ActivityAttributes`, small family layout |
| CarPlay app (driving task) | Snapshot, exits, services | `CPTemplateApplicationSceneDelegate`, list and information templates; needs the entitlement |
| Siri questions | Snapshot, search along the route | App Intents with an `AppEnum` of states |
| Discover Ahead | Route projection code, exit services | Attractions dataset (OSM tourism tags, NPS, Wikidata with notability filter); pipeline step |
| Passport and history | `TripLedger` stints, lifetime totals, trip history | Achievements model, per trip map, share card renderer |
| Offline data refresh | `tools/data-pipeline` with pinned sources | Versioned manifest, signed downloads over Wi-Fi, last known good fallback, provenance per record |
| Production infrastructure | Current service clients | Cloudflare Worker for keys and budgets; switch routing and search providers behind one interface |

## 9.9 Plan

Each milestone ends in a pull request with tests, screenshots where the interface changes, and a short note of what was verified on a simulator versus a device.

| Milestone | Scope | Acceptance |
|---|---|---|
| **1. Audit, fixes, design system** (this PR) | 9.1 to 9.3; defects V1, T2, T6, L1, F2, C1; tokens; sign components, plaques, state ribbon and progress details on web; Theme reads tokens on iOS | Web 51 and Swift 47 tests pass; screenshots light and dark on 4 sizes; no horizontal overflow; iOS builds in CI |
| **2. iOS parity** | Port the vehicle picker, miles to empty planner, favorites, EV stops, saved places, speedometer and limits, and the web pace model into `ExitAtlasCore` (one implementation, tests from the shared fixtures); fix T3 to T5, E1, E2, L2, L3; iOS sign components and state ribbon from the tokens; Dynamic Type and VoiceOver | Engine tests for each port match the web results on the same fixtures; iOS screenshots for each new screen |
| **3. Exits, rest areas, stops** | Rest areas and service plazas as timeline items with verified amenity badges only when tagged; "next gas N miles" gap rows; stop ranking with reasons and "add to trip"; time zone, last gas and rest area voice with frequency controls | Placement tests (rest area order and direction on fixture routes); ranking tests; voice tests |
| **4. Lock Screen and car** | Live Activity with the small family (also CarPlay Dashboard and Watch); request the CarPlay driving task entitlement; App Shortcuts for state questions | Live Activity state tests; CarPlay Simulator screenshots once entitled |
| **5. Discovery and history** | Discover Ahead with a quality filter; Road Trip Passport; shareable summaries; one passenger feature after the core is stable | Data quality checks; snapshot tests of the share card |
| **6. Infrastructure and release** | Data refresh pipeline with versions and provenance; Worker for keys and budgets; production routing and search; App Store readiness (privacy strings, review risks, AASHTO letter) | Update and rollback tests; budget tests; a real device drive |

## 9.10 Milestone status

| Milestone | State | Verified |
|---|---|---|
| 1 | Merged (PR #3) | Web and engine tests; web screenshots on 4 sizes |
| 2 | Merged (PR #4) | Engine ports tested against the web cases (66 tests then); iOS builds and its screenshot tests pass in CI; not run on a device |
| 3 | Merged (PR #5) | See below |
| 4 | PR #6 | Live Activity (Lock Screen, Dynamic Island, CarPlay Dashboard, Watch), six App Shortcuts, CarPlay scaffold not enabled; details and device checks in docs/10 |

Milestone 3 delivered:

* **Data:** `tools/data-pipeline/build_rest_areas.py` builds `restareas.json`: 1,332 mainline facilities (1,054 rest areas, 136 welcome centers, 94 service plazas, 48 parking areas) from OpenStreetMap with current tags, conflated with the FHWA Truck Stop Parking survey (1,055 matched). Side of road comes from the nearest carriageway; it agrees with direction words in OSM names for 414 of 418 named rest areas. Branded `highway=services` (Love's, Pilot, TA...) are now a Travel Center category at their exit instead of "Rest Area"; mainline facilities no longer appear as an exit's service.
* **Engine (Swift and JavaScript):** rest area matching (driver's side only, median facilities both ways, nothing on non interstate roads), gas gaps, ranked stop suggestions with reasons, voice for rest areas, the last gas before a long stretch and time zone changes. Tests: placement on the Miami to Manhattan and Richmond to New York fixtures in both directions, gas gaps, ranking order, voice on Atlanta to Nashville (Eastern to Central once).
* **Interfaces (web and iOS):** rest area rows and a Drive card with verified amenity chips, a rest area detail screen with OSM links, "No gas for N mi" rows and a Drive heads up, settings for each voice message and the gap length, ranked stops with "Add to trip" (reroutes through the stop; live GPS only).
* **Not done or not verifiable here:** amenity coverage is what mappers tagged (58% of facilities have a restrooms tag, 37% have none of the tracked tags); closures and open status need state DOT feeds; some plazas and their gas stations are missing from the source (Maryland House; Chesapeake House shows no gas); "Add to trip" and the new voice messages are untested on a real drive.

## 9.11 Blockers and external dependencies

* A real drive with the iOS app (needs Jerry's iPhone with a development build).
* CarPlay entitlement from Apple (weeks to months, not guaranteed).
* A licensed fuel price feed for shared or server side prices (quote only providers).
* AASHTO's answer on the Interstate shield before an App Store launch.
* Rest area amenity and open status coverage: depends on OSM tags and state DOT feeds (research in progress).
* Hosting costs once the app moves off the public servers (9.6).
