# 2. Data sources and licensing

Legal readings marked "Interpretation" are not legal advice. Get counsel review before a commercial launch.

## 2.1 What ExitAtlas v0.1 actually uses

| Data | Source | License | Bundled | Verified in this repo |
|---|---|---|---|---|
| State boundaries | Census TIGER/Line 2026 `tl_2026_us_state.zip` ([Census](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html)) | Not copyrighted; credit the Census Bureau | Yes, `states.eab` (2.8 MB) | Yes, oracle tests |
| Time zones | USDOT BTS NTAD Time Zones ([FeatureServer](https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Time_Zones/FeatureServer/0)) | Public domain, US Government work | Yes, `timezones.eab` (0.6 MB) | Yes |
| Exits, places, exit place links | OpenInterstate release-2026-07-13-gha-33 ([site](https://openinterstate.org/), [repo](https://github.com/tldev/openinterstate)) | ODbL 1.0 (OpenStreetMap derived) | Yes, `interstates.eax` (11.7 MB) | Yes |
| Exit to place drive distance and time | OpenInterstate reachability score-20260715-1351876 ([repo](https://github.com/tldev/openinterstate-reachability)) | ODbL 1.0 | Inside `interstates.eax` | Yes |
| Directional interstate corridors | OpenInterstate `reference_routes.csv` | ODbL 1.0 | Yes, `corridors.eac` (2.3 MB) | Yes |
| Map display, routes, ETA, place search | Apple MapKit | Apple Developer Program License Agreement, Attachment 6 | No (live) | Requires device build |

## 2.2 Providers evaluated

### Exits and highway data

| Provider | What it provides | Cost | License and restrictions |
|---|---|---|---|
| iExit Developer API | Ordered exits per highway, state and direction; exit details with adjacent exit; on highway detection from two coordinates; businesses; `fuel_prices` "only for gas stations with GasBuddy or OPIS price data" ([docs](https://developer.iexitapp.com/reference/getting-started)) | Not published; contact api@iexitapp.com | Keys only for "3rd parties who have paid to license the iExit database". Update cadence, rate limits, caching and display terms UNVERIFIED |
| OpenInterstate | CSV tables: directional corridors, ordered exits (`sequence_index`), 133,613 places, 708,711 links, reference routes; separate OSRM reachability release | Free | ODbL 1.0, code MIT. Signed interstates only, no US routes or non interstate turnpikes. Releases are manual (9 between 2026-03-24 and 2026-07-13) |
| OpenStreetMap direct | `highway=motorway_junction` with `ref`, `destination` tags on ramps, rest areas, toll booths | Free | ODbL. Public Overpass: under 10,000 queries/day and 1 GB/day, "commercial use should use self hosted or paid" ([wiki](https://wiki.openstreetmap.org/wiki/Overpass_API)). Geofabrik US extract 11.4 GB, daily |

Measured OpenInterstate quality issues (this repo, see `tools/data-pipeline/build_interstates.py`):
* 95,422 exit rows collapse to 38,553 physical exit nodes. Rows like `node/99207888:4AB` are synthetic aliases of `node/99207888`.
* Corridor assignment is noisy: one node can appear on I-195 and I-395 in four directions. ExitAtlas therefore ignores corridor labels and matches exits by geometry and carriageway bearing.
* `exit_name` is empty on 92,634 of 95,422 rows. Exit numbers are missing on 1,468 nodes.
* One label used a Cyrillic letter ("8А"). Labels are normalized to ASCII.
* 3,258 of 38,553 nodes have no carriageway bearing in the corridor edges; those match only with a tighter distance limit and are flagged in the UI.

### Routing and maps

| Provider | Key facts | Cost |
|---|---|---|
| Apple MapKit `MKDirections` | Source and destination only (stops need chained requests); `polyline`, `steps`, `expectedTravelTime` ("under ideal conditions"), `hasTolls`; no per step duration; `calculateETA`; throttling with `loadingThrottled`, limits undocumented ([forum](https://developer.apple.com/forums/thread/786947)) | No published per request fee |
| Apple Maps Server API, MapKit JS | Server directions include per step `durationSeconds`; 25,000 service calls per day per team | Free within quota |
| Google Routes API | Polyline, legs, steps (static duration only), tolls via `extraComputations: TOLLS`, up to 3 routes | Essentials $5 per 1,000 (10,000 free/mo), Pro $10 (traffic aware, 5,000 free), Enterprise $15 (tolls, 1,000 free) ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)) |
| Google Places Search Along Route | Text Search with route polyline; `routingSummaries` detour legs; max 60 results | Enterprise + Atmosphere $40 per 1,000 (1,000 free) |
| Mapbox Directions | `driving-traffic`, per leg incidents, BETA `exclude=state_border` | 100,000 free/mo then $2 per 1,000 |
| HERE Routing v8 | `spans=stateCode` gives native per state spans | 30,000 free/mo then $0.88 per 1,000 (non time aware) |
| Self hosted Valhalla on OSM | `admin_crossings` with shape indices; MIT license; data ODbL | Server cost only |

### Fuel, EV, hotels, restaurants

| Provider | Key facts | Usable now? |
|---|---|---|
| OPIS retail | About 90% of US stations daily; OPISNAVX for navigation companies via API or bulk ([OPIS](https://www.opis.com/product/pricing/retail-fuel-prices/)) | Needs a contract; price UNVERIFIED |
| GasBuddy | No public API. Terms (effective 2026-04-24) forbid scraping, building databases and forwarding data without consent ([terms](https://www.gasbuddy.com/disclaimer)) | No |
| Google Places `fuelOptions` | Price per grade with `updateTime`; Enterprise + Atmosphere ($25 per 1,000 details) | Only on a Google map (see 2.3) |
| NREL/DOE AFDC (moved to developer.nlr.gov) | All public EV stations, connectors, networks, no live availability; 1,000 requests/hour; "may be used for any purpose" | Yes, planned for Phase 2 |
| Open Charge Map | CC BY 4.0 plus per provider licenses; key required | Yes, with attribution |
| Expedia Rapid, Booking Demand | Partner approval, case by case | After approval |
| Amadeus Self Service | Decommissioned (secondary sources give 2026-07-17) | No |
| LiteAPI | Self serve sandbox; margin model | Candidate |
| Yelp Places | $229 to $643 per month; 24 hour cache; heavy display rules | Costly |
| Foursquare Places | Hours and ratings are Premium fields, $18.75 per 1,000; 30 day cache | Candidate for hours and ratings |
| Overture Places, Foursquare OS Places | Permissive licenses, no hours, no ratings | POI enrichment only |
| Brand logos | No source licenses the trademarks (logo.dev, Brandfetch terms); App Review 5.2.1 | Text brand names until owners grant permission |

### Alerts

| Source | Key facts | Plan |
|---|---|---|
| NWS `api.weather.gov` | Public domain, no key, User Agent required. Query by area or county codes; zone codes alone miss county based polygon warnings ([guide](https://www.weather.gov/media/documentation/docs/NWS_Geolocation.pdf)) | Phase 3, via a small backend |
| FHWA WZDx work zones | Registry on data.transportation.gov; feeds for FL, NC, VA, MD, DE, NJ, NY, PA Turnpike; none for GA and SC; spec license CC0 | Phase 3 |
| State 511 APIs | Keys, about 10 calls per minute, redistribution terms mostly unclear; PennDOT allows commercial use with credit | Phase 3, backend cache, written permission first |
| TomTom, HERE incidents | TomTom 2,500 free/month; terms on non vendor maps UNVERIFIED | Later |
| Waze for Cities | Government agencies and road operators only | No |
| Tolls | MapKit gives only `hasTolls`; Google tolls are Enterprise SKU; TollGuru from $80/month | Show "tolls on route" now |

## 2.3 Combinations that are not allowed

| Combination | Why |
|---|---|
| Google Routes or Places content on an Apple map, or "with or near" one | Google Maps Platform Terms 3.2.3(e) and Service Specific Terms 14.2 and 19.2 ([terms](https://cloud.google.com/maps-platform/terms), [service terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)) |
| Point in polygon (state lookup) on Google Places coordinates | Terms 3.2.3(c)(iv), listed explicitly |
| Text to speech of Google driving times or place data | Terms 3.2.3(a)(iv) and (c)(vi) |
| Apple map data on a non Apple map, or stored in a derived database | DPLA Attachment 6, sections 2.4 and 2.2; caching only "temporary and limited" (2.5) |
| GasBuddy prices anywhere | GasBuddy terms |
| Merging proprietary POIs with OSM POIs and distributing the result | Likely triggers ODbL share alike on the proprietary data (OSMF Collective Database guideline). Keep each data type all OSM or all non OSM per region |
| HERE results merged into an ODbL database | HERE platform terms 6.4(b) |
| Public OSRM or FOSSGIS demo servers in production | 1 request per second, non commercial |

Allowed (Interpretation): OSM derived exits and places drawn as our own overlay on an Apple map, with OSM credit visible. No clause in DPLA Attachment 6 forbids third party overlays.

## 2.4 Obligations ExitAtlas must meet

* ODbL: credit OpenStreetMap where OSM derived data is shown (done: Exits list, exit detail map, Data Sources screen). Because the app conveys a derivative database (`interstates.eax`, `corridors.eac`), offer it under ODbL and publish the method (`tools/data-pipeline`). The GitHub repository is public (checked 2026-10-27), which meets this offer while it stays public.
* Census: credit the U.S. Census Bureau as the boundary source (done).
* Apple: route geometry is kept in memory for the active trip only. Saved trips store waypoints, not geometry. Open question for counsel: whether per state mileage derived from an Apple route counts as a "derived database" under section 2.2. Interpretation: computing and displaying it transiently is ordinary use; storing it is the risk. Trip history stores the user's own driven miles from the GPS ledger.
* Prices: show source and observation time with every price; never label a price live; drop prices older than 48 hours from "cheapest" (implemented in `FuelPlanner`).

## 2.5 Recommendation

1. Now (personal use and beta): Apple MapKit for map, routes and ETA; bundled OpenInterstate, TIGER and NTAD data offline. Zero API spend.
2. Before App Store release: self hosted Valhalla on an OSM extract for storable route geometry and offline rerouting, with MapKit still drawing the map. Publish the ODbL datasets.
3. Fuel prices: request quotes from iExit (API includes OPIS or GasBuddy sourced prices) and OPIS. Google `fuelOptions` only works if the app switches to a Google map, which conflicts with MapKit and CarPlay plans.
4. EV: AFDC (NLR) download, refreshed weekly by a backend job.
5. Hours and ratings: Foursquare Premium fields on demand, cached up to 30 days.
