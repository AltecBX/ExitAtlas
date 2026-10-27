# ExitAtlas

An interstate road trip companion for iOS. It answers, continuously while you drive:

* What exit is coming up next, and what is there?
* How many miles are left in this state, and how many exits before the next state line?
* How much of the route is in each upcoming state, and when do I cross into it (in local time)?
* How far to the destination, and where should I stop?

Status: research, design and the first functional version. See [docs/](docs/README.md).

## Layout

| Path | What it is |
|---|---|
| `Sources/ExitAtlasCore` | Platform independent engine: geodesy, state segmentation, exit matching, GPS map matching, trip ledger, ETAs, discovery mode, stop and fuel planning, GPS simulator |
| `Tests/ExitAtlasCoreTests` | Engine tests on real routes with independent oracles |
| `App/` | SwiftUI iOS app (XcodeGen spec, MapKit, Core Location) |
| `App/ExitAtlas/Resources/Data` | Bundled offline datasets (state and time zone boundaries, exits and services, interstate corridors) |
| `tools/data-pipeline` | Scripts that rebuild the bundled datasets from public sources |
| `docs/` | Research, feature comparison, licensing, architecture, spec, data models, screens, roadmap, test plan |

## Run the engine tests (macOS or Linux, Swift 6)

```
swift test
```

## Build the iOS app (Mac with Xcode 16 or newer)

```
brew install xcodegen
cd App
xcodegen generate
open ExitAtlas.xcodeproj
```

Select your team under Signing, then run on an iPhone (iOS 17+). Use **Simulate** on a planned route to try the app without driving.

## Data and licenses

* Exits and places: OpenStreetMap contributors via [OpenInterstate](https://openinterstate.org/), ODbL 1.0. The derived database shipped in the app (`interstates.eax`, `corridors.eac`) is available under the ODbL; `tools/data-pipeline` rebuilds it.
* State boundaries: U.S. Census Bureau TIGER/Line 2026 (public domain).
* Time zones: USDOT BTS NTAD Time Zones (public domain).
* Maps and routing: Apple MapKit.
