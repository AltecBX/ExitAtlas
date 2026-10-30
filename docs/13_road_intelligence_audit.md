# 13. Road Intelligence and reliability: audit, sources and plan (2026-10-28)

Starting point: `main` at f4aa220. This document answers the "Next generation road intelligence and reliability" request before the rest of it is built: what exists, what is missing, which sources are legal to use, what they cost, and the order of pull requests. Facts carry a source; UNVERIFIED marks what could not be confirmed from a primary source; Interpretation marks a reading, not a fact, and none of it is legal advice. Research notes with every link: `docs/research/2026-10-28_*` and the provider pages cited below (read 2026-10-28).

## 13.1 Police source verdict

**There is no verified, authorized live source of police presence that ExitAtlas can use today, so the app shows none.** Settings says so in plain words ("No authorized live source exists for ExitAtlas, so nothing is shown").

* Waze for Cities is open only to "a government agency or a private road operator", its current alert spec has no POLICE type (the word does not appear), and its terms forbid passing Waze data "into third-party products or services" or using it "for any commercial purpose" ([eligibility](https://support.google.com/waze/partners/answer/10453062), [alert types](https://support.google.com/waze/partners/answer/13458165), [terms 2.2(b)(iv)](https://docs.google.com/document/d/11aCI-PTxJJS6YxDNiiylr9GT9FgGmwwNB23Ii_CiVZU/edit)). The Waze app terms forbid automated access and building databases from it ([terms](https://support.google.com/waze/answer/12373727)). Not usable, and never scraped.
* State 511 feeds, Maryland CHART and PennDOT list "police activity" as the cause of a road incident on scene, not police presence or enforcement. If such records are added later they are labeled by road impact ("Lanes blocked, police activity"), never as a police alert.
* HERE and TomTom incident APIs have no police category ([HERE](https://docs.here.com/traffic-api/docs/incidents-here-traffic-api-v7-concepts.md), [TomTom](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/traffic-incidents/incident-details)). HERE sells fixed and mobile camera locations under a contract (price UNVERIFIED).
* Google's Navigation SDK shows Google's own police reports inside Google's navigation screen; ExitAtlas never receives them. An optional Google navigation mode is prototyped on a branch (docs/14).
* What exists legitimately: fixed camera locations (OpenStreetMap, ODbL, 1,468 US nodes and very incomplete; Washington DC, CC BY 4.0), official work zone camera programs (PA, MD, NY, public pages without a feed), and reports from ExitAtlas's own drivers (13.5).

## 13.2 Code audit by feature

"Reused" names the code the feature builds on. "Tests" lists the automated tests that exist after this PR.

| Feature | Exists | Missing | Reused | Built in this PR | Sources and cost | Tests |
|---|---|---|---|---|---|---|
| Alert schema and route matching | Nothing before this PR | | `PlannedRoute.projections`, `highwayAt`, `parseHighways`, signed offsets, corridor data | `RoadIntel` (Swift) and `roadintel.js`: one schema, matching by geometry, road and direction, dedupe, expiry at arrival time, per group status | n/a | 9 matching cases and 10 scenarios on the real I-95 route, shared by both engines (opposite carriageway, parallel road, unnamed point beside the road, behind you, duplicates, expiry, failure is never all clear) |
| Weather alerts | Nothing before this PR | Zone polygons for alerts without one | `RoadAlerts` fetch plan | NWS point queries every 25 mi over the next 150 mi, plus one query for storm warning polygons (snow squall, tornado, severe thunderstorm, flash flood) in the states ahead, every 10 min or 20 mi (not while backing off after a failure) | NWS, open data, free, CORS `*` ([terms](https://www.weather.gov/documentation/services-web-api)) | Real captured NWS response; live check in the browser |
| Work zones and closures | Nothing before this PR | Key feeds (VA, NC, OH, PA Turnpike and others); 511 incidents | Same | WZDx feeds for 12 states (13.3), Worker passthrough for browsers, stale feed check, NJDOT text parser | WZDx, CC0, free | Real captured MD, DE and NJ feeds against the real route; live MD and DE in the browser |
| Crashes, hazards, disabled vehicles, delays | Group and status exist | Every source: all need registration or permission (13.3) | | Status says "No source connected" | PennDOT first (redistribution allowed) | Status tests |
| Police reports | Group and status exist | A legal source (13.1); community reports (13.5) | | Nothing is shown | none | Status tests |
| Speed cameras | Group exists | OSM and DC camera layer | OSM pipeline | | OSM ODbL, DDOT CC BY 4.0, free | |
| Drive screen and Road Ahead | Adaptive focus card, Then strip, Road Ahead timeline | | `DashboardFocus`, `dashboard.js` | Alert focus (serious within 50 mi, others within 10 mi), alert row, status details; work zones with travel lanes open stay in Road Ahead only | | Dashboard focus fixtures with alert cases |
| Voice | Exits, fuel, gaps, state lines | | `VoiceAnnouncements`, `announcer.js` | Serious alerts from 10 mi, others from 2 mi, once each; drivers' reports say "not confirmed" | | Voice tests in both engines |
| Stop hours and restrooms | OSM hours (11.7% of 19,679 stations), Google hours on lists with a key, Stop Confidence labels, overnight rules | All the Places hours and restroom listings, convenience store join, closure flags, freshness dates | `SmartStop`, `OpeningHours` | Google hours and restroom details are never spoken (Google terms 3.2.3(a)(iv)) | ATP CC0; Overture CDLA; FSQ OS Apache 2.0; all free | Spoken answer tests |
| Rest area status | Bundled rest areas, no live status | 511 status (GA, NC, AZ, NV, ID) | Rest area dataset | | Key plus written permission | |
| True highway detours | One way OSRM drive doubled (`ExitServices.swift` line 36); now labeled as that estimate ("About 3 min detour (twice the drive from the exit)") | Exit to business to the correct entrance; return leg; added time | OpenInterstate reachability | | Valhalla (MIT) per state in CI; MKDirections on demand on iOS | Existing detour tests |
| Fuel cost comparison | `FuelPlanner` (Swift) with savings against the nearest priced station; web shows prices | Web port of the planner; detour fuel; reserve; per grade comparison in the UI | `FuelPlanner`, `fuel.js`, prices | | Google prices through the key proxy or the driver's key | FuelPlanner tests |
| One tap restroom stop | `bestStopAhead(restrooms:)`, Siri "restroom" answer, SmartStop primary plus two alternatives | A single control on the Drive screen | SmartStop | | | SmartStop tests |
| Route comparison | Up to 3 OSRM alternatives (web) and MapKit routes (iOS) with distance and time | Fuel cost, tolls, alerts, overnight gas, restrooms, gaps, Shell count per route | Planner | | Tolls need HERE (13.6) | |
| TripReady offline | Service worker caches the app and bundled data; trip state survives reloads | A compact readiness line; what is cached for this trip | `sw.js`, data manifest | | Routing needs the network (OSRM and MapKit); no offline routing is promised | Offline cache test |
| Diagnostics | Nothing | Local log, review, redact, export | | | none | |
| Profile safety | Versioned profile, migrations, import and export | | `ProfileRules`, `profile.js` | New `alerts` section, merged without touching other settings | | Profile fixtures (full, damaged, web v1, iOS v1) |

## 13.3 Source verification table

Confirmed means: read on the provider's own page today, license allows this use, and live data was fetched without a key. Potential means: it exists, but needs a key, a contract or written permission first.

| Source | Status | Access and license | Coverage and refresh | Cost | Attribution | Limits and reliability |
|---|---|---|---|---|---|---|
| NWS alerts (`api.weather.gov`) | **Confirmed, integrated** | No key; "open data, free to use for any purpose"; User-Agent required | US; alerts change by the minute; polled every 10 min or 20 mi | Free | Source shown on every alert | Zone alerts have no polygon: placed at the query points and marked approximate; a point the driver passed stands for the road up to 12.5 mi past it (half the spacing), so an alert where the driver is stays "here" |
| WZDx: DE, IN, LA, MS, ND, WA | **Confirmed, integrated** (browser direct) | No key; `feed_info.license` CC0; CORS `*` | Statewide; feeds update every 1 to 15 min; polled every 10 min (30 min for IN, over 1 MB) | Free | Agency name shown | DE lists `vehicle_impact` "unknown" on every event |
| WZDx: KY, MD, MN, MO, NJ, WI | **Confirmed, integrated** (iOS direct; web through the key proxy) | No key; CC0; no CORS | As above (30 min for MO and WI) | Free; Worker passthrough is not parsed (no CPU cost) | Agency name shown | NJ: road names hold cross streets and `vehicle_impact` is always `all-lanes-open`, so the road, direction, start time and lanes are read from the text; NJ covers NJDOT roads, not the Turnpike or Parkway |
| WZDx: IA, ID, New England | Potential | No key, but no license in `feed_info` | | Free | | Ask the publishers to state CC0 |
| WZDx: FL, OK | Potential | The registry URL embeds a key | | Free | | Ask whether the key is meant for public use |
| WZDx: UT, NY, NM, KS | Not usable today | UT not updated since 2023; NY returns an HTML page; NM 503; KS timed out | | | | Recheck |
| WZDx: VA, NC, OH, PA Turnpike, MA, IL, MI, TX, OR, CO | Potential | Key per publisher | | Free | | Keys only in the Worker |
| PennDOT RCRS (511PA) | Potential, first in line | Request form; "Developers may redistribute"; "PennDOT" credit; disclaimer with commercial use; must replicate to own servers | PA; real time | Free | Required | Needs the Worker and D1 |
| IBI 511 platform (GA, NC, CT, WI, AZ, NV, UT, ID, LA, AK) | Potential | Key; terms behind login; CT forbids redistribution without written consent | One state each; 10 calls per 60 s | Free | UNVERIFIED | Drop any record sourced from Waze |
| Maryland CHART | Potential | Public JSON, no license ("All rights reserved"), no CORS | MD | Free | | Ask MDOT SHA in writing |
| 511NY / TRANSCOM, VDOT SmarterRoads, FL511, OHGO, Mass511, 511NJ | Potential | Agreement or key; terms unreadable or silent on redistribution | Per state | Free (UNVERIFIED) | | Written permission first |
| 511SC | Not available | No developer program found | | | | Ask SCDOT |
| OSM speed cameras | Confirmed, not built | ODbL | 1,468 US nodes; MD 220, DC 149, NY 118 | Free | "© OpenStreetMap contributors" | Label "may be incomplete" |
| DDOT automated cameras | Confirmed, not built | CC BY 4.0 | DC only; daily | Free | DDOT | |
| HERE Traffic, TomTom Incidents | Potential | Contract (HERE Base Plan excludes driver hazard alerts); TomTom terms behind a login | Global | TomTom 2,500 free a month; HERE $2.92 per 1,000 | | No police data in either |
| All the Places (stops) | Confirmed, not built | CC0 | Hours for 8,062 of 19,679 stations (41%, from 11.7%); restroom listed at 3,282 | Free | "All the Places" | Brand listing, not a visit: "Reported open" only |
| Overture places, FSQ OS Places | Confirmed, not built | CDLA Permissive 2.0, Apache 2.0 | Closure flags only, no hours | Free | Required | |
| Google Places | Integrated (driver key or proxy) | Proprietary | Live | $35 per 1,000 after 1,000 free (Enterprise) | Google | Never stored, never spoken, never beside the Apple map |
| Foursquare Places API | Potential | Pay as you go: **no caching** except IDs ([usage guidelines](https://docs.foursquare.com/fsq-developers-places/reference/usage-guidelines)) | | $18.75 per 1,000 (Premium) | "Powered by Foursquare" | docs/02 corrected |
| Station fuel outages | Not available | GasBuddy terms forbid databases and forwarding without written consent | | | | No licensed source exists |
| Gas station restroom hours | Not available | No source publishes them | | | | A station restroom is never shown as open at arrival |

## 13.4 Road Intelligence rules as built

* **One schema** for every provider: id, kind, description, source, verification (official, community, mapped), reported, updated, starts, ends, expires, geometry (point, line, polygon, sample points), road, direction, lanes, severity.
* **Matching** never trusts distance alone. A point must sit within 200 m of the route on the same road and in the same direction (40 m when no road is named). With no direction, a point more than 15 m left of the route line is on the other carriageway. A line must run along the route within 120 m in the travel direction (bearing within 60 degrees when no direction is given). An event names a road by any of its highway names (I-95 where it runs on the New Jersey Turnpike), and a street or county road named beside the highway is never the highway.
* **Status** per Settings group, never collapsed into "all clear": Alerts on your route, No relevant reports, Checking, Data unavailable (any source failed or is stale), No source connected, Coverage not supported on this route, Reports expired, Off in Settings. A coverage note lists the states ahead without a feed.
* **Time:** an event that ends before you arrive is left out, and so is one that starts after you have passed; scheduled work shows "starts 8:00 PM"; a feed whose publisher has not updated it for a day is unavailable.
* **Attention:** closures and major crashes, weather, flooding or hazards are serious (Drive screen from 50 mi, voice from 10 mi). Other alerts take the Drive screen within 10 mi and voice at 2 mi. Work zones that leave the travel lanes open stay in Road Ahead.
* **Battery and data:** nothing is fetched without an active trip or with a group switched off; only states within 150 mi ahead are read; backoff after errors.

## 13.5 Community reporting assessment

Not built. A decision for the owner, after counsel review, before any code.

* **What would be allowed.** Apple Maps itself takes "Speed Check" reports ([Apple](https://support.apple.com/en-us/105024)). App Store Guideline 1.4.4 allows DUI checkpoints only when "published by law enforcement agencies"; 1.1.1 was the basis for removing apps that track specific officers (secondary reports, UNVERIFIED). Hawaii SB 2839 (2026) would have banned police location alerts; the tracker marks it failed (UNVERIFIED). Interpretation: generic "Speed check ahead" and road hazard reports are tolerated today; anything naming an agency, an officer, a vehicle or a person is not, and laws can change.
* **Design if approved.** Report types: hazard, crash, disabled vehicle, speed check. No DUI checkpoints, no agency or officer details, no photos, no free text. Snap to the route segment and direction, store a coarse position (about 100 m), expire speed checks after 30 min and hazards after 60 min, show "Reported by drivers, not confirmed" with the age, confirm or clear buttons, dedupe within 800 m, a per state switch, a global off switch in the Worker config.
* **Abuse and privacy.** Rate limit per device (a random install ID, hashed, never an account), cap reports per hour, require a second driver's confirmation before a report is spoken, keep no location history, delete raw reports after expiry, publish a moderation and takedown address.
* **Backend and cost.** Cloudflare Worker plus D1: $5 a month on Workers Paid covers 1,000 daily drivers when writes are change only and queries use an indexed tile column; rewriting every row on every poll would cost about $646 a month (research notes, Cloudflare pricing read 2026-10-28).
* **The real risk is too few reports.** A report layer is useful only where several drivers pass within its 30 minute life. Until ExitAtlas has that density on a corridor, empty report layers would read as "no police", which the status rules forbid. Plan: ship reports for hazards first (they help even when rare), show the speed check layer only on corridors with enough confirmed reports in the past week, and say "Few reports on this road" otherwise.

## 13.6 Costs

| Item | Personal use | 1,000 daily drivers |
|---|---|---|
| NWS, WZDx, OSM, ATP, Overture | $0 | $0 |
| Key proxy Worker (prices, chargers, work zone passthrough) | $0 on Workers Free | $5 a month on Workers Paid |
| D1 for 511 feeds and reports (when built) | $0 to $5 | $5 a month with change only writes |
| Google prices and hours (lists) | 1,000 free calls a month, then $35 per 1,000 | Owner's budget caps in the Worker |
| Toll costs for route comparison | HERE about $0.0067 per route after 2,500 free a month | Same; TollGuru about $0.08 per route; Google excluded (not allowed next to the Apple map) |

## 13.7 What was tested, and how

* **Real data, recorded:** NWS response captured 2026-10-28; MD and DE WZDx feeds whole and nine NJDOT features, captured 2026-10-28 23:53 UTC; matched on the real Miami to Manhattan route. Hand checked: two MD shoulder closures on I-95 northbound and one on I-895 northbound match; I-287 work at the Turnpike interchange is rejected as another road; NJ 495 westbound is rejected as the other direction; NJ times convert across the end of daylight saving time.
* **Live, in a browser:** NWS on the demo route (a real Coastal Flood Warning was returned earlier today); at mile 1000 of the demo, Delaware's feed read directly and Maryland's through the Worker handler run locally, showing four live MD work zones ahead with the right status and coverage note. Not tested live on a phone or in a moving car.
* **Simulated, labeled as such:** police reports, crashes, debris and the alert card screenshots ("SIMULATED TEST ALERT"). No real time claim rests on them.
* **Mutation checks:** reading NJ road names instead of the text, matching streets to the highway, and counting closed shoulders as closed lanes each make a test fail.
* Counts: Swift 113 tests, web 98, Worker 8, all passing.

## 13.8 Stop data: brand listings and freshness (milestone 4)

* **Data.** `build_stations.py` matches the 15 largest fuel brand spiders of All the Places (CC0, run 2026-10-17) to the bundled stations: same brand (either name a prefix of the other), nearest within 150 m. Hours come only from fuel or travel stop features, never from a store's hours; a restroom counts when the brand lists one at the station or its store. Result: listed hours for 7,898 of 19,679 stations (40.1%, from 2,295 or 11.7%), restroom listings for 3,268 (from 106 OpenStreetMap tags). The OpenStreetMap facts are unchanged.
* **Rules (both engines, shared fixtures).** One source: that source. Both list the pumps and agree at the arrival time: the more recently dated (the listing, unless a mapper checked the hours after it was collected). They disagree: "Hours unavailable", with the note "OpenStreetMap and the Shell listing disagree"; never open, never closed. Restroom: Google, then OpenStreetMap, then the brand listing; OpenStreetMap "no" against a brand "yes" is unknown. A brand restroom is "listed, access hours unknown", never open at arrival. A check or collection date more than a year before arrival adds "may be out of date".
* **Labels.** "Reported open, verification limited (listed by Shell, 2026-10)"; the facility row says "Listed by Shell, collected 2026-10-17". Never "Verified": a listing is what the brand says, not a visit.
* **Effect on picks (real Miami to Manhattan route, recorded in both engines).** More stations are listed open, and overnight more list a restroom. Shell's own listings name a restroom for only 17% of its US stations (BP 86%, Chevron 95%), so overnight, when a restroom is required, a BP or Chevron that lists one can outrank a Shell that does not say; the reason line says why. One example: at mile 400 overnight the pick moved from a Shell (restroom unknown) to a BP listing a restroom. The overnight "last stop listed open" warning at mile 400 is gone: the 53 mile stretch with no stop listed open there is now covered by brand listings. On this route no single mile has such a stretch at every hour now, so the screenshot test picks its mile by the time in New York (mile 1035 by day, 599 at night; both engines check the windows).
* **Bug fixed on the way.** A station linked to two exits was offered twice (250 of 1,584 candidates on the real route, 16%); it is now one stop at the exit with the shorter detour.
* **Not in this step.** Store hours from brand listings, the OpenStreetMap convenience store join, Overture and Foursquare closure flags, missing spiders (Exxon, Mobil, Phillips 66, Citgo, 7-Eleven) and Pilot Flying J and Buc-ee's, whose spiders returned nothing in this run.

## 13.9 Current weather (owner request)

* **What.** The weather where you are, in the top bar of the Drive screen while a trip runs; tap for feels like, wind, humidity, the next 4 hours and the source. Web: it takes the place of the "Drive" title (next to a highway name in discovery mode it shows the symbol and temperature only), and the condition is dropped when it does not fit beside the status pill. iOS: the middle of the top bar, symbol and temperature, SF Symbols in multicolor.
* **Source.** National Weather Service only: `/points` (rounded to 2 decimals, about 1 km) for the forecast grid, place name, time zone and station list; the latest observation of the nearest stations within 50 km, nearest first, stopping at the first that reported in the last 90 minutes with a temperature; the hourly forecast. Public domain, no key, CORS open, so no backend.
* **Rules (both engines, shared fixtures).** An observation older than 90 minutes, or more than 10 minutes in the future, is never "now". Without one, this hour of the hourly forecast is shown, labeled "Forecast". Nothing current: nothing is shown, never an old value. Answers fetched more than 25 miles back are not shown. Feels like comes from the heat index or wind chill, shown only when it differs.
* **Polling.** Only while a trip runs: every 10 minutes, or after 10 miles but not more than every 2 minutes (a simulated drive runs at 30 times speed), the point record again after 5 miles, backoff 1 to 30 minutes after failures. A failure keeps the last answers, which still age out under the 90 minute rule.
* **Tested.** Real responses for Jacksonville, FL captured 2026-10-29 (`Tests/ExitAtlasCoreTests/Fixtures/weather`): the stale KNIP reading is skipped for KCRG, 72°F, feels like 73, cloudy, night, NE 11 mph, 88%; KNIP alone gives the 71°F forecast. The web app was also run on the live service on the demo route (light and dark). iOS screenshots come from CI and are skipped, not failed, when the service does not answer from the runner.

## 13.10 Pull request plan

| PR | Milestone | Content | State |
|---|---|---|---|
| 13 | 1 to 3 | This audit; alert engine; NWS; WZDx; Google voice fix; profile alert settings | Merged |
| next | 3 | PennDOT RCRS through the Worker and D1, after registration; OSM and DC fixed cameras ("Enforcement cameras", may be incomplete) | Needs the PennDOT credential and the Worker deployed |
| 14 | 4 | Stop data: brand listing hours and restrooms, freshness labels, one stop per station (13.8) | This PR |
| next | 4 | Convenience store join, Overture and FSQ closure flags, more brand spiders | Pipeline work |
| 14 | 5 | Relabel today's detours as estimates (twice the drive from the exit) | This PR |
| 14 | | Current weather on the Drive screen (13.9) | This PR |
| next | 5 | True detours: Valhalla round trip per state in CI; MKDirections on demand for the picks on iOS | |
| next | 6 | One tap restroom stop (1 pick plus 2 alternatives, overnight rules); fuel cost comparison (web port of FuelPlanner, detour fuel, reserve) | |
| next | 7 | TripReady line; route comparison (fuel, alerts, overnight gas, restrooms, gaps, Shell count; tolls only as "tolls on route" until HERE is approved) | |
| next | 8 | Local diagnostics: on device log, review, redact, export, never uploaded without permission; recorded issues become fixtures | |
| later | | Community reports, only after 13.5 is decided | Owner and counsel |

## 13.11 Decisions for the owner

1. Deploy the key proxy Worker (free plan is enough for the work zone passthrough) so the website covers MD, NJ, KY, MN, MO and WI.
2. Register for PennDOT RCRS and, if wanted, the IBI 511 keys; record each written permission in this repository before shipping.
3. Community reporting: yes or no, after counsel review (13.5).
4. Toll costs: approve HERE (about $0.0067 per route) or keep "tolls on route" only.
