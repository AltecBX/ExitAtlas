# 5. Data models

All types live in `Sources/ExitAtlasCore`. Distances are meters, times are seconds or `Date`, coordinates are WGS84 degrees.

## 5.1 Route

| Type | Key fields | Notes |
|---|---|---|
| `GeoCoordinate` | `latitude`, `longitude` | |
| `RoutePolyline` | `points`, `cumulativeDistances`, `length`, segment grid | Vincenty per segment; `projections(of:within:)` returns one candidate per pass (local minima), so loops and out and back legs work |
| `RouteStep` | `startDistance`, `length`, `instruction`, `roadName`, `highways: [HighwayRef]` | Provider maneuvers positioned along the route |
| `HighwayRef` | `kind` (interstate, US, state, named), `prefix`, `number` | Parsed from provider text ("I 95; US 17", "Merge onto I-95 N") |
| `TravelTimeProfile` | `distances`, `seconds` (piecewise linear) | From per segment durations (OSRM), per leg totals (MapKit), or uniform; inverse lookup for "N hours ahead" |
| `RouteStop` | `waypoint`, `distanceAlongRoute`, `plannedDwell` | Dwell adds to every ETA beyond the stop |
| `PlannedRoute` | `source`, `polyline`, `steps`, `timeProfile`, `origin`, `destination`, `stops`, `hasTolls`, `title` | `source` selects exit matching limits |

## 5.2 State and time zone boundaries

| Type | Key fields | Notes |
|---|---|---|
| `Region` | `code` ("FL" or "Eastern"), `name`, `extra` (FIPS or UTC offset), `boundingBox` | |
| `RegionIndex` | regions, polygons with rings, edge grid | Even odd point in polygon; exact segment crossing parameters |
| `RegionSegment` | `index`, `code` (nil outside every region), `startDistance`, `endDistance`, `visit`, `isBrief`, entry and exit coordinates | One continuous stretch in one region |
| `RegionProfile` | `segments`, `routeLength`, `totals` | Totals sum all visits per state in order of first entry |
| `TimeZoneResolver` | NTAD zones plus state rule | Arizona maps to America/Phoenix, Hawaii to Pacific/Honolulu, Aleutians to America/Adak |

## 5.3 Exits and services

| Type | Key fields | Notes |
|---|---|---|
| `ExitRecord` | `osmNodeID`, `coordinate`, `bearings` (0 to 2), `label`, `name`, `highways` (weak hint) | One physical diverge point |
| `Place` | `id` (OSM id), `coordinate`, `name`, `brand`, `category` | Categories: gas, food, lodging, rest area, EV charging, park, dog park |
| `ExitPlaceLink` | `place`, `straightLineMeters`, `driveMeters`, `driveSeconds`, `rank`, `reachable` | Drive values are one way, exit to place, OSRM |
| `RouteExit` | `id` ("osm-node-123"), `ordinal`, `label`, `name`, `distanceAlongRoute`, `offsetFromRoute`, `confidence`, `records` | `confidence` is medium when the source has no bearing for the node |
| `ExitService` | `place`, `detourMeters`, `detourSeconds`, `detourBasis` | Basis: routed one way doubled, or straight line estimate (×1.4, doubled) |

## 5.4 Trip state

| Type | Key fields | Notes |
|---|---|---|
| `LocationSample` | coordinate, horizontal accuracy, course, speed, timestamp | Independent of Core Location |
| `RouteMatch` | `status` (acquiring, on route, off route, signal lost), `distanceAlongRoute`, `offset`, `isEstimated`, `speed` | |
| `TripLedger` | `stints: [DrivenStint]` (state, meters, entered, exited) | Actual driving; survives reroutes |
| `PaceModel` | observed and expected moving seconds | `factor` clamped to 0.6 to 2.0 |
| `TripPlan` | route, `states: RegionProfile`, `exits: [RouteExit]`, time zone per segment | Rebuilt on every route change |
| `SegmentForecast` | segment, status, driven, remaining, exit count, exits remaining, entry and exit time and zone | One itinerary row |
| `TripSnapshot` | progress, remaining, ETA, highway, current, next, itinerary, next exit, upcoming exits, states ahead, driven stints | Everything a screen needs, immutable |
| `TripSession` | plan, tracker, ledger, pace | `ingest`, `replacePlan`, `needsReroute`, `calibrate` |

## 5.5 Planning

| Type | Purpose |
|---|---|
| `ServiceRequirement` | Category, brand or name (punctuation insensitive), max detour |
| `AlongRouteQuery`, `AlongRouteMatch` | Exits in a window where every requirement is met at the same exit |
| `StopQuery`, `StopSuggestion` | Window by distance or by drive time ± tolerance, sorted by closeness to the target time |
| `FuelPriceObservation` | Place, grade, price, observed time, source. Only from a licensed provider or the user |
| `VehicleProfile` | MPG, tank, reserve, grade, preferred brands |
| `FuelOption`, `FuelPlan` | Reachability, fill gallons, detour gallons, effective price per gallon, cheapest, best value, savings |

## 5.6 Bundled file formats

All little endian. Common header: 4 byte magic, `u32` version, `u32` metadata length, JSON metadata (source, license, attribution, build time). Coordinates are `i32` degrees × 1e7.

| File | Magic | Body |
|---|---|---|
| `states.eab`, `timezones.eab` | EAB1 | regions: code, name, extra, bbox, polygons, rings, points |
| `restareas.json` | JSON | `{meta: {kind: "restareas", source, tags_fetched, fhwa_source, license, attribution, count, generated_at}, items: [{id (OSM), lat, lon, kind (rest, welcome, plaza, parking), name, nameSource?, road, bearing? (carriageway served; absent in the median or on an undivided road), amenities? ({toilets, water, picnic, vending, pets, wifi, dump, shower, accessible, trucks, info}: true or false, only when tagged), hours?, truckSpaces?, checked?, fhwa? {id, truckSpaces}, gas?, food?, ev? (names within 300 m of a plaza)}]}` |
| `discover.json` | JSON | `{meta: {kind: "discover", version, source, license, attribution, fetched, count, min_score, generated_at}, items: [{id (Wikidata Q id), name, cat (nationalPark, nationalMonument, statePark, waterfall, cave, viewpoint, museum, zoo, amusementPark, historicSite, landmark), lat, lon, sitelinks, score (0 to 100), road (nearest interstate), offMeters (straight line to it), desc?, wiki? (English Wikipedia URL)}]}` |
| `interstates.eax` | EAX1 | string table; exits (40 bytes: node id, lat, lon, 2 bearings × 10, label, name, highways, link start, link count); places (24 bytes); links (12 bytes: place index, straight m, drive m, drive s, rank, flags) |
| `corridors.eac` | EAC1 | string table; corridors: highway, direction code, display name, distance, duration, parts of points |

Rebuild: `tools/data-pipeline/build_all.sh` (pinned source checksums).
