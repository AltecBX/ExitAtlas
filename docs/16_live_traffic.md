# 16. Live traffic: audit, provider verification and plan (2026-10-29)

Starting point: `main` at 7fa9987 and the open pull requests #25 (iOS map first Drive, `claude/premium-ios`) and #15 (Google Navigation experiment, draft). The Live Traffic concept render named in the request is not in the repository or this session; it was requested from the owner. The design previews in this work are labeled as previews and are not app screenshots.

## 16.1 Audit: where traffic touches ExitAtlas today

| Area | iOS | Web | Traffic today |
|---|---|---|---|
| Map | `NavigationMapView.swift` (PR #25): Apple's map, `showsTraffic: false` | MapLibre on OpenFreeMap tiles (Drive), SVG state map (Trip) | None. Apple's traffic layer was turned off on purpose to keep the map muted. |
| Routing | `MapKitRouteService`: one `MKDirections` request per leg with `departureDate` now; leg time spread along the leg by distance (`timeProfile`) | OSRM demo server: free flow road speeds | Apple documents `MKRoute.expectedTravelTime` as the time "under ideal conditions", so route times carry no traffic. OSRM has none. |
| Arrival times | `TripPlan.eta` / `TripSnapshot`: modeled time times the pace model (`PaceModel`: recent 5 min pace for the next 30 min, blending into the trip pace) | `trip.js` snapshot, same model | Pace only. The recent pace already reflects slowdowns being driven through now. |
| Road Intelligence | `RoadIntel.swift`: kind `congestion` ("Major delay") in the Incidents group; no provider produces it | `roadintel.js`, same | No source. |
| Voice | `VoiceAnnouncements` road alerts | `announcer.js` | None for traffic. |
| Google experiment | PR #15: Google's own map with Google's traffic layer on | n/a | Google's traffic, shown only on Google's map, never extracted. Left as is. |

## 16.2 Providers: what the primary sources say

Checked 2026-10-29. "Verified here" means the clause was read in the provider's own text in this session (Apple documentation JSON; TomTom's terms text from the script its legal page loads; HERE's terms and Base Plan pages). Prices were read from the providers' pages by a research pass and are medium confidence.

### Apple MapKit (iOS)

- Traffic layer: `MapStyle.standard(..., showsTraffic:)`, "whether the map displays traffic". Apple does not say live or real time. Apple lists Maps traffic for the United States ([feature availability](https://www.apple.com/ios/feature-availability/#maps-traffic)).
- Route time: `MKRoute.expectedTravelTime` "reflects the time it takes to traverse the route under ideal conditions" (verified here, [doc](https://developer.apple.com/documentation/mapkit/mkroute/expectedtraveltime)).
- ETA: `MKDirections.ETAResponse.expectedTravelTime` "reflects the time it takes to traverse the route, taking expected traffic into account" (verified here, [doc](https://developer.apple.com/documentation/mapkit/mkdirections/etaresponse/expectedtraveltime)). Whether "expected" means live or typical traffic is not stated. The response also gives `distance` (verified here), which lets ExitAtlas check that Apple timed the same road it is driving.
- No raw speeds, slowdown locations or incidents: `MKRoute` exposes the polyline, steps, name, highways, tolls, advisory notices, distance and time only ([doc](https://developer.apple.com/documentation/mapkit/mkroute)).
- No waypoints in `MKDirections.Request` (source and destination only), and no traffic times for alternative routes (alternatives carry the ideal conditions time).
- Limits: "Apps may receive an error if the device makes too many requests in too short a time period" ([doc](https://developer.apple.com/documentation/mapkit/mkdirections)). No number is published. No charge.
- License: the Developer Program License Agreement counts traffic data as Map Data and forbids extracting or reusing it. Map Data must be "displayed only on an Apple map provided through the Apple Maps Service" ([DPLA](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/), Attachment 6). Using it in the iOS app next to Apple's own map is the intended use. It cannot feed the website's MapLibre map.

### TomTom Traffic API

- Products: vector and raster flow tiles, incident tiles, Incident Details (with `delayInSeconds`), Flow Segment Data (v1: `currentSpeed`, `freeFlowSpeed`, `currentTravelTime`) ([docs](https://docs.tomtom.com/traffic-api/documentation/tomtom-orbis-maps/v2/product-information/introduction)). United States covered for flow and incidents.
- Prices ([pricing](https://docs.tomtom.com/pricing), medium confidence): tiles 200K free a month, then €0.10 per 1,000; Flow Segment Data 20K free, then €1.00 per 1,000; Incident Details 2.5K free, then €2.00 per 1,000. The free allowance is pooled per account; requests are blocked when it runs out.
- License, verified here in the [terms](https://docs.tomtom.com/legal/terms-and-conditions):
  - §2.2: the royalty free license is "for Evaluation Use only".
  - §2.1: the paid license covers a "Permitted Solution", "excluding any Automotive Usage or Navigation Functionality except as specifically permitted to you by TomTom under a separate written agreement".
  - Navigation Functionality means "the real-time provision of directions (whether visual or verbal) that guide a user through each turn in a route ... based on the user's current location". The ExitAtlas Drive screen does exactly that (`guidance.js`, the maneuver banner).
  - Automotive Usage includes any "Screen Replication Technology", which covers CarPlay.
  - §11.4 allows caching only in clients, within the cache headers, and never "for the purpose of scaling results to serve multiple clients or users". A shared server cache of tiles is excluded.
  - No clause found that requires a TomTom base map.
- Conclusion: not usable in ExitAtlas without a written agreement from TomTom.

### HERE Traffic API v7

- Flow (`freeFlow`, `speed`, `jamFactor`, `confidence`) and incidents (`criticality`, `roadClosed`, no delay field), plus traffic tiles ([docs](https://docs.here.com/traffic-api/docs/flow)).
- Prices (medium confidence): traffic 5,000 free a month, then $2.92 per 1,000; tiles 30,000 free, then $0.12 per 1,000.
- License, verified here in the [HERE Platform terms](https://legal.here.com/en-gb/terms/here-platform-terms):
  - Allowed: §6.4a lets you "layer Your Content and third-party content with HERE Content or Results for display purposes" with attribution.
  - Open data: §6.4b bars exposing HERE materials to open database licenses that would cause their disclosure or redistribution. The base map is OpenStreetMap data under ODbL, so this needs a lawyer.
  - Vehicles: §6.3 bars integration into vehicle systems. A phone projecting its screen is not one.
  - Base Plan: the [Base Plan restrictions](https://www.here.com/get-started/pricing/base-plan-restrictions) exclude "Asset Management". That means locating, tracking or displaying on a map, or calculating routes, for an Asset, and an Asset includes "a person (including the user of your application)". ExitAtlas does all of these for its user.
- Conclusion: not usable on the self serve plan. A different HERE plan would have to be negotiated.

### Others

- Google Maps Platform: "Customer will not use the Google Maps Core Services with or near a non-Google Map" ([terms](https://cloud.google.com/maps-platform/terms)). Google traffic stays inside the Google map in the PR #15 experiment.
- Azure Maps: content may not be combined with maps from another platform. Turn by turn navigation is excluded.
- Mapbox: traffic data is "for its internal evaluation purposes" unless there is an order.
- MapKit JS: no traffic property, and Apple Map Data only on an Apple map.
- State 511 and DOT feeds: not researched in this pass. Some publish incidents, and a few publish speeds, each under its own terms. This is the most promising legal path for slowdown locations on the website (16.6).

## 16.3 Recommendation

- **iOS: Apple Maps traffic.** It is licensed for this use, costs nothing and needs no key. It gives:
  1. The traffic layer on the Navigation View, with a Traffic button and a Settings switch.
  2. Traffic aware times from `calculateETA` to checkpoints on the current leg (the next state line, the next planned stop or the destination). A checkpoint time is used only when Apple's `distance` matches the route's own distance to that point, so a time for a different road is never used.
  3. The extra time Apple estimates to the next checkpoint. This is the ETA time minus Apple's ideal conditions time for the same two points, both checked against the route. It is shown only when it is at least 3 minutes.

  Apple gives no slowdown locations, so iOS shows no "Slow traffic ahead, 8 mi" alerts, speaks no traffic and offers no faster routes. Saying otherwise would mean inventing delays.
- **Website: no traffic provider.** Every checked provider either requires its own map or excludes navigation apps on the terms available without a contract. The website stays fully functional without traffic. Every arrival time says it is pace based, and Settings says why. The engine is ready for a provider: it takes a reading or slowdown sections from any source. Enabling one needs written permission from the provider first: TomTom for Navigation Functionality, or a HERE plan without the Asset Management exclusion.
- **Google experiment:** unchanged. Google's traffic layer stays on Google's map, and nothing is extracted.

## 16.4 Engine (shared rules, both platforms)

`web/js/engine/traffic.js` and `Sources/ExitAtlasCore/Trip/Traffic.swift`, tested on `Tests/ExitAtlasCoreTests/Fixtures/traffic/cases.json` (simulated readings, marked as such).

- **Reading.** A reading is `{routeId, measuredAt, fromAlong, checkpoints: [{along, seconds}], source}`. It holds only times a provider computed along this route; a whole route total is never spread over the stops.
- **When a reading is used.** It must be for the same route, not stale (15 min), not behind the driver (300 m GPS tolerance) and not passed. Otherwise the arrival times fall back to pace.
- **No double counting.** Inside the reading, provider times are interpolated by the route's modeled time between checkpoints. Beyond the last checkpoint, the pace part starts where the reading ends: pace(model from here to target) − pace(model from here to the last checkpoint). The recent pace, which already reflects the slowdown being driven, is spent on the stretch the provider covers and is not applied twice.
- **Basis.** Every arrival time names its basis:
  - "With traffic"
  - "With traffic, then your pace"
  - "Your pace, no traffic data"
  - "Road speeds, no traffic data"

  Apple does not say its ETA traffic is live, so no label says "live".
- **Stability.** A new reading that moves the farthest common checkpoint by up to 2 min is taken at once. A larger move must be confirmed by a second reading in the same direction within 15 min. Until then the shown reading stays.
- **Slowdowns.** Provider sections (slow, heavy or stopped, with a delay when given) become Road Intelligence incidents:
  - Kind `congestion`, in the new **Traffic slowdowns** group, which has its own Settings switch.
  - Verification `measured`, and a route geometry that matches only the route measured.
  - Shown from the driver's position to the section's end. Sections behind the driver, or adding under a minute, are dropped.
  - Expire after 15 min. Headlines are "Slow traffic ahead", "Heavy traffic ahead" or "Stopped traffic ahead". Police reports stay a separate group.
  - With no traffic provider, the group says "No source connected", never "no traffic".
- **Faster routes.** Both times must come from the same provider measurement, to the same point. An alternative is offered only when all of these hold:
  - It saves at least the driver's minimum (10 min by default; 5, 10, 15 or 20) and at least 5% of the time left.
  - It is no more than 25% longer.
  - It keeps every planned stop, has no known closure, and has no tolls when the driver avoids tolls.
  - The saving is seen twice within 15 min.

  "Not now" holds an alternative back for 30 min unless it saves 10 min more. The offer lists the distance change, tolls, a closure avoided and a preferred stop that is not on the new route. ExitAtlas never reroutes on its own. On iOS this stays unused, because Apple gives no traffic times for alternatives.
- **Snapshot.** `TripPlan.snapshot(..., traffic:)` takes the reading shown. Every arrival comes from it: the destination, planned stops, state lines, SmartStop, fuel stops and the open at arrival checks. The intermediate times come from route matched checkpoints only.
- **Profile.** `alerts.traffic` plus a `traffic` section: `map`, `eta`, `voice`, `suggestRoutes` and `minSavingMinutes`, validated the same way on both platforms. Existing profiles gain the defaults and lose nothing (fixtures updated).

## 16.5 Requests, cost and battery (estimates, labeled as such)

- **iOS (Apple):**
  - Up to 3 `calculateETA` requests per refresh (one per checkpoint), plus one `calculate` request for the ideal conditions time to the nearest checkpoint.
  - A refresh happens about every 5 min while moving, and again on a reroute. None while stopped for 2 min, in the background or with no network. That is about 48 requests per driving hour per phone.
  - When Apple throttles, the next refresh waits twice as long, up to 20 min, and the times fall back to pace with their label.
  - No money cost.
- **Website with TomTom, if a written agreement existed (estimate only):**
  - A phone screen shows about 15 flow tiles. Refreshing every 2 min plus new tiles along an interstate comes to about 500 tiles per driving hour, or about €0.05 per driving hour after the pooled 200K free tiles (about 400 driving hours a month).
  - One Incident Details call per 5 min is 12 calls per hour, or about €0.024 per hour after the free 2.5K.
  - A server proxy for every tile is not justified at these volumes. It would also breach §11.4 if it cached for many users.

## 16.6 What is live and what is experimental

| Capability | Status |
|---|---|
| Web: arrival basis on the Trip tab ("Your pace, no traffic data"), Traffic status in Settings, the Traffic slowdowns group showing "No source connected" | Live on the website |
| Engine: traffic aware arrival times, stability, slowdowns as alerts, faster route rules | Built and tested on simulated fixtures in both engines. No live provider feeds it on the website. |
| iOS: Apple traffic layer, traffic button, Settings switches, Apple checkpoint times, basis and extra time on the journey panel | Built in a stacked PR on #25. Screenshots come from the simulator, which may show no traffic. Not validated on a real drive yet. |
| Slowdown locations, spoken traffic, faster route offers | Not available. No licensed source provides them for ExitAtlas yet. |
| Google traffic layer | Experimental, PR #15 only, unchanged |

## 16.7 Tests

- **Automated, simulated:**
  - Arrival seconds inside, across and beyond checkpoints.
  - When a reading is unusable: other route, stale, behind, passed, empty.
  - The basis labels.
  - The stabilizer: small move, unconfirmed jump, opposite jump, confirmed jump, reading lost.
  - Slowdowns: behind the driver, too short, missing delay, reversed section, unknown level, route geometry, another route.
  - The faster route rules: threshold, share of time left, dropped stop, closure, tolls, distance cap, second check, snooze.
  - The snapshot: traffic then pace with no double counting, a stale reading and another route's reading falling back to pace.
  - Profile fixtures.
- **Real device, before calling the iOS part production ready** (owner, on a drive):
  1. Traffic layer visible and toggled from the button and from Settings. The setting is kept after relaunch.
  2. In slow traffic, the basis reads "With traffic", and the extra time appears only when Apple's estimate exceeds 3 min.
  3. After a reroute, the old reading is dropped at once.
  4. In airplane mode or with no signal, the times fall back to pace and say so, and nothing claims the road is clear.
  5. Parked for 2 min or with the app in the background: no requests (Xcode network report).
  6. A route with a planned stop: the times beyond the stop are labeled "then your pace".
  7. Compare ExitAtlas's arrival time with Apple Maps' at the start and in the middle of a slowdown.

## 16.8 Next

- Research state 511 and DOT feeds for incidents and speeds, starting with the states on the owner's routes, and their terms.
- Ask TomTom in writing whether a turn by turn web app may use flow and incident data over an OpenStreetMap base map, and at what price.
- If either path is licensed, add the provider adapter that produces readings and slowdown sections. The engine, UI, Settings and tests are in place for it.
