# 7. Development roadmap

Phases follow the original priorities. Each item lists its status as of this pull request.

## Phase 1: Route planner, GPS tracking, exits, state mileage dashboard

| Item | Status |
|---|---|
| Engine: geometry, state segmentation, exit matching, tracking, ledger, ETAs, time zones | Done, 44 tests |
| Data pipeline and bundled offline datasets | Done |
| Planner with stops and alternatives (MapKit) | Done, compiled in CI, device testing pending |
| Drive, Exits, Trip, Settings screens | Done, compiled in CI, screenshots from CI |
| Discovery mode | Done |
| Reroute and ETA calibration | Done, device testing pending |
| Simulated demo trip | Done |
| Real drive validation (Florida to New York or a shorter interstate trip) | Next. Needs you on the road with the app installed |
| Web version for phones (`web/`): engine ported to JavaScript, live GPS in Safari, OSRM routing, Nominatim search, offline data cache | Done, 51 tests (the engine against the same fixtures, plus planners, data clients, voice and design tokens); browser flows tested with emulated GPS; real phone drive pending |
| Persist the active trip across app termination | Done: waypoints, ledger and pace saved every 30 s; Resume recomputes the route from the current location (needs network); device testing pending |

## Phase 2: Services and route based search

| Item | Status |
|---|---|
| Gas, food, lodging, rest areas, EV, dog parks per exit (OSM) | Done |
| Multi criteria search at one exit, brand search, drive time windows | Done |
| Detours from routed drive distance | Done where the reachability release has data |
| More categories: convenience, truck stops, grocery, pharmacy, attractions, hospitals | Next: own OSM extract (Geofabrik, osmium) or Overture Places, same pipeline |
| Exit names and destinations | Next: `destination` tags from OSM ramps; contribute upstream to OpenInterstate |
| EV stations with connectors (AFDC) | Next |
| Hours and ratings on tap (Foursquare Premium fields) | Later, paid per call |

## Phase 3: Stop planning, alerts, preferences

| Item | Status |
|---|---|
| Stop suggestions by drive time | Done |
| Add a suggested stop to the active trip with reroute | Next |
| Small backend: NWS alerts by county codes along the route, WZDx work zones, 511 events, AFDC refresh | Next |
| Alert relevance: only alerts intersecting the route ahead in the next few hours | Next |
| Fuel prices | Web: live per station prices from Google Places with the driver's own key (optional). App release: still needs a license decision (Google Places terms and cost, or iExit/OPIS quotes) |
| EV charging stops (Tesla Superchargers or all DC fast, DOE AFDC) | Done in the web version |
| Home and recent places; favorite gas brands drive the fuel stop | Done in the web version |
| Toll cost estimates | Later (TollGuru or HERE) |
| Vehicle picker: EPA MPG for every make since 2000, verified tank sizes for common models, manual entry for the rest | Done in the web version; iOS port next |
| Fuel stop planner from the dashboard's miles to empty: last gas exit reached with the chosen buffer, earlier options, last gas before empty, voice | Done in the web version (tests on real route data); iOS port next |

## Phase 4: Offline depth, background, CarPlay

| Item | Status |
|---|---|
| Background tracking (When In Use + background activity session) | Done, device testing pending |
| Live Activity and Dynamic Island, also shown in CarPlay Dashboard on iOS 26 | Next, high value, no entitlement needed |
| Self hosted Valhalla routing on OSM for storable geometry and offline reroute | Later |
| Apply for CarPlay Driving Task entitlement | After Live Activity ships; approval not guaranteed |
| CarPlay templates (Ahead, Exits, Stops) | After approval |

## Phase 5: Hardening and release

| Item | Status |
|---|---|
| Real drive test matrix (document 8) | Pending |
| Battery measurement over 4+ hours | Pending (Instruments Energy Log on device) |
| Accessibility pass (Dynamic Type, VoiceOver labels) | Partial |
| Legal review: Apple derived data question, ODbL publication, trademarks | Pending |
| App Store review notes explaining background location | Pending |
