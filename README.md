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
| Web version (`web/`) | Used on real drives. The dash and arrival times have had road feedback; fuel, gas prices, EV stops, rest areas and the new voice messages have not yet. |
| iOS app (`App/`) | Builds and passes its screenshot UI tests in CI (latest macOS runner and Xcode, iPhone simulator). Not yet run on a device. Since milestone 2 it has the same features as the web version, built on the same engine. |
| Engine (`Sources/ExitAtlasCore`) | 78 tests pass on Linux, with the web's 63 tests covering the same cases in JavaScript. |

The full feature inventory, by platform and test coverage, and the prioritized plan are in [docs/09_audit_and_plan.md](docs/09_audit_and_plan.md).

## Features

In both the web version and the iOS app unless marked.

**On the road**
* Next exit with its services (gas, food, lodging, EV charging, travel centers), exits ahead with state lines inline, and search along the route.
* Rest areas, welcome centers and service plazas at their own place on the route, on your side of the highway only, with the amenities OpenStreetMap lists (restrooms, water, pet area and more). Nothing is shown as available unless it is tagged.
* Stretches without gas: "No gas for 62 mi" in the exits list, and a heads up on the Drive screen before the last exit with gas.
* State line card: next state, miles to the line, exits left, and the crossing time in local time.
* Arrival and border times that follow your actual pace, with a personal prior from earlier trips.
* Speedometer with the posted speed limit (OpenStreetMap) and an alert when you are over by your chosen margin.
* Automatic reroute (miles per state survive it), and discovery mode when there is no destination.
* Voice for state lines, time zone changes, rest areas, the last gas before a long stretch, fuel stops and exits, each with its own switch.

**Stops**
* Plan a stop about N hours ahead: ranked by how close it is to your time, the detour, your favorite brands and listed restrooms, with the reasons shown. Rest stops include rest areas on the highway (no detour).
* Add a suggested stop to the trip and reroute through it (live GPS only).

**Discover and keep**
* Discover ahead: up to five notable places in the next 200 miles (national and state parks, monuments, museums, zoos, waterfalls), 1,620 in all from Wikidata, within 5 miles of the interstate (10 for parks and natural sites). Each shows how far off the highway it is, and "Add to trip" reroutes through it (live GPS only). Hours and closures are not known.
* Road Trip Passport: states driven and achievements (five states, 1,000 miles, coast to coast and more) from real GPS trips; simulated drives never count.
* Share cards: an image of the trip (miles and miles per state, marked when simulated) or of the Passport.
* License plate game for passengers, kept per trip.

**Lock Screen, Siri and the car** *(iOS)*
* A Live Activity with the next exit, the next state line, the next rest area and your arrival time, on the Lock Screen, in the Dynamic Island, on the CarPlay Dashboard and on Apple Watch.
* Siri and Shortcuts: "How far to Georgia in ExitAtlas", "Next rest area in ExitAtlas", "Next gas in ExitAtlas" and three more, answered in full sentences.
* A CarPlay app needs Apple's driving task entitlement first; see [docs/10](docs/10_lock_screen_and_carplay.md).

**Fuel and charging**
* Vehicle picker: EPA fuel economy for every vehicle since 2000, and EPA range for electric vehicles.
* Verified tank sizes for 20 makes, covering 6,925 versions; any other car asks for its tank size once.
* Fuel stop: enter the miles to empty from your dash. ExitAtlas picks the last exit with gas that you reach with your buffer left, preferring your favorite brands.
* Gas prices at each exit from Google Maps, with your own key (optional, see below).
* Tesla Superchargers, or all DC fast chargers, along the route from the U.S. Department of Energy.

**Trips**
* Home and recent places, for one tap routing.
* The trip is saved every 30 seconds and resumes after a reload (on iOS, resuming needs a connection to recompute the route).
* State, time zone, exit and rest area data are on the phone; no connection is needed for them.

Exit and rest area data cover signed interstates only. Turnpikes and US routes without an interstate number show no exits. Rest area coverage depends on OpenStreetMap: some service plazas are missing, and closures are not known.

## Optional keys

Entered in Settings and stored only on the phone.

| Key | Needed for | Cost |
|---|---|---|
| Google Maps Platform, Places API (New) | Gas prices per station | Google bills per lookup after a monthly free allowance; ExitAtlas shows its lookup count in Settings. See [web/README.md](web/README.md). |
| NREL developer key ([developer.nlr.gov](https://developer.nlr.gov/signup/)) | More than 10 charger lookups an hour | Free |

## Layout

| Path | What it is |
|---|---|
| `web/` | Browser version for phones: the engine ported to JavaScript, live GPS, no build step ([web/README.md](web/README.md)) |
| `Sources/ExitAtlasCore` | Platform independent Swift engine: geodesy, state segmentation, exit matching, GPS map matching, trip ledger, ETAs, discovery mode, stop and fuel planning, GPS simulator |
| `Tests/ExitAtlasCoreTests` | Engine tests on real routes with independent oracles |
| `App/` | SwiftUI iOS app (XcodeGen spec, MapKit, Core Location) |
| `App/ExitAtlas/Resources/Data` | Bundled offline data: state and time zone boundaries, exits and services, interstate corridors, vehicles |
| `tools/data-pipeline` | Scripts that rebuild the bundled data from pinned public sources |
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
