# 4. Feature specification

Status key: **Built** (in the app, engine tested, device untested), **Engine** (implemented and tested in ExitAtlasCore, no or partial UI), **Planned**, **Blocked** (needs a license, entitlement or source).

## 4.1 Core navigation

| ID | Feature | Status | Acceptance criteria |
|---|---|---|---|
| N1 | Origin, destination, stops; current location as origin | Built | Search by address or place (MapKit autocomplete); stops can be added, removed, reordered |
| N2 | Full route and every state on it | Built | State order matches the oracle on real fixtures (document 8) |
| N3 | Current highway and direction | Built | Interstates signed by national parity rule and 25 km displacement ("I-95 N") |
| N4 | Current and next state | Built | Changes exactly at boundary crossings |
| N5 | Total, remaining distance, ETA | Built | Distances from route geometry; ETA from provider profile × learned pace |
| N6 | Distance to next exit and to next state line | Built | Along route, never straight line |
| N7 | Exits before the state line | Built | Count of matched exits between position and border, by position, never by exit numbers |
| N8 | Remaining distance in current state; distance in each upcoming state; time until entering each | Built | Upcoming entries show local time at the border with zone abbreviation |
| N9 | States remaining | Built | Distinct states ahead and state line crossings ahead |
| N10 | Live updates while driving | Built | Each fix updates the snapshot; dead reckoning every 5 s without fixes |
| N11 | Discovery mode without destination | Built | Locks on after 3 consistent fixes at 13+ mph; releases after 5 misses; shows corridor ahead up to 400 mi |

## 4.2 State by state tracker

| ID | Feature | Status | Acceptance criteria |
|---|---|---|---|
| S1 | Route miles in current state, completed, remaining | Built | Completed comes from the trip ledger (survives reroutes) |
| S2 | Exits remaining before border, ETA to border, next state name and its miles | Built | Brief crossings flagged under 1 mile |
| S3 | Progress bar for current state | Built | Driven ÷ (driven + remaining) |
| S4 | Itinerary: every state, miles, duration, exits, entry and exit times | Built | Completed (ledger) shown separately from upcoming (route) |
| S5 | Border approach notification | Built (voice) | Spoken at 5 mi with exits remaining; banner under 5 mi. Push notification for background: Planned |
| S6 | Transition on crossing | Built | Snapshot switches state at the crossing distance; voice "Welcome to ..." with miles in that state |
| S7 | Brief crossings, re-entries, interstate changes, complex interchanges | Engine tested | Atlanta to Nashville re-enters Georgia; loop ramp regression test; DC segment on Miami route |

## 4.3 Upcoming exits

| ID | Feature | Status | Notes |
|---|---|---|---|
| E1 | Detect highway and direction from GPS | Built | From route steps, or corridor match in discovery |
| E2 | Exits in encounter order | Built | Directional geometric matching |
| E3 | Exit number, name, distance, time | Built | Names exist for few exits in source data (see document 2) |
| E4 | Gas, food, lodging, rest areas, EV, dog parks | Built | OpenStreetMap via OpenInterstate |
| E5 | Convenience, truck stops, grocery, pharmacy, attractions | Planned | Not in OpenInterstate categories; add from an OSM extract or Overture Places |
| E6 | Fuel prices, hotel rates | Blocked | Licensed source required |
| E7 | Logos | Blocked | Trademark permission; text brand names used |
| E8 | Window 5, 10, 25, 50, 100 mi | Built | Segmented control |
| E9 | Auto advance after passing | Built | List is relative to live position |
| E10 | Services reachable from the driver's side and ramp | Partial | Routed exit to place drive distance from OSRM is used where present; true side of road access needs ramp level routing (Planned with Valhalla) |

## 4.4 Smart gas finder

| ID | Feature | Status |
|---|---|---|
| G1 | Fuel type, brands, MPG, tank, remaining fuel | Built (settings and fuel sheet) |
| G2 | Reachable stations with detour | Built |
| G3 | Cheapest verified ahead, cheapest within distance, lowest cost including detour, savings | Engine (tested with synthetic observations); Blocked in UI until a licensed price source exists |
| G4 | Timestamp of every price, never "live" | Engine enforces source and time on every observation; prices older than 48 h are excluded |

## 4.5 Restaurants, hotels, rest stops

| ID | Feature | Status |
|---|---|---|
| R1 | Find a brand ahead ("next Cracker Barrel", "Starbucks within 30 miles") | Built |
| R2 | Hotel about N hours ahead | Built (Plan a Stop and search by drive time) |
| R3 | Next rest area | Built (category filter). "With bathrooms" needs amenity data: Planned |
| R4 | Multiple requirements at one exit | Built |
| R5 | Hours, ratings, pet policy, parking, accessibility | Blocked (needs Foursquare, Google or hotel partner data) |
| R6 | Real driving detours | Partial: routed exit to place distance doubled; full detour with re-entry planned via Valhalla |

## 4.6 Smart stop planning

| ID | Feature | Status |
|---|---|---|
| P1 | Saved trips with stops | Built (waypoints saved; route recomputed on start) |
| P2 | Suggestions by drive time, category, brand | Built |
| P3 | Fuel range, meal, pet, amenity aware suggestions | Engine partial; pet and amenity data Blocked |
| P4 | Add, remove, rearrange stops with full recalculation | Built in planner; adding a suggested stop mid trip: Planned |
| P5 | Recalculate state miles, exit counts, ETA on route change | Built (new TripPlan; ledger keeps history) |

## 4.7 Alerts

| ID | Feature | Status |
|---|---|---|
| A1 | Weather (NWS), flooding, winter | Planned, Phase 3 (backend) |
| A2 | Work zones (WZDx), closures, incidents (511) | Planned, Phase 3 |
| A3 | Tolls | Built as "Tolls" badge per route; amounts Planned |
| A4 | Relevance filter | Planned: only alerts intersecting the route ahead within the next N hours |

## 4.8 Dashboard

Built: Drive, Exits, Trip Overview, Settings; light and dark; large rounded numerals; status pill (on route, estimating, off route, signal lost, simulation). See document 6.

## 4.9 CarPlay

Planned, Phase 4, entitlement not guaranteed. Details in document 6.

## 4.10 Offline

Built: all bundled data and engine features. Planned: persist active trip across app termination, storable OSM route geometry, offline reroute.

## 4.11 Additional features (evaluated)

| Feature | Decision | Reason |
|---|---|---|
| Voice for exits and state lines | Built | Hands free state line awareness is the core value |
| Favorite brands | Built (fuel); extend to food | Cheap, improves suggestions |
| Saved trips, history, lifetime miles and states | Built | From the ledger |
| Total fuel cost estimate | Planned | Needs price source; can use regional averages labeled as estimates (EIA weekly averages are public) |
| Toll cost | Planned | TollGuru or HERE cost per trip; only "Tolls" badge now |
| Alternative routes | Built | Up to 3 from MapKit with per state breakdown |
| Roadside assistance and emergency locations | Planned | Low cost: hospitals from OSM; 911 is always the first action |
| EV range and compatible chargers | Planned | AFDC connectors plus range model like FuelPlanner |
| Pet friendly filter | Built for dog parks; hotel pet policy Blocked | Needs hotel data |
| Share itinerary | Built | Text share sheet |
| Custom alerts before an exit or rest area | Planned | Uses the same announcement engine |
| Live Activity and lock screen | Planned, high priority | Shows in CarPlay on iOS 26 without the CarPlay entitlement |
