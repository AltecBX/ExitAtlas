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
| Web version (`web/`) | Used on real drives. The dash and arrival times have had road feedback; the fuel, gas price and EV features have not yet. The web version is ahead of the iOS app. |
| iOS app (`App/`) | Builds and passes UI tests in CI (Xcode 26.6, iPhone 16e simulator). Not yet run on a device. |
| Engine (`Sources/ExitAtlasCore`) | 44 tests pass on Linux. The pace model, fuel and charging planners and vehicle data are still to be ported from the web version. |

## Features

**On the road**
* Next exit with its services (gas, food, lodging, EV charging), exits ahead with state lines inline, and search along the route.
* State line card: next state, miles to the line, exits left, and the crossing time in local time.
* Arrival and border times that follow your actual pace, not the routing estimate.
* Speedometer with the posted speed limit (OpenStreetMap) and an alert when you are over by your chosen margin.
* Automatic reroute (miles per state survive it), and discovery mode when there is no destination.
* Voice for state lines, exits and fuel stops.

**Fuel and charging**
* Vehicle picker: EPA fuel economy for every vehicle since 2000, and EPA range for electric vehicles.
* Verified tank sizes for 20 makes, covering 6,925 versions; any other car asks for its tank size once.
* Fuel stop: enter the miles to empty from your dash. ExitAtlas picks the last exit with gas that you reach with your buffer left, preferring your favorite brands.
* Gas prices at each exit from Google Maps, with your own key (optional, see below).
* Tesla Superchargers, or all DC fast chargers, along the route from the U.S. Department of Energy.

**Trips**
* Home and recent places, for one tap routing.
* The trip is saved every 30 seconds and resumes after a reload, even offline.
* State, time zone and exit data are cached on the phone after the first load.

Exit data covers signed interstates only. Turnpikes and US routes without an interstate number show no exits.

## Optional keys (web)

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

* **Exits and places:** OpenStreetMap contributors via [OpenInterstate](https://openinterstate.org/), ODbL 1.0. The derived databases (`interstates.eax`, `corridors.eac`) are available under the ODbL, and `tools/data-pipeline` rebuilds them.
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
