# 3. Architecture

## 3.1 Recommendation

Native Swift and SwiftUI, iOS 17 minimum, with all route, state and exit logic in a platform independent Swift package (`ExitAtlasCore`) that has no Apple framework dependencies.

Why native Swift:
* Core Location live updates, background activity sessions, CarPlay, Live Activities and widgets are first class only in native code.
* MapKit is free to use for map display and routing in a native app, avoids Google's map coupling rules, and is the only map allowed with Apple route data.
* One language for engine and UI. The engine also builds and tests on Linux, so CI is cheap and fast.

## 3.2 Layers

| Layer | Contents | Depends on |
|---|---|---|
| Data | Bundled binary datasets: `states.eab`, `timezones.eab`, `interstates.eax`, `corridors.eac` | Built offline by `tools/data-pipeline` |
| Engine (`ExitAtlasCore`) | Geodesy, `RoutePolyline`, `RegionIndex`, `RegionSegmenter`, `ExitMatcher`, `RouteProgressTracker`, `TripLedger`, `PaceModel`, `TripPlan`, `TripSnapshot`, `TripSession`, `HighwayDiscovery`, `AlongRouteSearch`, `StopPlanner`, `FuelPlanner`, `GPSSimulator` | Foundation only |
| Platform services (app) | `LocationService` (Core Location), `MapKitRouteService`, `PlaceSearch`, `Announcer` (AVSpeech), `DriveSimulator` | Apple frameworks |
| Controllers (app) | `AppModel`, `TripController`, `UserSettings`, `TripLibrary` (Observation framework) | Engine and services |
| UI (app) | SwiftUI views: Drive, Exits, Trip, Settings, sheets | Controllers |
| Later: backend | Alerts aggregation (NWS, WZDx, 511), AFDC refresh, dataset publishing, optional Valhalla | Public feeds |

Data flow per GPS fix: `LocationService` emits a `LocationSample`, `TripController` passes it to `TripSession.ingest`, which runs the tracker, updates the ledger and pace, and returns an immutable `TripSnapshot`. SwiftUI renders the snapshot. Nothing in the UI recomputes geometry.

## 3.3 The route, state and exit engine

1. Route geometry arrives from a provider as coordinates. `RoutePolyline` stores cumulative ellipsoidal distance (Vincenty, WGS84) at every vertex and a grid index of segments. Every "miles along the route" number in the app comes from this array.
2. `RegionSegmenter` walks the route. For each route segment it finds exact intersections with state boundary edges (grid indexed) and classifies each piece by a point in polygon test at its midpoint. Segments without crossings inherit the current state, so cost is linear in route length. Output: ordered `RegionSegment`s with entry and exit points, visit numbers for reentry, and a brief flag. Boundary noise (A, tiny B, A under 50 m) is merged.
3. `ExitMatcher` projects every nearby exit node onto the route, once per pass. An encounter is accepted only when the node is within the offset limit and its carriageway bearing agrees with the route bearing within 40°. Limits depend on geometry source: 5 m for OSM based routes, 15 m for Apple or Google routes. Exits are ordered by distance along the route; counts are positional. Same node seen twice, or the same label within 800 m, merge into one signed exit.
4. `TripPlan` combines route, state segments, exits and time zones. Exit counts before any distance are binary searches over exit distances.
5. `RouteProgressTracker` map matches fixes: all passes within a search radius are candidates, scored on offset versus accuracy, course versus route bearing, and continuity with expected progress. Off route needs three misses over six seconds. No fix for 4 seconds starts dead reckoning along the route for up to 3 minutes, then "signal lost".
6. `TripLedger` credits progress to states, only beyond the furthest point already credited, and credits GPS distance while off route to the state at the fix. It survives reroutes, so completed state miles never depend on the current route.
7. `PaceModel` compares actual moving time to the provider's expected time (30 minute prior), and can be re-anchored to a live provider ETA. Rest stops do not count as slow driving.
8. `TripSnapshot` is the full dashboard state: current and next state, miles driven and left in the state, exits left, crossing time in the local time zone of the border, itinerary, upcoming exits, ETA, states ahead.

## 3.4 Tradeoffs considered

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Map and routing | Apple MapKit | Google Maps SDK + Routes + Places | Google content cannot appear on a non Google map, cannot feed point in polygon, cannot be spoken; costs $10 to $40 per 1,000 calls. MapKit is free and native. Tradeoff: no step durations, no tolls amounts, no fuel prices |
| Storable geometry | Later: self hosted Valhalla on OSM | Cache Apple routes | Apple allows only temporary caching. Valhalla adds a server, but geometry, exits and boundaries then share one open data lineage |
| State boundaries | TIGER/Line, topology preserving 3 m simplification | Cartographic boundary files | Cartographic files clip water, so bridges over bays fall outside every state. Measured: 3 m simplification changes per state route miles by at most 0.002 mi |
| Time zones | NTAD polygons plus state DST rule | timezone boundary builder project (ODbL) | Public domain and small. Limitation: Navajo Nation DST inside Arizona |
| Exit data | Bundled OpenInterstate | iExit API, live Overpass | Free, offline, nationwide, ODbL. Tradeoff: few exit names, interstates only, manual releases |
| Exit direction | Geometry plus carriageway bearing | Source corridor labels, exit number arithmetic | Measured corridor labels are noisy; exit numbers repeat and reset at state lines |
| Dataset format | Custom little endian binary | JSON, SQLite | 17 MB total, loads in 0.36 s (release build, x86), no extra dependency, testable on Linux |
| Concurrency | Engine is value types, `Sendable`; UI on main actor | Actors everywhere | Engine work per fix is about 35 µs; plan building is moved off the main thread |

## 3.5 Battery strategy

* `CLLocationUpdate.liveUpdates(.automotiveNavigation)`: the system pauses radios when stationary and resumes on movement.
* `CLBackgroundActivitySession` (and `CLServiceSession` on iOS 18) for background use with When In Use authorization. No Always permission needed.
* Engine work per fix measured at about 35 µs in a release build; the UI updates at most once per fix.
* Network only for route requests, reroutes and one ETA calibration every 10 minutes.
* Planned: a reduced accuracy mode for discovery when speed is steady on a long corridor, and Live Activity updates throttled to meaningful changes (exit passed, mile change in state remaining).

## 3.6 Cost strategy

* v0.1 API spend: $0. MapKit routing and ETA, bundled datasets, no backend.
* Phase 3 backend (alerts, AFDC refresh): one small server or serverless functions; feeds are free but need caching because 511 APIs allow about 10 calls per minute.
* Paid only when justified: fuel price license (iExit or OPIS quote), hours and ratings (Foursquare, per call).

## 3.7 Offline design

| Works offline | Needs network |
|---|---|
| Exit lists, services, detour estimates, state segmentation, exit counts, time zones, discovery mode, GPS tracking, dead reckoning, ETAs from the last profile | New routes and reroutes (MapKit), live ETA calibration, place search, fuel prices, hotel rates, traffic and weather alerts |

The UI labels network dependent features. A trip planned while online keeps working through dead zones because its plan is in memory. Phase 4 adds storable OSM route geometry so a trip can survive an app restart offline and reroute offline.
