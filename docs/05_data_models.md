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

## 5.6 Driver profile

One JSON format for the website (`localStorage` key `ea.profile`), the iOS app (`Application Support/Profile/profile.json`) and exported profile files. Rules: `web/js/engine/profile.js` and `Sources/ExitAtlasCore/Profile/ProfileRules.swift`, tested on the same fixtures in `Tests/ExitAtlasCoreTests/Fixtures/profiles`.

| Field | Contents |
|---|---|
| `kind`, `schema`, `updatedAt` | `"exitatlas-profile"`, schema 2 (version one was the older separate keys), last write |
| `vehicles`, `defaultVehicleId` | Up to 10 vehicles: `{id, year, make, model, version, epaId, fuel (R, M, P, D, E), city, highway, combined, tankGallons, tankSource (verified, entered), evRangeMiles, evRangeHighwayMiles, mpgBasis (highway, combined, custom), customMpg, customRangeMiles}`. The id is `year|make|model|version` lowercased with other characters as dashes, the same on both platforms |
| `fuel` | `brands` (priority order, up to 20; `["Shell"]` for a new profile, never restored once changed), `grade` (null follows the vehicle), `reserveMiles`, `maxDetourMinutes`, `require24Hours` and `requireRestroom` (overnight, always, off), `priceOverBrand`, `chargerNetwork` (Tesla, all) |
| `overnight` | `mode` (auto, on, off), `start` and `end` as local `"HH:MM"` at the stop (default 00:00 to 04:00; the window may cross midnight) |
| `places` | `home`, `saved` (up to 50), `recent` (up to 10): `{name, lat, lon, id?}`; `plans` (up to 20): `{name, from (null is the current location), stops, to}`. The iOS app keeps saved trips in `Trips/saved.json` and writes them into exports as `plans` |
| `favorites` | `hotels`, `restaurants`: brand names |
| `driving` | `speedAlertOver`, `exitLookaheadMiles`, `gasGapMiles`, `favoriteCategories`, `avoidTolls`, `keepAwake`, `liveActivity`, `theme` (auto, light, dark) |
| `voice` | `enabled`, `stateLines`, `exits`, `fuel`, `restAreas`, `gasGaps`, `timeZones` |

Every field is checked on its own: a missing or invalid value takes its default and is listed as a problem, unknown keys are kept, and a stored profile that reads cleanly is never rewritten at launch. Before an invalid profile is rewritten, the stored text is kept (`ea.profile.corrupt`, `profile.corrupt-<time>.json`); an unreadable profile falls back to the copy before the last change (`ea.profile.previous`, `profile.previous.json`). API keys are never in the profile: Keychain on iOS, separate browser keys on the web. Exports add `exportedAt`.

## 5.7 SmartStop

| Type | Fields | Notes |
|---|---|---|
| Candidate | id (OSM place or rest area id), name, brand, kind (station, plaza, rest), exit, along and ahead (m), arrival (time), time zone, detour (measured minutes or none), range on arrival, price, OSM facts, Google periods and restroom, plaza hours, toilets and truck spaces | Built from the trip by `web/js/app/smartstops.js` and `SmartStopCandidates.swift` |
| Evaluation | local weekday and minute, overnight, hours {status, source, checked, closesIn, holidays}, restroom status, facilities [{name, status, label, source, checked, closesIn}] | Statuses only (docs/12, 12.7) |
| Result | primary and up to two alternatives {candidate, evaluation, reasons, nextOption}, considered, passed {reason: count}, relaxed, lowRange, favorite {reason}, notice | Same on both platforms (shared fixtures) |

## 5.8 Bundled file formats

All little endian. Common header: 4 byte magic, `u32` version, `u32` metadata length, JSON metadata (source, license, attribution, build time). Coordinates are `i32` degrees × 1e7.

| File | Magic | Body |
|---|---|---|
| `states.eab`, `timezones.eab` | EAB1 | regions: code, name, extra, bbox, polygons, rings, points |
| `restareas.json` | JSON | `{meta: {kind: "restareas", source, tags_fetched, fhwa_source, license, attribution, count, generated_at}, items: [{id (OSM), lat, lon, kind (rest, welcome, plaza, parking), name, nameSource?, road, bearing? (carriageway served; absent in the median or on an undivided road), amenities? ({toilets, water, picnic, vending, pets, wifi, dump, shower, accessible, trucks, info}: true or false, only when tagged), hours?, truckSpaces?, checked?, fhwa? {id, truckSpaces}, gas?, food?, ev? (names within 300 m of a plaza)}]}` |
| `manifest.json` | JSON | `{kind: "manifest", schema, version (YYYYMMDDHHMM UTC, never decreases), content (SHA-256 of the sorted "name sha256" lines), generated_at, files: {name: {bytes, sha256, required, role, kind?, source?, license?, attribution?, generated_at?, osm_extract_date?, tags_fetched?, fetched?, data_last_edit?, count?}}}`. Clients load files by hash and fall back to the last set that loaded (docs/11) |
| `stations.json` | JSON | `{meta: {kind: "stations", source, license, attribution, tags_fetched, data_last_edit, count, with_hours, with_toilets, rebranded, gone, unreadable, generated_at}, items: {"node/123": {h? (opening_hours as written), hc? (check date), t? (toilets true or false), b? (current brand when changed), gone? ("deleted" or "not fuel")}}}`. Only stations with at least one fact; tags are as of `tags_fetched` |
| `discover.json` | JSON | `{meta: {kind: "discover", version, source, license, attribution, fetched, count, min_score, generated_at}, items: [{id (Wikidata Q id), name, cat (nationalPark, nationalMonument, statePark, waterfall, cave, viewpoint, museum, zoo, amusementPark, historicSite, landmark), lat, lon, sitelinks, score (0 to 100), road (nearest interstate), offMeters (straight line to it), desc?, wiki? (English Wikipedia URL)}]}` |
| `interstates.eax` | EAX1 | string table; exits (40 bytes: node id, lat, lon, 2 bearings × 10, label, name, highways, link start, link count); places (24 bytes); links (12 bytes: place index, straight m, drive m, drive s, rank, flags) |
| `corridors.eac` | EAC1 | string table; corridors: highway, direction code, display name, distance, duration, parts of points |

Rebuild: `tools/data-pipeline/build_all.sh` (pinned source checksums).
