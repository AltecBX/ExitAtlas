# 8. Testing and accuracy

Principle: no state sequences or mileage values are hardcoded in the app. Tests compare the engine with independent oracles computed from different code and, where possible, different data.

## 8.1 Fixtures

Real driving routes from the OSRM demo server on OpenStreetMap data (ODbL), fetched 2026-10-27, stored in `Tests/ExitAtlasCoreTests/Fixtures`:

| Fixture | Miles | Why it is useful |
|---|---|---|
| Miami to Manhattan | 1,280.7 | Ten states; Florida Turnpike to I-95; I-395 through Washington, DC; Baltimore Harbor Tunnel; Delaware Memorial Bridge; NJ Turnpike; Lincoln Tunnel |
| Atlanta to Nashville | 248.7 | Reenters Georgia on I-24 (GA, TN, GA, TN) and changes from Eastern to Central time inside Tennessee |
| Richmond to NYC via NJ Turnpike | 333.0 | Reroute base |
| Richmond to NYC via Pennsylvania | 346.6 | Alternative that adds Pennsylvania, for the reroute test |

`tools/data-pipeline/make_route_fixture.py` also writes the oracle expectations next to each route.

## 8.2 Oracles

1. State segments: shapely and pyproj (Karney geodesics) on the full resolution TIGER/Line 2026 polygons. The engine uses its own Vincenty code on the 3 m simplified bundled polygons.
2. Exits on the route: OSM node membership. The route's node list contains an exit node exactly when the route drives through that diverge point. The engine never sees node ids and works from geometry.

## 8.3 Results (this pull request)

State mileage, engine compared with the oracle, tolerance 0.05 mi per segment, all within tolerance:

| Route | Oracle state sequence and miles |
|---|---|
| Miami to Manhattan | FL 374.35, GA 111.81, SC 198.70, NC 181.37, VA 184.84, DC 7.92, MD 86.61, DE 16.27, NJ 116.92, NY 1.96 |
| Atlanta to Nashville | GA 108.21, TN 15.95, GA 3.89, TN 120.62 |
| Richmond to NYC, Turnpike | VA 105.46, DC 7.92, MD 86.61, DE 16.27, NJ 114.76, NY 1.94 |
| Richmond to NYC, via PA | VA 105.46, DC 7.92, MD 86.61, DE 23.78, PA 52.39, NJ 68.47, NY 1.94 |

External check (automated, `testMatchesPublishedI95StateLengths`): the Miami route follows I-95 across the full width of Georgia, South Carolina and North Carolina. The published I-95 lengths are GA 111.80, SC 198.76 and NC 181.36 mi ([Wikipedia route table](https://en.wikipedia.org/wiki/Interstate_95), checked 2026-10-27). The engine gives 111.81, 198.70 and 181.37 mi.

Boundary simplification: on the Miami route, per state miles at 3 m simplification differ from full resolution by at most 0.002 mi, and at 10 m by at most 0.005 mi.

Exit matching on the four routes:
* No exit on the route was missed, except where the exit node itself moved between the two OSM snapshots. The test checks that explicitly: a miss is excused only when the node's position differs by more than 5 m between snapshots. One case: node 859234545 (Exit 77A-B, I-95 Maryland) moved 47 m.
* Every extra match lies within 1 m of the route geometry (nodes present in OpenInterstate's July 2026 snapshot but not in the OSRM server's snapshot).
* Driving the Miami route geometry in reverse matched zero of the forward direction exits with verified bearing, which confirms direction filtering.
* With the looser limits for Apple or Google route geometry (15 m), six exits on parallel roadways (collector lanes at I-16, Baltimore express lanes, ramps) also matched. That is the main open accuracy risk for MapKit routes (8.5).

Bundled data validation: 330 of 334 exits on the Miami route have a carriageway bearing within 30° of the route bearing; 4 have no bearing in the source; 0 disagree.

Tracking (simulated GPS with 6 m noise at 1 Hz along Atlanta to Nashville): no false off route; 99th percentile along route error under 30 m; worst under 60 m. A 2.4 km dropout is dead reckoned to within 150 m after 60 s and reacquired within 40 m. A lateral departure is flagged off route within 20 s. Acquisition in the middle of a route lands within 30 m. On an out and back road with passes 15 m apart, tracking never jumps to the wrong pass.

Regression found and fixed while testing: a loop ramp in downtown Richmond made all loop segments look like one pass, so the tracker jumped 330 m ahead and back, and the ledger counted 300 m twice. Fixes: one projection per local minimum, and the ledger credits only distance beyond the furthest point already credited. Tests: `testLoopYieldsOneProjectionPerPass`, `RerouteTests`.

Reroute: driving the Turnpike route into Maryland, then switching to the Pennsylvania route, gives ledger totals per state equal to the Pennsylvania route's oracle lengths within 120 m, with Maryland as one continuous stint.

Time zones: Atlanta to Nashville starts in America/New_York, ends in America/Chicago, and the zone change falls inside the last Tennessee segment.

Performance (release build, x86 Linux): loading all datasets 0.36 s; building the Miami plan 0.014 s; about 35 µs per GPS fix including the snapshot.

Web version (`web/tests`, `npm test`, CI job "Web engine tests"): the JavaScript port passes the same checks against the same oracles and tolerances (state segments on four routes, published I-95 lengths, exits by node membership, reversed route, snapshot values, time zones, tracking, reroute ledger, discovery). On the demo route it produces the same state miles as the Swift engine and 338 exits. Browser flows were run in headless Chromium at iPhone size with emulated GPS: live place search and OSRM routing, 45 on route fixes tracked to the meter, an automatic reroute after leaving the route, resume after reload with miles kept, and discovery locking onto I-95 Northbound on the third fix. Not yet tested: Safari on a real iPhone while driving.

## 8.4 Coverage of the requested checks

| Requested check | How it is covered | Status |
|---|---|---|
| Correct ordering of states | Oracle sequence, four routes | Automated |
| Accurate mileage per state segment | Oracle, 0.05 mi tolerance | Automated |
| Correct highway direction | Parity rule test ("I-95 N"); reversed route exit test | Automated |
| Upcoming exit ordering | Order equals node order on route | Automated |
| Exit counts before each border | Snapshot count versus node membership count with the same signage rule | Automated |
| Behavior at state boundaries | Segment boundaries contiguous; snapshot switches at crossing | Automated |
| Recomputation after reroute | Ledger test | Automated |
| Lost GPS | Dropout and signal lost tests | Automated |
| No internet | All bundled data, no network calls in the engine | By design; device test pending |
| Gas price freshness and missing data | Fuel planner test with stale and missing prices | Automated |
| Time zones | Atlanta to Nashville | Automated |
| Battery | Instruments on device | Pending |
| UI | iOS build and screenshot UI test in CI | Automated (renders, no assertions on values yet) |

## 8.5 Open risks

1. MapKit route geometry versus OSM exit nodes: the 15 m limit for third party geometry is an estimate that could not be measured here. Plan: log offsets of matched exits on real drives, tighten or adapt per corridor, and move to OSM based routing (Valhalla) where possible.
2. Web version ETAs (OSRM): OSRM's car profile models roads at speed limit times 0.8, so a driver at the limit or above is faster than the model. The web pace model predicts the next 30 modeled minutes at the recent pace (5 minute moving time memory) and blends into the trip pace (15 minute prior centered on the driver's pace from earlier trips) with a 1 hour time constant. Test: driving 1.5 times the model speed, the next state line ETA after 20 minutes is within 3% (`web/tests/engine.test.js`). To port to the Swift engine.
3. ETAs on MapKit routes use only total travel time per leg, spread by distance, then corrected by learned pace and a live ETA every 10 minutes. City segments at either end make early state entry times less accurate. Measure on real drives.
4. Coverage: OpenInterstate covers signed interstates only. Turnpikes and US routes without an interstate designation (for example Florida's Turnpike) show no exits.
5. Exit names are missing for most exits in the source.
6. If iOS terminates the app, the trip resumes from saved waypoints and driven miles, but recomputing the route needs a network connection. Offline resume needs storable OSM route geometry (Phase 4).
