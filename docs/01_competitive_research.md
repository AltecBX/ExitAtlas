# 1. Competitive research

App Store figures are from Apple's iTunes Lookup API and the US App Store pages, read 2026-10-27. Complaints come from the public App Store review feeds (for example [iExit reviews](https://itunes.apple.com/us/rss/customerreviews/page=1/id=401746066/sortby=mostrecent/json)). Reddit could not be reached from the research environment, so no forum claims are used.

## 1.1 Summary

* No app found shows state aware trip progress: per state route miles, miles left in the current state, exits left before the state line, ETA to each border, or a state itinerary with entry and exit times. Searches for "state line", "miles to state line", "state border" and "entering state" on the App Store returned no such app.
* iExit is the category leader (4.80 stars, 37,659 ratings) with gas prices per exit, hotel rates, EV chargers and CarPlay. It has no state features, no documented offline mode and recurring complaints about stale prices and exit data.
* Pit Stop (released 2026-08-01) is the closest new rival: offline exits, CarPlay, a Dynamic Island strip and spoken state line heads ups. It has no gas prices, no hotel rates and no route entry.
* Pike already uses OpenInterstate, the same open exit data ExitAtlas uses. Open exit data makes a basic exit list easy to build, so the differentiation has to come from the route aware state engine, planning and trust.

## 1.2 Exit guide apps

| Feature | iExit | NEXIT | Pit Stop | Pike | NEXT EXIT (Car Jimmy) | ExitAtlas v0.1 |
|---|---|---|---|---|---|---|
| Upcoming exits in order | Yes | Yes | Yes | Yes | Yes (static table) | Yes |
| Services per exit | Yes | Yes | Yes | Yes | Yes | Yes (OSM data) |
| Miles left in current state | No | No | No | No | No | Yes |
| Exits left before state line | No | No | No | No | Partial (state lines marked in a table) | Yes |
| Per state route mileage | No | No | No | No | No | Yes |
| ETA to each state line, local time | No | No | No | No | No | Yes |
| State line voice alert | No | No | Yes | No | No | Yes |
| Gas prices | Yes | UNVERIFIED | No | No | No | No (no licensed source yet) |
| Hotel rates | Yes | Partial (deals) | No | No | No | No |
| Multi criteria search at one exit | UNVERIFIED | Partial | No | No | No | Yes |
| Stop planning by drive time | No | UNVERIFIED | Partial | No | No | Yes |
| Detour estimate | Partial (distance and side) | UNVERIFIED | Partial (distance off ramp) | Yes (round trip time) | No | Yes (routed where available) |
| Offline exit data | UNVERIFIED | UNVERIFIED | Yes | UNVERIFIED | Partial | Yes (bundled nationwide) |
| CarPlay | Yes (fueling) | No | Yes | No | No | Planned (entitlement needed) |
| Price | Free, $1.99 ad removal | Free | $2.99 | Free, Plus $4.99 | $1.49/mo or $24.99 lifetime | n/a |
| Rating (count) | 4.80 (37,659) | 4.48 (187) | 4.08 (13) | 5.0 (5) | 4.33 (12) | n/a |

Sources: [iExit](https://apps.apple.com/us/app/iexit-interstate-exit-guide/id401746066), [NEXIT](https://apps.apple.com/us/app/nexit/id1466222160), [Pit Stop](https://apps.apple.com/us/app/pit-stop-road-trip-exit-guide/id6795296025), [Pike](https://apps.apple.com/us/app/pike-next-exit-guide/id6759123383), [NEXT EXIT](https://apps.apple.com/us/app/next-exit/id939674590).

### iExit (Metrocket, LLC)
* Version 12.2 released 2026-10-20. Detects the interstate and direction automatically and lists exits ahead with gas, food and lodging.
* Gas: cheapest price per exit for four grades, shown in Best, Good, Average and Worst bands with a date only freshness label. The price source is UNVERIFIED (a 2019 article said OPIS, a 2025 TV segment said crowdsourced).
* Hotels: rates through Priceline Partner Network (version notes 11.0 and 11.2). EV chargers since 11.6 (2024-11-24).
* CarPlay: version 12.0.0 (April 2025) notes say "We have only been approved for a CarPlay fueling app"; 12.1.0 added food, rest areas and hotels.
* Recurring complaints: wrong gas prices with no way to correct them (2024-07-21, 2025-11-23, 2025-12-27), stale places and exit numbers including Massachusetts renumbering (2025-01-06, 2025-03-26, 2025-09-25), CarPlay freezes (2026-03-06, 2026-08-04). A 2026-10-20 review asks for "best priced stations in the next 100 miles".
* iExit also sells a developer API to licensed partners (see document 2).

### NEXIT (Interstate Data USA)
* Version 3.6.2 (2026-05-02). AI route planning, search with multiple parameters, "Travmatch" for several stop types along a route, deals. No CarPlay. Complaints: no CarPlay, "error loading businesses", outdated places.

### Pit Stop (Jacob Boyles)
* Released 2026-08-01, version 1.4 on 2026-10-10. Whole database bundled (20,000+ exits, 700,000+ places, from OpenStreetMap). CarPlay app, lock screen strip and Dynamic Island, spoken heads ups for last gas, state lines and time zone changes. No miles or exits left in a state, no border ETA, no prices, no route entry. ([site](https://www.pit-stop-app.com/))

### Pike (Thomas Johnell)
* Released 2026-02-19. Built on OpenInterstate, shows round trip detour time per stop, brand logos, no CarPlay. ([site](https://thepike.app))

### Others checked
* RoadSnap by the Next EXIT: gas prices "avg. and user reported", hotel booking.
* USA Rest Stops: 3.28 stars, complaints about ads and forced login. Rest Stops Plus: last updated 2022-09-01.
* County Names & Lines: distance to the next county line (Pro), the closest analog to a state line countdown, but for counties.
* Toll Calculator GPS Navigation: per state miles for IFTA tax filing, not live trip progress.
* "Exit Now", "Highway Exit Guide" and "ExitHero" do not exist as road apps.

## 1.3 Broader navigation and trip apps

| App | Relevant strengths | Gaps for this use case |
|---|---|---|
| Google Maps | Add stop with gas prices and detour times in CarPlay ([help](https://support.google.com/maps/answer/9432062)), offline areas | No exit list, no state progress |
| Apple Maps | Offline maps with directions (iOS 17), multi stop (iOS 16), search along route | No US gas prices found, no exit list |
| Waze | User reported gas prices ("may not always reflect the current price", [help](https://support.google.com/waze/answer/13739802)) | One stop per route, no offline |
| GasBuddy | Crowdsourced prices; web Trip Cost Calculator uses tank size and MPG | No CarPlay; no redistribution allowed (see document 2) |
| Roadtrippers | Daily drive limits, gas cost estimate, CarPlay | Paywalled ($35.99 to $59.99 per year), no exits |
| Trucker Path | Driver rest hour planning, fuel optimized plans | Truck focused, upsells |
| Furkot (web) | Overnight stops by daily drive time, fuel stops by range | No iOS app, no prices |
| PlugShare, ABRP | EV charging along route | EV only |

## 1.4 Gaps and how ExitAtlas addresses them

| Gap | Evidence | ExitAtlas response |
|---|---|---|
| State aware progress | No app found (section 1.1) | Core feature, implemented and tested (document 8) |
| Price × detour × range in the car | iExit ranks by exit only; Google shows price and detour separately; GasBuddy has no CarPlay | Fuel planner implemented in the engine; waits on a licensed price source |
| Multi criteria at one exit | iExit and Pit Stop search one term | Implemented (AND across requirements, one exit) |
| Drive time stop planning inside an exit guide | Only trip planners do it | Implemented ("hotel about 3 hours ahead") |
| Offline + CarPlay + Live Activity + prices together | Nobody combines them | Offline done; Live Activity and CarPlay planned |
| Data trust | Stale price and exit complaints across apps | Every price must show source and time; data build date shown; offline vs live labeled |

Interpretation: the route aware state engine is the clearest differentiator and is not easy to copy, because it needs exact geometry against state polygons, directional exit matching and reroute safe accounting. A plain exit list is not defensible, since open data now exists.
