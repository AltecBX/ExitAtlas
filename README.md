# ExitAtlas

An interstate road trip companion. While you drive, it answers:

* What exit is coming up next, and what is there?
* How many miles are left in this state, and how many exits before the next state line?
* How much of the route is in each upcoming state, and when do I cross into it (in local time)?
* Where should I stop for gas or a charge, and what does gas cost there?

**Use it on a phone now:** https://altecbx.github.io/ExitAtlas/web/

Open it in Safari or Chrome and allow location. In Safari, Share, Add to Home Screen opens it full screen like an app.

## Status

| Part | State |
|---|---|
| Web version (`web/`) | Used on real drives. The dash and arrival times have had road feedback; fuel, gas prices, SmartStop, EV stops, rest areas, the adaptive Drive screen and the newer voice messages have not yet. |
| iOS app (`App/`) | Builds and passes its screenshot UI tests in CI (latest macOS runner and Xcode, iPhone simulator). Not yet run on a device. Since milestone 2 it has the same features as the web version, built on the same engine. |
| Engine (`Sources/ExitAtlasCore`) | 104 tests pass on Linux, with the web's 90 tests covering the same cases in JavaScript. |
| Key proxy (`infra/worker`) | 7 tests pass. Not deployed: needs a Cloudflare account and the keys ([infra/worker/README.md](infra/worker/README.md)). |

The full feature inventory, by platform and test coverage, and the prioritized plan are in [docs/09_audit_and_plan.md](docs/09_audit_and_plan.md).

## Features

In both the web version and the iOS app unless marked.

**On the road**
* Three areas: Drive, Ahead and Trip. Settings, vehicles, places and your profile open from the person button at the top of every screen.
* A Drive screen that adapts without adding cards: speed and highway, state progress, one focus card picked by a fixed priority (fuel below your reserve, a planned stop, a stretch without gas your range may not cover, your fuel stop, overnight stops, a rest area, the next exit), a one line "Then" strip with the next two items, and the destination.
* Road Ahead: exits, rest areas, state lines, stretches without gas and planned stops in route order, with the SmartStop pick marked.
* Next exit with its services (gas, food, lodging, EV charging, travel centers), exits ahead with state lines inline, and search along the route.
* Rest areas, welcome centers and service plazas at their own place on the route, on your side of the highway only, with the amenities OpenStreetMap lists (restrooms, water, pet area and more). Nothing is shown as available unless it is tagged.
* Stretches without gas: "No gas for 62 mi" in the exits list, and a heads up on the Drive screen before the last exit with gas.
* State line card: next state, miles to the line, exits left, and the crossing time in local time.
* Arrival and border times that follow your actual pace, with a personal prior from earlier trips.
* Speedometer with the posted speed limit (OpenStreetMap) and an alert when you are over by your chosen margin.
* Automatic reroute (miles per state survive it), and discovery mode when there is no destination.
* Voice for state lines, time zone changes, rest areas, the last gas before a long stretch, fuel stops and exits, each with its own switch.

**Stops**
* SmartStop: where to stop next for fuel, with one recommendation and up to two alternatives and the reasons for each. It uses your range and reserve, your brands in order (Shell first to start), the routed detour, and the hours and restrooms at your arrival time in that stop's time zone. Stops already passed, ones you skip, ones reported closed at arrival and ones no longer listed as gas stations are never offered, and it says why your first choice brand lost when it does.
* Stop confidence as labels, never a score: "Verified open at estimated arrival" (Google business hours, with your key), "Reported open, verification limited" (OpenStreetMap, with its check date), "Hours unavailable", "Reported closed at estimated arrival", and for restrooms "confirmed accessible at estimated arrival" (rest areas and plazas with listed hours only), "confirmed available, hours unknown" or "availability unknown". Pumps, store, restroom, restroom hours, plaza hours and parking are shown separately.
* Overnight Drive Mode: automatic from 12 AM to 4 AM by each stop's local arrival time (adjustable), or on or off by hand. Overnight, stops listed open at arrival and confirmed restrooms rank first, and the app says so when nothing ahead is confirmed. Before a long stretch where no stop is listed open at its arrival time, the last one that is takes the Drive screen's focus card and is spoken once.
* Plan a stop about N hours ahead: ranked by how close it is to your time, the detour, your favorite brands and listed restrooms, with the reasons shown. Rest stops include rest areas on the highway (no detour).
* Add a suggested stop to the trip and reroute through it (live GPS only).

**Discover and keep**
* Discover ahead: up to five notable places in the next 200 miles (national and state parks, monuments, museums, zoos, waterfalls), 1,620 in all from Wikidata, within 5 miles of the interstate (10 for parks and natural sites). Each shows how far off the highway it is, and "Add to trip" reroutes through it (live GPS only). Hours and closures are not known.
* Your travels (in Settings): miles and trips in each state and in total, from real GPS trips; simulated drives and discovery mode never count. Statistics only, no badges or achievements.
* Trip history and a share card of the trip (miles and miles per state, marked when simulated).

**Your profile**
* Saved vehicles (one in use, each with its own MPG or range choice), favorite gas brands in priority order (Shell to start), fuel grade, what a fuel stop must have (open 24 hours, restroom, longest detour), the overnight window, home, saved and recent places, saved trips, favorite services and hotel and restaurant brands, display and voice choices.
* Saved on every change and restored at launch; there is no Save button and no account. Trips, app and website updates and data updates never reset it. A save the device refuses is shown in Settings, never reported as saved.
* A damaged value falls back to its default on its own; an unreadable profile falls back to the copy before the last change, and the damaged copy is kept.
* Export and import as one file, the same format on the web and iOS. The website and the app keep separate profiles: there is no sync, so deleting the app, clearing website data or switching browsers starts fresh unless you import an export. API keys are never exported.

**Lock Screen, Siri and the car** *(iOS)*
* A Live Activity with the next exit, the next state line, the next rest area and your arrival time, on the Lock Screen, in the Dynamic Island, on the CarPlay Dashboard and on Apple Watch.
* Siri and Shortcuts: "How far to Georgia in ExitAtlas", "Next rest area in ExitAtlas", "Next gas in ExitAtlas", "Find the next Shell in ExitAtlas" (31 brands), "Find an open gas station with a restroom in ExitAtlas", "What is the best stop in the next 50 miles in ExitAtlas" (25, 50 or 100) and three more, answered in full sentences that say when hours or restrooms are not confirmed.
* A CarPlay app needs Apple's driving task entitlement first; see [docs/10](docs/10_lock_screen_and_carplay.md).

**Fuel and charging**
* Vehicle picker: EPA fuel economy for every vehicle since 2000, and EPA range for electric vehicles.
* Verified tank sizes for 20 makes, covering 6,925 versions; any other car asks for its tank size once.
* Fuel stop: enter the miles to empty from your dash. ExitAtlas picks the last exit with gas that you reach with your buffer left, preferring your favorite brands.
* Gas prices at each exit from Google Maps, with your own key (optional, see below), with the business hours and restroom field from the same request.
* Tesla Superchargers, or all DC fast chargers, along the route from the U.S. Department of Energy.

**Trips**
* Home, saved and recent places and saved trips, for one tap routing.
* The trip is saved every 30 seconds and resumes after a reload (on iOS, resuming needs a connection to recompute the route).
* State, time zone, exit and rest area data are on the phone; no connection is needed for them.
* Data updates: each data file is checked against the SHA-256 in `manifest.json` before use, and a bad or unreadable download falls back to the last set that worked. The iOS app checks for newer data once a day on Wi-Fi and never switches data during a trip ([docs/11](docs/11_release_readiness.md)).

Exit and rest area data cover signed interstates only. Turnpikes and US routes without an interstate number show no exits. Rest area coverage depends on OpenStreetMap: some service plazas are missing, and closures are not known.

## Optional keys

Entered in Settings and stored only on the device: in the Keychain on iOS, in browser storage on the web (never in profile exports).

| Key | Needed for | Cost |
|---|---|---|
| Google Maps Platform, Places API (New) | Gas prices per station | Google bills per lookup after a monthly free allowance; ExitAtlas shows its lookup count in Settings. See [web/README.md](web/README.md). |
| NREL developer key ([developer.nlr.gov](https://developer.nlr.gov/signup/)) | More than 10 charger lookups an hour | Free |
| ExitAtlas key proxy URL (web) | Prices and charger lookups with the owner's keys and daily limits instead of a key on the phone | Cloudflare Workers Free plan; Google bills price lookups |

## Layout

| Path | What it is |
|---|---|
| `web/` | Browser version for phones: the engine ported to JavaScript, live GPS, no build step ([web/README.md](web/README.md)) |
| `Sources/ExitAtlasCore` | Platform independent Swift engine: geodesy, state segmentation, exit matching, GPS map matching, trip ledger, ETAs, discovery mode, stop and fuel planning, GPS simulator |
| `Tests/ExitAtlasCoreTests` | Engine tests on real routes with independent oracles |
| `App/` | SwiftUI iOS app (XcodeGen spec, MapKit, Core Location) |
| `App/ExitAtlas/Resources/Data` | Bundled offline data: state and time zone boundaries, exits and services, interstate corridors, vehicles |
| `tools/data-pipeline` | Scripts that rebuild the bundled data from pinned public sources, and `manifest.json` with versions and checksums |
| `infra/worker` | Optional key proxy for Cloudflare Workers: server side keys, daily budgets, off switches |
| `docs/` | Research, feature comparison, data sources and licensing, architecture, spec, data models, screens, roadmap, testing ([docs/README.md](docs/README.md)) |

## Develop

**Web version.** Serve the repository root, then open http://localhost:8000/web/:

```
python3 -m http.server 8000
```

Run its tests:

```
cd web
npm test
```

**Engine tests** (macOS or Linux, Swift 6):

```
swift test
```

**iOS app** (Mac with Xcode 16 or newer):

```
brew install xcodegen
cd App
xcodegen generate
open ExitAtlas.xcodeproj
```

Select your team under Signing, then run on an iPhone (iOS 17+). Use **Simulate** on a planned route to try the app without driving.

**Hosting.** GitHub Pages serves the repository root from the branch chosen in Settings, Pages. The page needs HTTPS, because browsers give GPS only to secure pages.

## Data and licenses

* **Exits and places:** OpenStreetMap contributors via [OpenInterstate](https://openinterstate.org/), ODbL 1.0. The derived databases (`interstates.eax`, `corridors.eac`, `restareas.json`) are available under the ODbL, and `tools/data-pipeline` rebuilds them.
* **Rest area truck parking:** FHWA Truck Stop Parking survey (NTAD, 2019), public domain.
* **Discover places:** Wikidata (CC0), `discover.json`, rebuilt by `tools/data-pipeline/build_discover.py`.
* **State boundaries:** U.S. Census Bureau TIGER/Line 2026 (public domain).
* **Time zones:** USDOT BTS NTAD Time Zones (public domain).
* **Fuel economy and EV range:** U.S. EPA and DOE, fueleconomy.gov (public domain).
* **Fuel tank sizes:** manufacturer specifications, or two reputable sources that agree. Each entry in `tools/data-pipeline/fuel_tanks.json` cites its sources.
* **Web routing and search:** the OSRM demo server and Nominatim, both on OpenStreetMap data (ODbL), for light personal use under their usage policies.
* **Speed limits:** OpenStreetMap `maxspeed`, via the FOSSGIS public Valhalla server.
* **EV chargers:** U.S. DOE Alternative Fuels Data Center.
* **Gas prices:** Google Maps Platform, with the driver's own key, under Google's terms. Prices are shown with attribution and never stored.
* **iOS maps and routing:** Apple MapKit.

Details and terms for each source: [docs/02_data_sources_and_licensing.md](docs/02_data_sources_and_licensing.md).
