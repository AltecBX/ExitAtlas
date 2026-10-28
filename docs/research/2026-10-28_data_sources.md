# ExitAtlas data sources research: rest areas, businesses, pets, attractions, coverage, refresh

Date: 2026-10-28. Scope: what ExitAtlas keeps from OpenInterstate today, what else exists, and which sources can fill the gaps. Legal readings are interpretation, not legal advice. Every measured number below was produced in this session; the scripts and raw outputs are in `/tmp/claude-0/-home-user-ExitAtlas/e25f37e4-74ff-5276-af74-01faf46eb897/scratchpad/rd/`.

## 0. How the measurements were made (read first)

* **Overpass API could not be used.** From this sandbox, `overpass-api.de` reset every connection at the egress proxy (3 attempts, status endpoint only). Through WebFetch (which runs outside the sandbox) it returned HTTP 503 three times, and two public mirrors (`overpass.private.coffee`, `overpass.kumi.systems`) timed out after 60 s. That is 5 interpreter requests, none answered; I stopped there to stay under the 10 query budget. The prepared queries are in `rd/overpass/` (`qA_US-GA.txt` tag counts, `qB_US-GA.txt` amenities within 150 m) and can be run as is on overpass-turbo.eu.
* **Replacement measurements, same OSM data:**
  1. **OSM API v0.6 multi-fetch** of the current tags of every one of the 3,268 `restArea` places in the shipped OpenInterstate release (9 requests of up to 400 IDs, within the OSMF API usage policy, which asks for a valid User-Agent and at most 2 download threads: <https://operations.osmfoundation.org/policies/api/>). This measures exactly the rest areas ExitAtlas ships, with tags as of 2026-10-28.
  2. **Geofabrik taginfo for the US** (data until 2026-10-27T21:23:57Z) for national counts and tag combinations: <https://taginfo.geofabrik.de/north-america:us/tags/highway=rest_area>. Taginfo only lists combinations above a frequency threshold, so rare tags show as "not listed".
  3. **ohsome API** (HeiGIT, OSM history to 2026-07-27T09:00Z, <https://api.ohsome.org/v1/metadata>) for all OSM rest areas and service plazas inside state polygons (Census TIGER 2026, simplified), including ones OpenInterstate does not link to an exit.
* **Not measured:** amenities mapped as separate features inside a rest area polygon (`amenity=toilets`, `leisure=picnic_table`, `amenity=vending_machine`, `leisure=dog_park` nodes). This needs a spatial join (Overpass `around`, or a local osmium/PostGIS job on a Geofabrik extract, which was also blocked here). The coverage numbers below therefore count tags on the rest area feature itself and are a lower bound for "OSM knows this rest area has X". UNVERIFIED how much the separate features add.

## 1. What ExitAtlas keeps today and what is dropped

Source files: `/home/user/ExitAtlas/tools/data-pipeline/build_interstates.py`, `/home/user/ExitAtlas/docs/02_data_sources_and_licensing.md`, release `release-2026-07-13-gha-33` (manifest and `datapackage.json` read from the downloaded tarball; schema also at <https://openinterstate.org/schema>).

| OpenInterstate table | Columns in release | Kept by `build_interstates.py` | Dropped |
|---|---|---|---|
| `corridor_exits` (95,422 rows) | exit_id, corridor_id, interstate_name, direction_code, sequence_index, exit_number, exit_name, lat, lon, geometry_geojson | exit_id (collapsed to node), lat, lon, exit_number, exit_name, interstate_name (weak hint) | corridor_id, direction_code, sequence_index (bearing is recomputed instead) |
| `corridor_edges` | edge_id, corridor_id, interstate_name, direction_code, length_m, geometry_geojson | geometry, only to compute carriageway bearings at exit nodes | everything else |
| `places` (133,613) | place_id, category, name, display_name, brand, geometry_geojson | all six | nothing: the release has **no other place columns** |
| `exit_place_links` (708,711) | exit_id, place_id, category, distance_m, rank | place_id, distance_m, rank | category (redundant) |
| reachability.csv (285,402 pairs, <https://github.com/tldev/openinterstate-reachability>) | exit_id, place_id, route_distance_m, route_duration_s, reachable, reachability_score, reachability_confidence, provider, provider_dataset_version, updated_at | route_distance_m, route_duration_s, reachable | reachability_score, reachability_confidence, provider, provider_dataset_version, updated_at (useful provenance) |
| `reference_routes`, `exit_aliases` (empty) | | used by `build_corridors.py` | |

**The amenity, hours and rest area tags are dropped upstream, not by ExitAtlas.** OpenInterstate's osm2pgsql mapping stores every OSM tag of each POI in a `tags` jsonb column (`schema/osm2pgsql/openinterstate.lua`, <https://github.com/tldev/openinterstate/blob/main/schema/osm2pgsql/openinterstate.lua>), and `schema/derive.sql` copies them into `pois.tags_json` (<https://github.com/tldev/openinterstate/blob/main/schema/derive.sql>), but the CSV export writes only the six columns above. So opening_hours, toilets, wheelchair, capacity, hgv, operator, website, phone, check_date and brand:wikidata exist in OpenInterstate's database and never reach the release. Options: (a) ask upstream to export a `place_tags` table (it is an "upstream data layer", README: <https://github.com/tldev/openinterstate>), or (b) join the release's `place_id` (an OSM `node/123` or `way/456` id) back to OSM tags in ExitAtlas's own pipeline (from a Geofabrik extract, <https://download.geofabrik.de/north-america/us.html>, 12.0 GB on 2026-07-12 per the release manifest). Option (b) needs no upstream change and is what section 7 assumes.

Other facts from the mapping and derive SQL that matter for the questions below:
* Classification order (`classify_poi`): fuel, then lodging, then food (any feature with a `cuisine` tag becomes food), then `highway=rest_area|services` become `restArea`, then `amenity=toilets` becomes `restroom`, then EV, dog park, park (only if the name contains "park"). `restroom` places are computed but excluded from links (`derive.sql`: `p.category <> 'restroom'`). The app's `Other` category has no source rows in this release.
* Places are linked to an exit only within 800 m (1,600 m for parks and dog parks), top 12 per category (`derive.sql`). Mainline rest areas get an exit only because `derive.sql` promotes any `motorway_junction` within 1,200 m of a rest area (or anything named "welcome center") to an exit (`rest_anchor_exits`). Rest areas are therefore shown as "places at an exit", not as their own route items.
* Direction filtering of rest areas is name based only: a rest area whose name says "eastbound" is unlinked from a westbound exit. Names carry a direction in 34% of shipped `highway=rest_area` features (measured below).
* Scope is signed interstates only: a way counts only if `ref`/`int_ref` matches `I-<n>` (`has_interstate_ref`). README: "Releases cover signed interstates only".
* Releases are manual: built by a manually triggered GitHub Actions workflow with an opt-in publish step (README).

### 1.1 Measured: what the shipped `restArea` category actually contains

Current OSM tags of all 3,268 shipped `restArea` places (OSM API, 2026-10-28):

| OSM class now | Count | Share |
|---|---|---|
| `highway=services` | 1,981 | 61% |
| `highway=rest_area` | 1,266 | 39% |
| deleted or untagged since the 2026-07-12 extract | 13 | 0.4% |
| retagged to something else (commercial land use, viewpoint, campsite, shop) | 8 | 0.2% |

Of the 1,981 `highway=services`, 72% carry a `brand` (top brands in the release: Love's 425, Pilot 338, TA 185, Flying J 182, Petro 75, QuikTrip 75) and 82% have `hgv=yes|designated`. In the US, `highway=services` is commonly used for off-exit truck stops; the OSM community thread on this says there is no consensus but the usage is "common and accepted in North America" (<https://community.openstreetmap.org/t/highway-services-for-off-exit-truck-stops/120240>), while the wiki defines it as a place to refuel, rest or take refreshments (<https://wiki.openstreetmap.org/wiki/Tag:highway%3Dservices>). **Consequence for the app:** the "Rest Area" chip today mostly shows truck stops. Split it into `restArea` (public, `highway=rest_area`), `servicePlaza` (`highway=services` on a toll road or without a brand) and `truckStop` (`highway=services` with a brand or `hgv=yes`). 

## 2. Rest areas and service plazas

### 2.1 Placing them on the route as their own items, with direction of travel

Recommended model: a rest area is a route item with its own mile position, not a child of an exit.

1. **Candidates:** OSM `highway=rest_area` and `highway=services` (nodes, ways, relations; use the polygon centroid or point on surface), plus official lists (NTAD Truck Stop Parking, state 511 rest area feeds, section 2.4) for conflation and status.
2. **Which carriageway serves it (direction):** in order of reliability:
   * Geometry (preferred): find the `highway=motorway_link` (or `service`) ways that connect the rest area to the motorway. The `oneway=yes` motorway way that the entry link diverges from gives the carriageway and its bearing. ExitAtlas already stores carriageway bearings at exits; apply the same bearing match (route bearing within about 45 degrees) to the rest area's entry point. A rest area whose links attach to both carriageways (median or bidirectional) serves both. This needs OSM way topology from an extract; OpenInterstate's `corridor_edges` can supply carriageway geometry and bearings near the rest area.
   * Official: NTAD `highway_route` ends in a direction for 1,433 of 1,915 records (75%), for example "I-75N", "I-10 EB" (measured, section 2.4). 511GA returns a `Direction` field and DriveNC a `Highway` field (section 2.4).
   * Name: 34% of shipped `highway=rest_area` names contain a direction word (Northbound, SB, ...). No shipped rest area uses a `direction` or `destination` tag (0 of 1,266), so tags cannot be relied on.
3. **Position:** project the entry point onto the route polyline, keep it if it is within about 300 m of the matched carriageway, and sort it with exits by distance along route. Show "Rest area, northbound, 12 mi" with its own ETA. Keep the existing exit link only for rest areas off the highway (welcome centers reached through an exit).
4. **Status overlay:** closed or open from 511 feeds where licensed (GA, NC), WZDx work zones near the item, and `opening_hours` when present.

### 2.2 OSM tags that describe rest area facilities

| Need | OSM tag (on the rest area feature unless noted) | Reference |
|---|---|---|
| Rest area / service plaza | `highway=rest_area` (no fuel), `highway=services` (fuel and food) | <https://wiki.openstreetmap.org/wiki/Tag:highway%3Drest_area>, <https://wiki.openstreetmap.org/wiki/Tag:highway%3Dservices> |
| Toilets | `toilets=yes/no`; or a separate `amenity=toilets` feature inside | rest_area wiki lists `toilets`, `shower`, `drinking_water`, `bin`, `picnic_table` as feature attributes, and says amenities may also be mapped as separate features |
| Wheelchair accessible toilets | `toilets:wheelchair=yes/no`; general `wheelchair=yes/limited/no` | <https://wiki.openstreetmap.org/wiki/Key:toilets:wheelchair>, <https://wiki.openstreetmap.org/wiki/Key:wheelchair> |
| Drinking water | `drinking_water=yes/no`; or `amenity=drinking_water` feature | rest_area wiki |
| Picnic tables | `picnic_table=yes/no`; or `leisure=picnic_table` features | rest_area wiki |
| Dog area | `leisure=dog_park` feature inside; `dog=yes/no/leashed` (access for dogs) | <https://wiki.openstreetmap.org/wiki/Tag:leisure%3Ddog_park>, <https://wiki.openstreetmap.org/wiki/Key:dog> |
| Vending | `vending=*` on the area (US imports use it), or `amenity=vending_machine` features | <https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dvending_machine> |
| Food | `amenity=fast_food/restaurant/cafe` features inside a `highway=services` | <https://wiki.openstreetmap.org/wiki/Tag:highway%3Dservices> |
| Truck and car parking | `hgv=yes/designated/no`; `capacity=*` (documented, with subkeys such as `capacity:disabled`); `capacity:hgv=*` is used in practice but has no wiki page (Key:capacity:hgv returns 404) and only 165 US objects carry it (taginfo); truck lots can also be separate `amenity=parking` areas with `hgv=designated` + `capacity` | <https://wiki.openstreetmap.org/wiki/Key:hgv>, <https://wiki.openstreetmap.org/wiki/Key:capacity>, <https://taginfo.geofabrik.de/north-america:us/keys/capacity:hgv> |
| Hours, 24/7 | `opening_hours=24/7` or a schedule; `seasonal=*` | <https://wiki.openstreetmap.org/wiki/Key:opening_hours> |
| RV dump, showers, Wi-Fi | `sanitary_dump_station=yes`, `shower=yes`, `internet_access=wlan` | <https://wiki.openstreetmap.org/wiki/Key:sanitary_dump_station> |
| Freshness | `check_date=YYYY-MM-DD` | <https://wiki.openstreetmap.org/wiki/Key:check_date> |
| Lifecycle | `disused:highway=rest_area`, `abandoned:*`, names with "(historical)" | <https://wiki.openstreetmap.org/wiki/Lifecycle_prefix> |

### 2.3 Measured tag coverage

**A. Shipped rest areas, current OSM tags (OSM API, 2026-10-28).** Share of features with the key present. State by point in polygon (Census TIGER 2026).

| Tag | US rest_area (1,266) | GA rest_area (34) | FL (58) | OH (42) | PA (42) | TX (85) | CA (56) | US services (1,981) | GA services (100) |
|---|---|---|---|---|---|---|---|---|---|
| name | 70% | 71% | 67% | 69% | 60% | 94% | 95% | 83% | 80% |
| operator | 33% | 59% | 90% | 24% | 0% | 92% | 12% | 7% | 10% |
| toilets (any value) | 58% | 15% | 66% | 55% | 50% | 88% | 89% | 9% | 6% |
| toilets=yes | 51% | 15% | 66% | 55% | 50% | 56% | 89% | 8% | 6% |
| toilets:wheelchair | 5% | 0% | 0% | 2% | 0% | 41% | 2% | 0.2% | 0% |
| wheelchair | 2% | 0% | 0% | 0% | 0% | 4% | 0% | 1% | 0% |
| drinking_water | 23% | 3% | 0% | 0% | 0% | 76% | 88% | 0.3% | 0% |
| picnic_table | 19% | 3% | 0% | 5% | 0% | 89% | 84% | 0.2% | 0% |
| dog | 0.2% (2) | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| vending | 6% | 0% | 2% | 0% | 0% | 2% | 88% | 0% | 0% |
| capacity (any) | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0.7% | 8% |
| capacity:hgv | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0.3% | 6% |
| hgv | 4% | 15% | 0% | 0% | 0% | 2% | 0% | 83% | 83% |
| opening_hours | 16% | 38% | 24% | 0% | 2% | 91% | 4% | 5% | 16% |
| opening_hours=24/7 | 15% | 32% | 24% | 0% | 0% | 80% | 4% | 5% | 16% |
| shower | 0.1% | 3% | 0% | 0% | 0% | 0% | 0% | 3% | 7% |
| sanitary_dump_station | 2% | 0% | 0% | 0% | 0% | 0% | 0% | 0.6% | 0% |
| internet_access | 2% | 0% | 0% | 0% | 0% | 16% | 0% | 3% | 8% |
| check_date | 0.7% | 0% | 2% | 2% | 0% | 0% | 0% | 28% | 33% |
| website | 12% | 21% | 29% | 5% | 5% | 56% | 0% | 71% | 70% |
| brand | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 72% | 72% |
| direction word in name | 34% | 26% | 53% | 48% | 38% | 55% | 27% | 1% | 2% |
| `direction` / `destination` tag | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |

Reading: coverage is driven by state imports. California and Texas rest areas carry facility tags (CA water, picnic and vending near 90%; TX picnic 89%, hours 91%, wheelchair toilets 41%); Georgia, Florida, Ohio and Pennsylvania have almost nothing beyond a name and sometimes toilets. Truck parking capacity is essentially absent from OSM. Dog areas are absent as tags.

**B. All OSM rest areas nationally (taginfo, 2026-10-27), not only shipped ones.** `highway=rest_area`: 2,517 objects (489 nodes, 1,981 ways, 47 relations). With name 58.6%, toilets 45.7% (toilets=yes 37.5%, toilets=no 8.2%), operator 26.1%, drinking_water 19.0%, picnic_table 16.3%, opening_hours 14.0% (24/7 12.7%), website 9.8%, bin 9.7%, description 9.2%, operator:wikidata 8.6%. Tags such as toilets:wheelchair, capacity:hgv, dog, vending are below taginfo's combination threshold (not listed). `highway=services`: 3,128 objects; hgv 68.5% (yes 67.3%), brand 58.4%, brand:wikidata 56.1%, website 57.2%, phone 54.9%, check_date 21.8%, toilets 7.4%. Source: <https://taginfo.geofabrik.de/north-america:us/tags/highway=rest_area#combinations>, <https://taginfo.geofabrik.de/north-america:us/tags/highway=services#combinations>.

**C. All OSM features per state, including ones OpenInterstate did not link (ohsome, data to 2026-07-27).**

| State, class | All OSM | Shipped in OI | toilets | opening_hours (24/7) | hgv | capacity:hgv | operator | brand |
|---|---|---|---|---|---|---|---|---|
| GA services | 132 | 100 | 7 (5%) | 17 (13%) (17) | 100 (76%) | 6 (5%) | 11 | 82 (62%) |
| FL rest_area | 92 | 58 | 41 (45%) | 15 (16%) (14) | 1 | 0 | 59 (64%) | 0 |
| FL services | 101 | 56 | 9 (9%) | 5 (5%) (5) | 67 (66%) | 0 | 14 | 61 (60%) |
| OH rest_area | 92 | 42 | 41 (45%) | 3 (3%) (3) | 0 | 0 | 19 (21%) | 0 |
| OH services | 168 | 87 | 15 (9%) | 2 (1%) (2) | 111 (66%) | 0 | 24 (14%) | 82 (49%) |
| PA rest_area | 52 | 42 | 21 (40%) | 1 (2%) (0) | 0 | 0 | 0 | 0 |
| PA services | 81 | 63 | 14 (17%) | 6 (7%) (6) | 52 (64%) | 0 | 2 (2%) | 49 (60%) |

GA `rest_area` failed at ohsome (connection dropped mid transfer); the GA rest area numbers in table A (shipped features) stand in. Between 19% (PA rest areas) and 54% (OH rest areas) of a state's OSM rest areas and plazas are not linked to any exit in OpenInterstate (for example Florida's Turnpike plazas, section 6, and Ohio Turnpike plazas, UNVERIFIED which ones). Shipped counts come from current tags and TIGER polygons; ohsome counts from July data, so the comparison is approximate.

### 2.4 Official and government sources

| Source | What it has | License | Update frequency | Notes |
|---|---|---|---|---|
| **BTS NTAD Truck Stop Parking** (FHWA, Jason's Law survey), FeatureServer <https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_Truck_Stop_Parking/FeatureServer>, DOI 10.21949/1404309 (<https://rosap.ntl.bts.gov/view/dot/88314>), <https://catalog.data.gov/dataset/truck-stop-parking> | Public rest areas, welcome centers, weigh stations, public truck parking. Fields: `nhs_rest_stop` (name), `highway_route`, `mile_post`, `municipality`, `county`, `state`, `latitude`, `longitude`, `number_of_spots` | "work of the United States government ... not protected by any U.S. copyrights ... unrestricted public use" (service description) | Compiled 2019-04-09 per service description; layer data last edited 2024-06-26 (editingInfo). Irregular | **Measured:** 1,915 records in 48 states; 111 weigh stations (exclude); 1,458 public sites on I- routes; 75% carry a direction suffix; every record has `number_of_spots` (sum 39,803 truck spaces). 996 of 1,458 (68%) interstate sites have a shipped OSM `highway=rest_area` within 1 km; 75% have any shipped `restArea` within 1 km; Georgia 24 of 26. **This is the closest thing to a national rest area dataset.** No amenities, no hours, no status |
| Jason's Law survey report (2015) | Truck parking survey results | US Gov work | One time (2015, update 2019) | <https://rosap.ntl.bts.gov/view/dot/51789> (UNVERIFIED that this record is the 2015 report; it was returned by search for the report title) |
| National rest area dataset (data.gov) | None found at federal level. data.gov has state datasets (Iowa <https://catalog.data.gov/dataset/rest-areas-data>, non federal terms) | | | Search found no FHWA national rest area layer; NTAD Truck Stop Parking fills the role |
| State DOT GIS, e.g. Caltrans Safety Roadside Rest Areas <https://gisdata.dot.ca.gov/arcgis/rest/services/CHhighway/Rest_Areas/MapServer> | Per state lists with amenities | Per state (Caltrans terms UNVERIFIED) | Caltrans metadata says last updated 2023-08-15 (search result, UNVERIFIED by direct read) | One integration per state |
| **511GA** `GET /api/v2/get/restareas` <https://511ga.org/help/endpoint/restareas> | Id, Latitude, Longitude, Name, Website, Type, **Status** (Open/Closed), Roadway, **Direction**, MileMarker, Location, Description, **Amenities** (free text: "Restrooms, ... separate truck and passenger vehicle parking, picnic tables, water, RV dump station") | Developer key; terms page requires login (<https://511ga.org/developers/termsofuse> redirected); redistribution terms UNVERIFIED | Live | Earlier project research notes (not re-checked today): 10 calls per 60 s. Website field points to <https://www.georgiarestareas.com/> |
| **DriveNC** `GET /api/v2/get/restareas` <https://www.drivenc.gov/help/endpoint/restareas> | Name, Description, County, Highway, Phone, **Status**, **Accommodations** (for example "Handicapped Accessible Restrooms, Picnic Areas, ... Water Fountains"), **CarParking**, **CarTrailerParking**, **TruckParking**, Seasonal, LastUpdated | Developer key; terms UNVERIFIED | Live | Best amenity and capacity source found |
| Other state 511 sites (NY, PA, VA, WI, SC, FL) | Events, some rest areas | Mostly keys and unclear redistribution; PennDOT allows commercial use with credit (repo doc 2.2) | Live | Rest area endpoints beyond GA and NC UNVERIFIED |
| **TPIMS** (MAASTO truck parking availability, 8 states: IA, IN, KS, KY, MI, MN, OH, WI) | Live truck spaces available per site; static and dynamic JSON feeds `TPIMS_Static`, `TPIMS_Dynamic` | Open dynamic and static feeds, archive for trusted partners (spec v2.2) | Live, minutes | Spec <https://transportal.cee.wisc.edu/tpims/TPIMS_TruckParking_Data_Interface_V2.2.pdf>, KS developer doc <https://tpims.ksdot.gov/docs/TPIMS_TruckParking_Data_Interface_App_Developers.pdf>, 511WI <https://511wi.gov/developers/doc>. Current endpoint availability UNVERIFIED |
| **WZDx work zone feeds** registry <https://data.transportation.gov/resource/69qe-yiui.json> | Feed URL, state, version, key needed, update frequency | Registry "Public Domain U.S. Government"; feed data must be CC0 per spec (`FeedInfo.license` "must be ... publicdomain/zero/1.0", <https://github.com/usdot-jpo-ode/wzdx/blob/main/spec-content/objects/FeedInfo.md>) | Registry rows updated 2026-10-23; feeds 1 to 15 min | **Measured:** 43 feeds, 42 active, 14 need an API key; versions 4.x mostly. No Georgia or South Carolina feed |

Closures: the only rest area status feeds found are 511GA and DriveNC (`Status`). No national closure feed exists (also noted in this repo's earlier research). WZDx feeds sometimes describe ramp and rest area closures as work zones (UNVERIFIED how often).

## 3. Businesses

### 3.1 Overture Maps Places

* **License:** per source, recorded in each record's `sources[].license`. Measured in a Georgia sample: Meta, Microsoft, BrightQuery, Uberall, DAC, PinMeTo, Birdeye, RenderSEO, OpenTravel and Overture's own conflation are `CDLA-Permissive-2.0`; Foursquare `Apache-2.0`; AllThePlaces `CC0-1.0`. Attribution page: <https://docs.overturemaps.org/attribution/> ("Data from [provider]" credit lines; Foursquare adds a copyright notice). The places theme contains no OSM data (<https://docs.overturemaps.org/guides/places/>), so it does not carry ODbL share alike.
* **Schema** (v2.0.0, <https://docs.overturemaps.org/schema/reference/places/place/>): `id` (GERS), `names`, `basic_category` (about 280 labels), `taxonomy` (primary, hierarchy, alternates; `categories` was removed in September 2026), `confidence` 0 to 1 ("how confident we are that the place exists"; 0 pairs with `permanently_closed`), `operating_status` (`open`, `temporarily_closed`, `permanently_closed`; "does not indicate opening hours"), `brand` (`names`, `wikidata`), `websites`, `socials`, `emails`, `phones`, `addresses`, `sources[]` (dataset, record_id, update_time, confidence, license). **No opening hours, no ratings.**
* **Cadence:** monthly since October 2023; latest 2026-10-21.0, next 2026-11-18.0; breaking schema changes quarterly; public files removed after 60 days (<https://docs.overturemaps.org/release-calendar/>).
* **Download a US subset:** S3 `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=places/type=place/*` or Azure; filter on `bbox` with DuckDB or the `overturemaps` CLI (`overturemaps download --bbox=... --type=place`) (<https://docs.overturemaps.org/guides/places/>). Note: inside this sandbox the `s3://` scheme failed because the proxy injects placeholder AWS keys; reading the 16 files by HTTPS URL from the bucket listing worked.
* **Measured size:** the whole places theme is 11.9 GB in 16 zstd Parquet files (S3 listing). A US subset of 23 road trip categories (gas, hotel, lodging, fast food, restaurant, coffee, cafe, EV charging, park, museum, campground, RV park, dog park, monument, historic site, national park, nature reserve, zoo, amusement park, rest stop, food court, inn) with 9 columns is **1,957,696 rows, 73 MB Parquet**, extracted in 79 s. 1,646,866 have confidence at least 0.7 and status open or null. Only **114 `rest_stop`** records exist nationally, so Overture cannot supply rest areas.
* **Measured quality, Georgia bbox** (822,459 places): brand 10.0% (brand wikidata 1.5%); confidence at least 0.9 59.5%, at least 0.5 89.6%; `operating_status` open 71.4%, null 25.2%, permanently_closed 3.3% (27,382), temporarily_closed 4. Gas stations 9,341 (48% branded), fast food 6,506 (72% branded), hotels 4,716 (40% branded). Latest source `update_time` 2026-10-15.
* Overture says confidence is not calibrated across providers; use it as a relative filter (its example keeps `confidence > .95`) (places guide).

### 3.2 Foursquare Open Source Places

* License Apache 2.0 (<https://huggingface.co/datasets/foursquare/fsq-os-places>, <https://docs.foursquare.com/data-products/docs/access-fsq-os-places>). Access: Places Portal with an Iceberg catalog, Hugging Face (gated: accept conditions, log in), Snowflake; PMTiles at `s3://fsq-os-places-us-east-1/release/vector-tiles/latest/fsq-os-places.pmtiles`.
* Schema (<https://docs.foursquare.com/data-products/docs/places-os-data-schema>): `fsq_place_id`, name, lat/lon, address fields, `date_created`, `date_refreshed`, `date_closed`, tel, website, email, social handles, `fsq_category_ids/labels`, `unresolved_flags` (closed, duplicate, delete, doesnt_exist ...). Delta files with add/update/remove/merge. **No brand or chain field, no hours.**
* Size: Hugging Face lists 263 GB of Parquet (likely several releases); latest path `dt=2026-10-15` (page inconsistent). Cadence not stated (UNVERIFIED; Overture's monthly ingest includes Foursquare).
* Use: closure signal (`date_closed`, `unresolved_flags`) and freshness (`date_refreshed`). Overture already includes some Foursquare records (47,271 source rows in the Georgia sample).

### 3.3 OSM brand tags and name-suggestion-index

* NSI is BSD 3-Clause (LICENSE.md, <https://github.com/osmlab/name-suggestion-index>), maps brand names to `brand`, `brand:wikidata`, `name`, `operator` tag sets with a `locationSet` (for example the fuel category file has 743 entries). Browse at <https://nsi.guide>.
* OSM US brand coverage (taginfo `brand:wikidata` share): fuel 66.0%, fast food 77.8%, hotel 59.4%, motel 25.7%, EV charging 67.1%, cafe 30.5%, restaurant 13.2%.
* Use NSI to normalize brand display names and to tag Overture records with the same brand keys, so "favorite brands" works across sources.

### 3.4 Licensed providers

| Provider | Hours | Closures | Storage / caching | Display rules |
|---|---|---|---|---|
| Google Places API (New) | `regularOpeningHours`, `currentOpeningHours` (Enterprise SKU) | `businessStatus` (Pro) | "must not pre-fetch, cache, or store ... beyond the allowed exceptions"; place IDs may be stored indefinitely (<https://developers.google.com/maps/documentation/places/web-service/policies>); lat/lng may be cached up to 30 consecutive days (Service Specific Terms 14.3) | Must not be used "in conjunction with a non-Google map" (14.2, <https://cloud.google.com/maps-platform/terms/maps-service-terms>); Google Maps logo, or text "Google Maps" where space is limited |
| Yelp Places (Fusion) API | Yes | Yes | Not longer than 24 hours, except Yelp business IDs (Section 5(a)); may not "create your own database of business listing information" (5(b)); geocodes may not be used in OpenStreetMap (5(g)) (<https://terms.yelp.com/developers/api_terms/>) | Yelp logo linking to Yelp, Yelp star images, review count beside rating (<https://terms.yelp.com/developers/display_requirements/>) |
| Foursquare Places API | Premium fields | Yes | Verified only for the Personalization API page: IDs unlimited; other attributes Enterprise 24 hour on device only, Pay as you go and Sandbox no caching (<https://docs.foursquare.com/developer/reference/usage-guidelines-personalization-apis>). The Places API guideline page returned 404; a search summary of it gives the same rules. **This contradicts the "30 day cache" in docs/02 section 2.2; treat 30 days as UNVERIFIED and re-check** | Credit Foursquare as the source |
| SafeGraph Places | Open hours | `opened_on`, `closed_on`, `tracking_closed_since` (from July 2019) | Commercial license by contract; monthly updates; price by rows, columns, delivery (<https://www.safegraph.com/products/places/>); third party listing $30,000 per year (UNVERIFIED, <https://datarade.ai/data-products/safegraph-brand-data-global-coverage-41m-places-safegraph>) | Per contract |
| Advan | Foot traffic (Patterns), not a POI hours source | | Advan acquired SafeGraph's Patterns business (announced 2022-11-03, <https://advanresearch.com/insights/advan-acquires-safegraphs-patterns-business-expanding-leadership-in-location-intelligence-and-foot-traffic-analytics>) | Per contract |

### 3.5 Closures and opening hours: what is reliable, what can be stored offline

* **Storable offline:** OSM `opening_hours` (ODbL), Overture `operating_status` and `confidence` (CDLA/Apache/CC0), FSQ OS `date_closed`, `unresolved_flags`, `date_refreshed` (Apache), OSM `check_date`. **Not storable:** Google, Yelp, Foursquare API content beyond IDs (above).
* **OSM hours coverage in the US is uneven** (taginfo share with `opening_hours`): fast food 53.9%, cafe 38.0%, restaurant 31.4%, EV charging 28.8% (mostly 24/7), museum 25.7%, fuel 8.9%, hotel 1.7%, attractions 3.5%. Only 8.8 to 17% of these carry a `check_date`.
* **Reliability rule for the app:** show hours only with a source and age ("OSM, checked 2025-04"); treat chain hours as typical rather than confirmed; mark a place "may be closed" when Overture says `permanently_closed` or confidence below about 0.5, or FSQ OS has `date_closed`, or OSM has a lifecycle prefix; never claim "open now" for data older than about 12 months without a live check. Live hours on demand require a licensed API shown under that provider's display rules (Google only on a Google map).

## 4. Hotels with pet policies

| Source | What it gives | Usable? |
|---|---|---|
| OSM | Keys `pets` (628 US objects in total, 247 combined with any `tourism` key), `pets_allowed` (619, 184 with tourism), `dog` (1,354 with any tourism key, mostly not lodging) versus 46,129 `tourism=hotel` + 16,743 `tourism=motel` (taginfo <https://taginfo.geofabrik.de/north-america:us/keys/pets>). Even if every one of those tagged objects were a hotel, **at most 0.7% of hotels and motels have `pets`/`pets_allowed`, and at most 2.2% have `dog`**. | No, too sparse |
| Overture, FSQ OS | No pet attribute in either schema | No |
| Google Places API (New) | `allowsDogs` boolean, Enterprise + Atmosphere SKU (<https://developers.google.com/maps/documentation/places/web-service/data-fields>) | Only live, not stored, and only on a Google map |
| Expedia Rapid Content API | `attributes.pets` group, for example "Pets allowed" (id 51), "Dogs only" (2809), plus pet fee and weight attributes (<https://developers.expediagroup.com/rapid/lodging/content/content-reference-lists>) | Partner approval; content terms UNVERIFIED |
| Booking.com Demand API v3.2 | `policies.pets` object with `allowed` and `charge_mode` (<https://developers.booking.com/demand/docs/migration-guide/v3.2/accommodations/details>) | Affiliate partner only; terms UNVERIFIED |
| Brand policies | Red Roof: up to two pets, first pet free, second $15 per night, 80 lb limit (official page <https://www.redroof.com/why-red-roof/pet-policy>, figures from a search snippet because the page blocked automated reading). Motel 6: pets free, 2 per room, Studio 6 $10 per day up to $100 (<https://www.motel6.com/en/home/policies/pets-policy.html>, search snippet). La Quinta: up to two pets, optional fee $25 per night capped at $75 (en-UK page) or $20/$40 (es-XL page), some hotels exclude pets (<https://www.wyndhamhotels.com/en-uk/laquinta/about-us/pet-friendly/pet-policy-details>, <https://www.wyndhamhotels.com/en-ca/laquinta/about-us/pet-friendly>). All say policies vary by property. | Yes as a "brand usually allows pets" hint with a "confirm with hotel" note; join on `brand:wikidata` (Red Roof, Motel 6, La Quinta all carry it in NSI) |

Recommendation: no open source confirms pet policies per property. Ship a curated brand table (brand wikidata id, policy summary, fee, limits, source URL, checked date) and label hotels "Pet friendly brand, confirm with hotel". Consider Expedia Rapid or Booking Demand only if the app also books rooms.

## 5. Roadside attractions, scenic overlooks, parks, landmarks

| Source | Content | License | Access, cadence |
|---|---|---|---|
| NPS API (developer.nps.gov) | Parks, places, things to do, visitor centers, campgrounds, alerts | NPS content "generally considered in the public domain"; some images and content have third party rights; Arrowhead needs permission; citation appreciated (<https://www.nps.gov/aboutus/disclaimer.htm>) | Free key, 1,000 requests per hour, HTTP 429 over limit (<https://www.nps.gov/subjects/developer/guides.htm>) |
| Recreation.gov RIDB | Federal recreation areas, facilities, campsites, activities (all agencies) | Federal data; explicit license statement not found (UNVERIFIED); data.gov entry <https://catalog.data.gov/dataset/recreation-information-database-ridb-58364> | Free key; 50 requests per minute per a third party guide (UNVERIFIED); **full export zip 248 MB, last modified 2026-10-27** (<https://ridb.recreation.gov/downloads/RIDBFullExport_V1_CSV.zip>, measured HEAD) |
| OSM `tourism=viewpoint` | 22,457 US objects; only 33.2% named, 0.9% with wikidata | ODbL | Daily |
| OSM `tourism=attraction` | 18,330; name 90%, wikidata 10.1%, website 13.7%, hours 3.5% | ODbL | Daily |
| OSM `tourism=museum` | 14,907; wikidata 21.4%, website 51.9%, hours 25.7% | ODbL | Daily |
| OSM `historic=memorial` | 39,015; wikidata 2.5% (mostly plaques, low value) | ODbL | Daily |
| Wikidata | Coordinates, instance of, heritage designation, sitelinks (notability) | CC0 (<https://www.wikidata.org/wiki/Wikidata:Licensing>) | Live; weekly dumps |
| Wikipedia | Descriptions | Text CC BY-SA 4.0 (and GFDL) (<https://en.wikipedia.org/wiki/Wikipedia:Copyrights>); share alike and attribution if text is shipped | Live |
| National Register of Historic Places | Listed properties, geodatabase download | Unrestricted public NRIS data (<https://www.nps.gov/subjects/nationalregister/data-downloads.htm>, <https://www.nps.gov/orgs/1094/nrhp_spatialdata.htm>); explicit public domain statement not found (US Gov work, UNVERIFIED) | NPS FAQ: public GIS data are "NEITHER up-to-date nor complete" (<https://home.nps.gov/orgs/1094/upload/NR_FAQ.pdf>); listing dated to 2025-06-24 per search |
| Historical Marker Database (HMdb) | Markers, text, photos | Copyright page: commercial use needs written permission, including receiving any compensation from display; attribution to HMdb.org for any copying; some photos have separate owners (<https://www.hmdb.org/copyright.asp>, from search result text; the page returned 403 to direct fetch) | Not usable without a written license. OSM `ref:hmdb` links exist (<https://wiki.openstreetmap.org/wiki/Key:ref:hmdb>) |
| Overture places | historic_site 183,836, park 166,394, museum 32,344, monument 7,731, national_park 4,782, zoo 2,744 in the US (measured) | CDLA/Apache/CC0 | Monthly |

**Quality filter (suggested, so the app does not recommend junk).** Keep a place only if all hard rules pass, then rank by score.
* Hard rules: has a name; not permanently closed (Overture status, FSQ `date_closed`, OSM lifecycle prefix); within the detour budget (for example at most 10 minutes from the exit by the reachability drive time); category on an allow list (viewpoint, museum, attraction, national or state park, historic site with designation, zoo, notable landmark); for OSM `historic=memorial` and plaques, require a wikidata link.
* Score (0 to 100): Wikidata sitelinks (0 for none, up to 35 for 10 or more language Wikipedias); official designation (NPS unit, NRHP listed, National Scenic Byway feature, state park: +25); multiple independent sources agree within 150 m (OSM + Overture + Wikidata or NRHP: +15); Overture confidence at least 0.9 (+10); has website or hours (+5); recent `check_date` or Overture update within 2 years (+10). Show items above about 40; let users mute a category and report "not worth it".
* Viewpoints: only named ones, or ones on an FHWA byway or inside a park, because two thirds of OSM viewpoints have no name.

## 6. Coverage beyond signed interstates

* **Measured gap:** OSM has **77,442 `highway=motorway_junction` nodes** in the US; 62.1% carry `ref`, 26.0% `noref=yes` (taginfo). The shipped release covers 38,553 physical interstate exit nodes, about half. The rest sit on non interstate freeways and toll roads.
* **Florida's Turnpike** mainline ways (for example way 911119786, 542559452, 47473471, <https://www.openstreetmap.org/way/911119786>) are tagged `highway=motorway`, `name=Florida's Turnpike`, `toll=yes`, `unsigned_ref=SR 91`, and **no `ref`**. OpenInterstate's `has_interstate_ref` only accepts `ref`/`int_ref` matching `I-<n>`, so the Turnpike is excluded. Its exits exist: node 360062295 is `highway=motorway_junction`, `ref=259` (the I-4 interchange). 859 OSM objects are named "Florida's Turnpike" and 424 "Homestead Extension of Florida's Turnpike" (taginfo). Pennsylvania Turnpike spur routes carry `ref=PA Tpke 43` (266 objects) and `PA Tpke 66` (68), which an `I-` filter also drops (taginfo `ref` values).
* **How to get exits for any freeway from OSM:** take `highway=motorway` ways (plus `highway=trunk` with `motorway_link` ramps), build the directed carriageway graph from `oneway`, take `highway=motorway_junction` nodes on those ways, read `ref`/`junction:ref`, `name`/`exit:name`, and the branch `destination`, `destination:ref` tags on the departing `motorway_link` (<https://wiki.openstreetmap.org/wiki/Tag:highway%3Dmotorway_junction>, <https://wiki.openstreetmap.org/wiki/Key:destination>). Route identity: `ref` (for example `US 23`, `FL 408`), else `unsigned_ref`, else `name`, else route relations (`type=route`, `route=road`, `network=US:US`, `US:FL:Toll` ...). OpenInterstate's own pipeline does the corridor work; the cheapest path is to fork or extend its `has_interstate_ref` to accept a configured list of non interstate freeways (`network` values or names), or to run ExitAtlas's own osmium filter.
* **At grade US highways** have no junction nodes. Model them with "service clusters": places within about 300 m of the route at intersections, grouped by town, and drive time from the route.
* **Scenic byways:** FHWA America's Byways map service <https://geo.dot.gov/server/rest/services/US_Scenic_Byways/MapServer> has per state line layers with fields `NSB_DESIG`, `NAME`, `DESIGNATS`, `STATE`, `NPS_DESIG`, `BLM_DESIG`, `USFS_DESIG`, `STATE_DESI`, `BYWAY_ID` (measured). Program page <https://fhwaapps.fhwa.dot.gov/bywaysp/About>; 184 designated roads in 48 states per a search summary of fhwa.gov (UNVERIFIED). License: US Gov work (UNVERIFIED, no copyright text on the service). Update frequency UNVERIFIED (designation rounds are occasional).

## 7. Refresh pipeline design

Goals: versioned, diffable, offline datasets, downloaded over Wi-Fi, provenance per record, last known good fallback.

1. **Build (server or CI, weekly or monthly):**
   * Inputs pinned by checksum, like `build_all.sh` already does: OpenInterstate release + reachability, Geofabrik US PBF (for tags and non interstate freeways), NTAD Truck Stop Parking query, Overture release id, WZDx registry snapshot, brand pet table, Wikidata or NRHP extracts.
   * Steps: osmium tags-filter the PBF to motorways, junctions and POI tags; join OpenInterstate `place_id` to full tags; classify rest area, service plaza, truck stop; compute direction by link topology; conflate NTAD and 511 rest areas (within 1 km, same direction); Overture road trip subset within about 2 km of freeways; score attractions.
   * **License partitioning:** keep OSM derived layers (ODbL) and non OSM layers (CDLA, Apache, CC0, public domain) in separate files and never merge records across them; this follows the OSMF Collective Database guideline that docs/02 section 2.3 already cites (<https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline>). Interpretation: matching an Overture place to an OSM place to copy attributes into one record would create an ODbL derivative.
2. **Package:** one file per layer per region (for example `restareas.eaxr`, `exits_us_routes.eax`, `places_overture.eap`), each with a header holding `source`, `source_version`, `license`, `built_at`, `sha256` (the EAX header already carries JSON metadata). Each record holds a stable key (`osm:way/123@v7`, `gers:<id>`, `ntad:<OBJECTID>`) plus `source`, `source_version` and `observed_at`.
3. **Manifest:** `manifest.json` lists layer files, sizes, sha256, minimum app version, and previous version id; sign it (for example Ed25519) and verify on device.
4. **Diffs:** sort records by stable key and publish per layer deltas (`add`, `update`, `remove`), like Foursquare OS delta files; the app applies a delta if it holds the previous version, else downloads the full layer.
5. **Download:** background download restricted to Wi-Fi or non expensive networks (on iOS, `URLSessionConfiguration` background session with `allowsExpensiveNetworkAccess = false` and `allowsConstrainedNetworkAccess = false`; API names from Apple documentation, not verified in this session). Write to a staging directory, verify sha256 and signature, then atomically swap the `current` pointer.
6. **Last known good:** keep the previous version on disk until the new one opens and passes a smoke test (record counts within expected bounds, a few known exits resolve). On failure, roll back and report. Never delete the bundled baseline in the app bundle.
7. **Provenance in the UI:** each item shows its source and age ("OpenStreetMap, checked 2025-04", "NTAD 2024", "511GA live").
8. **Quality gates in CI:** diff counts per state and category against the last release; fail the build if, for example, rest areas in a state drop more than 10% or 1% of exits move more than 200 m.

**Rough US sizes** (measured unless marked):

| Item | Size |
|---|---|
| Geofabrik US PBF (pipeline input only) | 12.0 GB (2026-07-12, release manifest) |
| OpenInterstate filtered import PBF | 198 MB (release manifest) |
| OpenInterstate release tarball / CSVs | 66 MB compressed, about 168 MB CSV |
| reachability.csv | 24 MB |
| Bundled today: interstates.eax / corridors.eac | 11.7 MB / 2.3 MB |
| Overture places, whole world | 11.9 GB (16 Parquet files) |
| Overture US road trip subset (23 categories, 9 columns) | 73 MB Parquet, 1.96M rows |
| Overture subset within 2 km of freeways | Estimated 10 to 25 MB (UNVERIFIED) |
| RIDB full export | 248 MB zip |
| NTAD Truck Stop Parking | 1,915 rows, under 1 MB |
| Rest areas + service plazas with amenity tags | about 5,600 OSM features (2,517 + 3,128), under 1 MB (estimate) |
| Non interstate freeway exits | about 39,000 extra junction nodes; estimated +5 to 10 MB in EAX form (UNVERIFIED) |
| FSQ OS Places (Hugging Face) | 263 GB listed (all files) |

## 8. Recommended next steps

1. Split the `restArea` category (rest area, service plaza, truck stop) using `highway` and `brand`/`hgv` tags joined from OSM by `place_id`. Measured: 61% of today's rest area items are `highway=services`.
2. Make rest areas route items with direction from link topology, and conflate with NTAD (public domain, 75% have direction, all have truck spaces). Add 511GA and DriveNC status where the terms allow.
3. Add non interstate freeways (Florida's Turnpike first) by extending the interstate ref filter to a configured list, using `unsigned_ref`/`name` and route relations.
4. Use Overture places as a separate, non OSM layer for business confidence and closure flags, with NSI brand normalization. Fix the Foursquare cache note in docs/02.
5. Pets: curated brand table with sources and "confirm with hotel".
6. Attractions: NPS + RIDB + NRHP + Wikidata with the score in section 5; avoid HMdb without a written license.
7. Run the prepared Overpass queries (`rd/overpass/qA_US-GA.txt`, `qB_US-GA.txt`) from a network that can reach Overpass, or a local osmium job, to measure amenities mapped as separate features inside rest areas.
