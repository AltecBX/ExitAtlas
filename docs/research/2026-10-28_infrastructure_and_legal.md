# ExitAtlas: production infrastructure options and legal constraints

Research date: 2026-10-28. Sources were fetched on that date unless marked otherwise. Anything I could not confirm from a primary source is marked **UNVERIFIED**. Legal readings marked **Interpretation** are not legal advice; get counsel review before a commercial launch.

Context checked in the repo (read only): the web app calls `router.project-osrm.org` (routing, `alternatives=3`, `overview=full`, `steps=true`), `nominatim.openstreetmap.org` (search on submit only, client throttle 1.1 s), `valhalla1.openstreetmap.de/trace_attributes` (speed limits, about one request per 50 miles), Google Places API (New) `searchNearby` with `fuelOptions` using the driver's own key (15 minute in-memory cache), and AFDC `nearby-route` on `developer.nlr.gov` with `DEMO_KEY`. The web map is an offline SVG drawn from bundled state polygons, so no tile server is involved.

---

## 1. Public demo servers: usage policies and what breaks first

| Service | Policy (quoted or summarized from the source) | Acceptable for a published app with real users? |
|---|---|---|
| OSRM demo `router.project-osrm.org` (run by FOSSGIS) | "Don't exceed 1 request per second"; use "restricted to reasonable, non-commercial use-cases"; "We provide no guarantees wrt. uptime, latency, or data updates" ([OSRM wiki: Demo server](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server)). The FOSSGIS routing site adds: one request per second max, no scraping or heavy use, show attribution and a "fix the map" link, send a valid user agent and referrer; data updated about every two days ([routing.openstreetmap.de/about](https://routing.openstreetmap.de/about.html)). The full FOSSGIS terms page (German) blocked automated reading again on 2026-10-28 (Anubis bot wall): **UNVERIFIED** beyond the above. | Personal, non-commercial, few users: yes. App Store app or any monetized app: no (non-commercial clause, no SLA). App Review guideline 5.2.2 also requires that you be "specifically permitted" to use a third-party service ([App Review Guidelines, updated 2026-10-16](https://developer.apple.com/app-store/review/guidelines/)). |
| Nominatim `nominatim.openstreetmap.org` | Absolute maximum 1 request per second; limits apply per application, so all users' traffic counts together; valid HTTP Referer or User-Agent ("stock User-Agents as set by http libraries will not do"); autocomplete is forbidden ("you must not implement such a service on the client side using the API"); results must be cached, repeated identical queries can get you classified as faulty and blocked; apps must be able to switch the service off when asked "without needing a software update"; periodic background requests count as bulk; commercial users are warned the rules can change; violators are banned ([OSMF Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)). | Low traffic, user-initiated search: allowed. A public app with thousands of users: no. The app already searches on submit only and throttles each client, but the 1 request per second budget is shared by every user of the app. |
| FOSSGIS Valhalla `valhalla1.openstreetmap.de` | "Usage of the demo server follows the usual fair-usage policy as OSRM & Nominatim demo servers", "somewhat enforced by rate limits". Apps for end users should announce themselves in GitHub Discussions and send an identifying `X-Client-Id` header ([Valhalla README, Demo Server](https://github.com/valhalla/valhalla)). The rate limit is 1 call per user per second and 100 calls per second in total (2021 maintainer comment, cited by [the valh R package vignette](https://cran.ms.unimelb.edu.au/web/packages/valh/vignettes/install-valhalla.html), linking [valhalla discussion 3373](https://github.com/valhalla/valhalla/discussions/3373#discussioncomment-1644713)); current figure **UNVERIFIED**. | Personal use: yes. Before going wider: announce the app in Discussions and send `X-Client-Id`. Whether the server's CORS setup allows that custom header from a browser is **UNVERIFIED**; test the preflight. Not a production dependency (no SLA, fair use only). |
| AFDC via `developer.nlr.gov` with `DEMO_KEY` | api.data.gov DEMO_KEY: 30 requests per IP per hour and 50 per IP per day; a registered key gets 1,000 per hour; keys "should be kept private" ([api.data.gov developer manual](https://api.data.gov/docs/developer-manual/)). | Demo key only. |
| Google Places with the driver's own key | Each driver is the Google "Customer" for their own key. The usual Google terms apply (section 3). | Legal, but adds friction. See section 3 for the map-proximity issue. |

### What breaks first (ordered by likelihood as users grow)

1. **AFDC `DEMO_KEY`** gives hard HTTP 429 errors first. It allows 50 requests per day per IP, and mobile carriers put many users behind one carrier-grade NAT address, so even one request per route can run out. Fix: put a registered key in a backend (free) and serve chargers from a daily bulk download.
2. **Nominatim** has the largest blast radius. The 1 request per second budget covers all users, and the server identifies the app by its Referer (`altecbx.github.io`), so one block takes search down for every user at once. Browsers cannot reliably set `User-Agent` on `fetch`, so the Referer is the identifier. On iOS, the policy also requires a remote kill switch.
3. **OSRM demo** breaks on policy before it breaks on load. The non-commercial clause rules it out for an App Store app, and it gives no uptime or latency guarantee. `alternatives=3` combined with full geometry and steps on cross-country routes makes for heavy requests on a donated server.
4. **FOSSGIS Valhalla** is the least likely to fail at today's call rate of about one request per 50 miles, but it carries the same no-SLA, fair-use status.

---

## 2. Production routing and geocoding options

### 2.1 Vendor comparison (prices as published on 2026-10-28)

| Provider | Routing price | Geocoding / search price | Speed limits (maxspeed) | Storing route geometry / results | Map display constraint |
|---|---|---|---|---|---|
| **Mapbox** ([pricing](https://www.mapbox.com/pricing), [Product Terms Oct 20 2026 PDF](https://cdn.prod.website-files.com/609ed46055e27a02ffc0749b/6ad79764a359d21b46049ea4_Mapbox%20Product%20Terms%20(October%2020,%202026).pdf)) | Directions: 100,000 free per month, then $2.00 / $1.60 / $1.20 per 1,000. Map Matching costs the same; Map Matching allows 100 coordinates per request and 300 requests per minute ([docs](https://docs.mapbox.com/api/navigation/map-matching/)) | Temporary Geocoding: 100,000 free, then $0.75 per 1,000. Permanent Geocoding: $5.00 per 1,000, no free tier. Search Box sessions: 2,500 free, then $11.50 per 1,000 (standard), or 500 free then $3.00 (introductory preview). Search Box requests: 25,000 free, then $1.70 | **Yes**: `annotations=maxspeed` (BETA) on `driving` and `driving-traffic`, also in Map Matching ([Directions docs](https://docs.mapbox.com/api/navigation/directions/)) | **No**. 2.10.1: "Customer shall not export, download, cache or store results from any request to a Navigation API." 1.9(v) is the default no-store rule. 2.7.2: no storing temporary geocodes. 2.7.1(b): latitudes and longitudes may not be displayed to end users. Permanent geocodes may be stored (2.7.3, with conditions) | The current terms do not require a Mapbox map for Directions results (only Boundaries, Weather Layers and Studio styles, 2.2, 2.5, 2.11). 2.9.1: in mobile apps the Mapbox Mobile SDKs must be "Customer's exclusive means of accessing the Service Offerings". **Interpretation**: an iOS app would have to use a Mapbox SDK rather than calling the APIs through your own backend. Navigation SDK billing: 100 MAU free, then $0.30 per MAU, plus per-trip fees after 1,000 trips. How a standalone Directions client library is billed: **UNVERIFIED** |
| **Google Routes / Places** ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [terms](https://cloud.google.com/maps-platform/terms), [service specific terms, last modified 2026-10-28](https://cloud.google.com/maps-platform/terms/maps-service-terms)) | Compute Routes Essentials: 10,000 free, then $5.00 per 1,000. Pro (traffic-aware): 5,000 free, $10.00. Enterprise (tolls): 1,000 free, $15.00 | Geocoding: 10,000 free, then $5.00. Text Search Pro: 5,000 free, $32.00. Autocomplete requests: 10,000 free, $2.83 (session usage free). Place Details Essentials: 10,000 free, $5.00 | Routes API: no. Roads API Speed Limits ($20.00 per 1,000) is "available to all customers with an Asset Tracking license" only ([docs](https://developers.google.com/maps/documentation/roads/speed-limits)) | Only latitude and longitude may be cached, for up to 30 days (Routes SST 19.3, Places 14.3, Geocoding 6.3.1); place IDs may be kept indefinitely. Terms 3.2.3(b): "No Caching" except as listed | 3.2.3(e): "will not use the Google Maps Core Services with or near a non-Google Map"; SST 19.2, 14.2 and 6.2 say the same. Places UI Kit is the exception (SST 15.1, see section 3) |
| **HERE** ([Base Plan pricing](https://www.here.com/get-started/pricing/supplemental-pricing)) | Car routing: 30,000 free, then $0.88 per 1,000. Time-aware routing: 5,000 free, then $2.92. Route Matching: 2,500 free, then $5.83 | Geocode and reverse geocode: 30,000 free, then $0.88. Discover / Search and Autosuggest: 5,000 free, then $2.92. Permanent geocoding is not in the Base Plan | **Yes**: Routing v8 `spans=speedLimit` ([HERE blog example](https://www.here.com/learn/blog/finding-speed-limit-hls/); exact schema **UNVERIFIED**). Speed Limits API: 2,500 free, then $0.583 per 1,000 | Geocoding results: 30-day default limit, longer needs paid Permanent Geocoding ([HERE KB](https://docs.here.com/here-kb/docs/permanent-geocoding-overview-licensing-and-usage-rules)). Routing storage rules **UNVERIFIED**. HERE data must not go into an ODbL database (repo doc 2.3) | **UNVERIFIED** |
| **TomTom** ([pricing](https://docs.tomtom.com/pricing)) | Routing: 20,000 free per month (no credit card). Per-1,000 price **UNVERIFIED**: the page renders by JavaScript, and secondary sources conflict (€6.00 vs $0.75) | Geocoding: 20,000 free. Search: 2,500 free, then $2.50 per 1,000 (search snippet of the pricing page) | **Yes**: Calculate Route `sectionType=speedLimit` ([docs](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/calculate-route)). Snap to Roads: 2,500 free | **UNVERIFIED** ([developer terms](https://docs.tomtom.com/legal/terms-and-conditions) render without text) | **UNVERIFIED** |
| **Stadia Maps** ([pricing](https://stadiamaps.com/pricing/)) | Credit plans: Free $0 / 200,000 credits (non-commercial only, no overage); Starter $20 / 1M; Standard $80 / 7.5M; Professional $250 / 25M. Routing, Map Matching and Trace Attributes cost 20 credits per request | Forward, reverse and autocomplete v1: 20 credits per request. Autocomplete v2: 1 credit. Place details: 20 credits | **Yes**: Valhalla-based `trace_attributes` (same API the app already uses) | Temporary storage on all plans. Permanent storage on Standard and above, per Stadia's own page ([learn page](https://stadiamaps.com/learn/best-geocoding-api/)); the ToS section 8 text itself is **UNVERIFIED** | No map lock-in found. Web apps can authenticate by domain with no key in code ([auth docs](https://docs.stadiamaps.com/authentication/)). Whether a `github.io` subdomain is accepted is **UNVERIFIED** |
| **Geoapify** ([pricing](https://www.geoapify.com/pricing/), [terms](https://www.geoapify.com/term-and-conditions/)) | Free: 3,000 credits per day, commercial use allowed within limits. Paid: $59 / 10k per day ... $299 / 100k per day. 1 credit per simple routing or geocoding request | 1 credit per request | **Yes**: `details=route_details` returns `speed_limit` per step, at higher credit cost ([docs](https://apidocs.geoapify.com/docs/routing/)) | No caching clause found in the terms (**UNVERIFIED**). Data is OSM (ODbL) | Geoapify and OSM attribution are mandatory on Free |
| **OpenRouteService** ([plans](https://openrouteservice.org/plans/), 404 on 2026-10-28; search snippet) | Free Standard tier: directions 2,000 per day and 40 per minute; "commercial use not allowed"; commercial access by enquiry | Geocoding: Pelias-based, quota on the same page | **No**: `extra_info` has no maxspeed ([docs](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/)) | OSM data (ODbL) | None |
| **Apple MapKit / MapKit JS / Maps Server API** ([MapKit JS](https://developer.apple.com/maps/web/), [Server API](https://developer.apple.com/documentation/applemapsserverapi), [DPLA Attachment 6](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/)) | Free with the $99 per year Developer Program. MapKit JS: 250,000 map views per day and 25,000 service calls per day. Server API: "up to 25,000 service calls per day per team between Apple Maps Server API and MapKit JS", then HTTP 429. On-device MKDirections has no published quota | Search, autocomplete, geocode, reverse geocode, place lookup and ETAs; same quota | **No** public speed limit field (**UNVERIFIED** for the newest SDK) | **No**. 2.2: no use as part of "any secondary or derived database". 2.5: caching only "temporary and limited" | 2.4: Apple data displayed on a map only on an Apple map, and "You may not surface Map Data ... without displaying the corresponding Apple map". 1.1: websites may use MapKit JS or the Server API. A MapKit JS token can be domain-restricted with "No Expiration", so a static GitHub Pages site needs no server ([token docs](https://developer.apple.com/documentation/mapkitjs/creating-a-maps-token)) |

### 2.2 Self-hosted engines (OpenStreetMap data, ODbL; you may store your own outputs, subject to ODbL)

| Engine | License | maxspeed | US sizing (sources and estimates) |
|---|---|---|---|
| **OSRM** | BSD-2 | **No**: annotations are only `nodes, distance, duration, datasources, weight, speed`, where `speed` is distance divided by duration ([API docs](https://project-osrm.org/docs/v5.24.0/api/)) | Planet car profile (Nov 2021, v5.26): extract 415 GiB, MLD partition 220 GiB, customize 174 GiB, about 300 GB of final files, "around 123 GiB of RAM" to serve; sizes "scale roughly linear with input data size" ([wiki](https://github.com/Project-OSRM/osrm-backend/wiki/Disk-and-Memory-Requirements)). US PBF is 11.4 GB, data through 2026-10-27 ([Geofabrik](https://download.geofabrik.de/north-america/us.html)), about 0.19 of the 61 GiB planet then. **Estimate**: about 23 GiB RAM to serve, about 80 GiB peak preprocessing disk, about 56 GB of files. Needs a 32 GB box |
| **Valhalla** | MIT | **Yes**: `trace_attributes` `edge.speed_limit` (what the app uses today); `admin_crossings` for per-state mileage | Tiles are about the size of the PBF (Estonia: 90 MB PBF gave an 87 MB tile tar, [marksblogg](https://tech.marksblogg.com/valhalla-isochrones.html)). **Estimate (UNVERIFIED)**: US tiles 10 to 20 GB without elevation; building needs 16 to 32 GB RAM with reduced `server_threads` ([docker-valhalla](https://github.com/nilsnolde/docker-valhalla): lower threads if the build is killed); serving from a memory-mapped tar works in 4 to 8 GB RAM |
| **GraphHopper** | Apache 2.0 | **Yes**: `details=max_speed` ([API](https://docs.graphhopper.com/openapi/routing/getroute)) | Planet import about 60 GB RAM (31 GB with MMAP), CH about 120 GB, LM about 80 GB; North America has 86M edges vs Europe's 150M (May 2022) ([deploy.md](https://github.com/graphhopper/graphhopper/blob/master/docs/core/deploy.md)). **Estimate**: US import 12 to 16 GB, CH about 24 GB |
| **Photon** (geocoder, search-as-you-type) | Apache 2.0 | n/a | Planet index about 95 GB, 64 GB RAM recommended for the planet ([README](https://github.com/komoot/photon)). A ready **US dump** exists: `photon-db-usa-1.0-latest.tar.bz2`, **10.6 GB** compressed, updated 2026-10-27 ([download server](https://download1.graphhopper.com/public/north-america/usa/)). **Estimate**: 25 to 35 GB unpacked, 8 to 16 GB RAM |
| **Pelias** | MIT | n/a | Planet: about 450 GB in Elasticsearch; importer 72 GB RAM in the example; PIP service 12 GB RAM, libpostal 3 GB RAM ([full planet notes](https://github.com/pelias/documentation/blob/master/full_planet_considerations.md)). Too heavy for a one-person project |
| **Nominatim** (self-hosted) | GPL | n/a | Planet: 128 GB RAM "strongly recommended", at least 1 TB disk, about 2.5 days to import ([install docs](https://nominatim.org/release-docs/latest/admin/Installation/)). US sizing **UNVERIFIED**. Photon is lighter |

**Monthly VPS prices** (2026-10-28, EUR excluding VAT; every Hetzner plan showed "currently unavailable" at the time, so check stock):

| Box | Spec | Price |
|---|---|---|
| Hetzner CX53 (EU only) | 16 shared vCPU, 32 GB, 320 GB | €29.99 ([link](https://www.hetzner.com/cloud/cost-optimized/)) |
| Hetzner CX43 (EU) | 8 vCPU, 16 GB, 160 GB | €16.49 |
| Hetzner CCX33 (US Ashburn / Hillsboro) | 8 dedicated vCPU, 32 GB, 240 GB, 3 TB traffic | €141.49 ([link](https://www.hetzner.com/cloud/general-purpose/)) |
| Hetzner CPX51 (US) | 16 vCPU, 32 GB, 360 GB | €238.49 ([link](https://www.hetzner.com/cloud/regular-performance/)) |
| Hetzner AX42 dedicated (EU) | 64 GB DDR5 ECC, 2 x 1.92 TB NVMe | from €79 plus €49 setup ([link](https://www.hetzner.com/dedicated-rootserver/matrix-ax/)) |
| DigitalOcean Memory-Optimized | 16 GiB / 32 GiB / 64 GiB | $84 / $168 / $336 ([link](https://www.digitalocean.com/pricing/droplets)) |

**Practical sizing**: one 32 GB box runs Valhalla (US) and Photon (US) side by side. Rebuild Valhalla tiles weekly or monthly on the same box with fewer threads, or on a short-lived hourly machine.

### 2.3 Which give speed limits, and which allow storing route geometry

* **Speed limits**: Mapbox (beta annotation), HERE (`spans`, Speed Limits API), TomTom (`sectionType=speedLimit`, Snap to Roads), Stadia, Geoapify, and self-hosted Valhalla and GraphHopper. **No** speed limits: OSRM, OpenRouteService, Apple, and Google Routes (Google's Roads Speed Limits needs an Asset Tracking license).
* **Storable route geometry**: self-hosted OSRM, Valhalla and GraphHopper (your output from ODbL data: attribute OSM and share-alike any derived database you distribute), Stadia Standard and above per Stadia, and Geoapify (OSM data; terms silent, **UNVERIFIED**).
* **Not storable**: Mapbox (navigation results never; geocodes only via Permanent), Google (latitude and longitude for 30 days only, place IDs indefinitely), Apple (temporary only, no derived database).
* **UNVERIFIED**: HERE routing and TomTom.

### 2.4 Recommended stacks and projected cost

**Usage model for (b)**, an assumption to adjust: 10,000 MAU, each planning 2 trips a month, with 1 route plus 3 recalculations per trip.

| Item | Monthly volume |
|---|---|
| Routes | 80,000 |
| Speed-limit chunks (20,000 trips x 5) | 100,000 |
| Place searches (8 per MAU, about 640,000 keystroke-autocomplete calls) | 80,000 |
| Gas station price views (10 per MAU) | 100,000 |
| Charger queries | 20,000 |

**(a) Free personal web app, a few users, non-commercial: about $0 per month**

* Map: keep the offline SVG map. MapKit JS with a domain-restricted, non-expiring token is a free upgrade if a real basemap is wanted. Apple routing and search results then have to be shown with that Apple map and not stored.
* Routing, speed limits and search, with two choices:
  1. Keep OSRM, Nominatim and FOSSGIS Valhalla, which stay within policy at this scale, and add:
     * a remote kill-switch JSON on Pages that can switch each service off;
     * a client cache for repeat searches;
     * an `X-Client-Id` header plus an announcement in Valhalla Discussions;
     * the OSM attribution and "fix the map" link.
  2. Better: **Stadia Maps Free**, which uses one vendor, needs no key in code (domain auth) and allows autocomplete. Example month: 3,000 routes (60k credits) + 3,000 trace_attributes (60k) + 2,000 searches (40k) = 160k of the 200k free credits.
* EV: AFDC with a free registered key held in a **Cloudflare Worker** (free plan), cached with the Cache API.
* Alerts: NWS called directly from the browser. CORS is open (`access-control-allow-origin: *`, `max-age=5`, checked 2026-10-28).
* Gas: keep the driver's own Google key, with the fixes listed in section 3.

**(b) Public App Store app, 10,000 MAU (recommended: MapKit display plus self-hosted OSM routing): about $140 to $270 per month, plus a fuel price licence (quote only)**

| Component | Choice | Monthly cost |
|---|---|---|
| Map display | MapKit (iOS, CarPlay) and MapKit JS (web) | Developer Program $99/yr, about $8 |
| Routing, speed limits, storable geometry, per-state miles, offline reroute data | Self-hosted **Valhalla US** | Shared box below |
| Search and autocomplete | Self-hosted **Photon US** (results are ODbL, storable). On iOS, MKLocalSearch is a free alternative, but its coordinates can't be stored beyond temporary use and must be shown with an Apple map | Shared box below |
| Server | One 32 GB box: Hetzner CX53 EU €29.99 (adds about 100 ms latency from the US) or CCX33 US €141.49 | About €30 to €141 |
| Gateway, cache, budgets | Cloudflare Workers Paid | $5 |
| EV chargers | AFDC daily bulk download into D1 or R2 | $0 |
| Alerts | NWS + WZDx (+ 511 with written permission) | $0 |
| Gas prices (display) | Google **Places UI Kit** Place Details (full view shows gas prices; allowed next to a non-Google map): 100k loads, 10k free, then $1.00 per 1,000 | About $90 |
| Gas prices (data for "cheapest ahead" logic) | OPIS / TomTom Fuel Prices / HERE Fuel Prices / iExit | Quote, **UNVERIFIED** |

**Managed alternative for (b)**: Stadia Standard at $80 replaces the server.

| Stadia credits | Credits |
|---|---|
| Routes, 80k x 20 | 1.6M |
| trace_attributes, 100k x 20 | 2.0M |
| Autocomplete v2, 640k x 1 | 0.64M |
| Place lookups, 80k x 20 | 1.6M |
| **Total** | **about 5.8M of the 7.5M included** |

That puts the managed alternative at about $185 per month plus the fuel licence. It needs the smallest code change, because the app already speaks the Valhalla API.

**Not recommended for (b)**:

* **Google**: about $350 for routes, $350 to $2,400 for search, and about $3,960 for `fuelOptions` via Nearby Search at 100k views. It also requires a Google map, which conflicts with MapKit and CarPlay, and offers no speed limits.
* **Mapbox**: cheapest on paper for the web (within free tiers), but results can't be stored, latitude and longitude can't be shown, and the mobile-SDK exclusivity clause applies on iOS.
* **HERE**: per-keystroke Autosuggest would cost about $1,850 per month.

**Interpretation**: avoid sending Apple-computed route coordinates to Valhalla to get OSM speed limits. DPLA 2.2 and 2.3 bar use in a "secondary or derived database" and use "for the purpose of improving or creating another mapping service". Compute the OSM route separately and use Apple only for display and ETA.

---

## 3. Gas prices: licensing options (no scraping)

| Source | Facts | Redistribution in ExitAtlas |
|---|---|---|
| **Google Places API (New) `fuelOptions`** | Billed as Nearby Search Enterprise + Atmosphere ($40.00 per 1,000 after 1,000 free) or Place Details Enterprise + Atmosphere ($25.00) ([data fields](https://developers.google.com/maps/documentation/places/web-service/data-fields), [pricing](https://developers.google.com/maps/billing-and-pricing/pricing)). | See the Google points below the table. |
| **Google Places UI Kit** | SST 15.1: "Customer may use Places UI Kit in Customer Applications with or without any map, including a non-Google Map. This clause will prevail over the No Use with Non-Google Maps clause." The iOS Place Details full view shows "Type-specific highlights, such as gas prices for gas stations" ([docs](https://developers.google.com/maps/documentation/places/ios-sdk/place-details-ui-kit)). Billed per request as "Places UI Kit Query", "regardless of what fields are displayed": 10,000 free, then $1.00 per 1,000 ([SKU details](https://developers.google.com/maps/billing-and-pricing/sku-details)). A JavaScript Place Details Element exists; whether it shows fuel prices is **UNVERIFIED**. | The cheapest legitimate way to show per-station prices beside an Apple map. You cannot extract the numbers for your own "cheapest" ranking (3.2.3(a) no scraping). |
| **OPIS** (Dow Jones) | About 150,000 North American outlets; about 90% daily coverage, more than 95% within 48 hours. **OPISNAVX** serves navigation companies and automakers, delivered by API; customers include Google and Waze ([OPIS retail](https://www.opis.com/product/pricing/retail-fuel-prices/), [OPISNAVX](https://www.opis.com/product/pricing/retail-fuel-prices/opisnavx/)). | Contract. Price and display terms **UNVERIFIED**; request a quote. |
| **TomTom Fuel Prices API** | Covers the USA with "detailed data"; "not available as part of our free evaluation or Pay As You Grow (PAYG) offering", so contact sales ([coverage](https://docs.tomtom.com/fuel-prices-api/documentation/product-information/market-coverage)). Updated every 10 minutes per the FAQ. | Contract; price **UNVERIFIED**. |
| **HERE Fuel Prices API v3** | Station prices within an area or along a route ([docs](https://docs.here.com/fuel-prices/docs)). Not in the Base Plan price list. | US coverage, price and terms **UNVERIFIED**. |
| **iExit API** | `fuel_prices` "only for gas stations with GasBuddy or OPIS price data", for paying licensees (repo doc 2.2). | Quote **UNVERIFIED**. |
| **GasBuddy** | Terms effective 2026-04-24 forbid scraping, building a database, forwarding data "without the prior written consent of GasBuddy", and commercial exploitation ([terms](https://www.gasbuddy.com/disclaimer)). Owned by PDI Technologies since 2021; research access runs under PDI data-use policies ([Kilts Center](https://www.chicagobooth.edu/research/kilts/research-data/gasbuddy)). No public business API found. | Only with written consent from GasBuddy or PDI (**UNVERIFIED** whether they license to apps). |
| **AAA** | gasprices.aaa.com shows OPIS data; neither AAA nor OPIS grants a licence to users ([AAA about](https://gasprices.aaa.com/about/)). No public API. | No; go to OPIS. |
| **EIA (public domain)** | Weekly retail gasoline and diesel prices: US, PADD regions, 9 states (CA, CO, FL, MA, MN, NY, OH, TX, WA) and 10 cities; next release 2026-11-03 ([gasdiesel](https://www.eia.gov/petroleum/gasdiesel/)). Free API ([opendata](https://www.eia.gov/opendata/)). "U.S. government publications are in the public domain"; cite "Source: U.S. Energy Information Administration (date)" ([reuse policy](https://www.eia.gov/about/copyrights_reuse.php)). | Yes, free, as a regional "typical price" fallback. Not station-level. |
| **State data** | No US state open-data mandate for station-level prices was found (Queensland, NSW and the UK's 2025 Motor Fuel Price (Open Data) Regulations are the non-US models). NY: NYSERDA weekly averages by region on data.ny.gov, derived from AAA ([catalog](https://catalog.data.gov/dataset/gasoline-retail-prices-weekly-average-by-region-beginning-january-2017)). Indiana: the Attorney General's "IN Fuel Watch" portal (April 2026, about 4,600 stations); vendor, API and reuse terms **UNVERIFIED** ([news](https://www.953mnc.com/2026/04/29/indiana-ag-launches-online-public-portal-to-track-gas-prices/)). | NY reuse **UNVERIFIED** (the underlying data is AAA's). Indiana: ask the AG's office. |

**Google `fuelOptions` specifics**

* **Calling from a server with the developer's key**: allowed. Places API (New) is a web service, and Google recommends IP-restricted keys and a proxy for browser use: "Don't allow clients to relay arbitrary API calls using the proxy" and "Always require authentication for client access to the proxy servers" ([security best practices](https://developers.google.com/maps/api-security-best-practices)). You may not resell or redistribute the Services themselves (3.2.1(b)).
* **Caching**: not allowed, apart from place IDs (indefinitely) and latitude/longitude (30 days, SST 14.3). Terms 3.2.3(b) say "No Caching"; the [Places policies (updated 2026-10-27)](https://developers.google.com/maps/documentation/places/web-service/policies) say not to "pre-fetch, cache, or store". A shared server cache of prices across users is therefore a violation. **Interpretation**: the web app's 15-minute in-memory reuse per user is a grey area. Keep only what is on screen.
* **Display**: Places content cannot be shown "with or near a non-Google Map" (3.2.3(e)(i), SST 14.2). **Interpretation**: the web app's own SVG route map counts as a non-Google map, so keep prices on a separate screen from it. When no map is shown, "Attribution should take the form of the Google Maps logo whenever possible"; the text "Google Maps" is acceptable when space is limited, and third-party providers must be named when Google supplies them.
* **App terms of service**: must reference the Google Maps Additional Terms and the Google Privacy Policy (3.2.2(a)).
* **Directory clause**: 3.2.3(d)(iii) bars use "in a listings or directory service". **Interpretation**: an exit directory built on Google place data is a risk worth asking counsel about.
* **Driver's own key (current model)**: lawful, because each driver is their own Customer and bears their own billing.

---

## 4. Traffic, closures and hazards

| Source | Access and terms | Use in ExitAtlas |
|---|---|---|
| **NWS `api.weather.gov`** | "Open data, free to use for any purpose", no fee. A User-Agent is required ("to identify your application"). The rate limit is unpublished ("generous"); exceeding it gives an error that typically clears in 5 s, and "proxies are more likely to hit the limit" ([docs](https://www.weather.gov/documentation/services-web-api)). CORS `*`, `cache-control max-age=5` (checked 2026-10-28). | Browser: query `alerts/active?point=` directly. Backend: poll `/alerts/active` once a minute and fan out by route. Use county codes or points, not zones only (repo note). |
| **USDOT WZDx / CWZ feeds** | The registry lists 43 feeds, 42 active, 14 of them needing an API key; it was updated 2026-10-23 and is licensed "Public Domain U.S. Government" ([registry](https://datahub.transportation.gov/d/69qe-yiui), API `resource/69qe-yiui.json`). Active publishers: AZ (Maricopa County), CA (MTC Bay Area only), CO, DE, FL, HI, ID, IL (IDOT and Tollway), IN, IA, KS, KY, LA, MD, MA, MI, MN, MS, MO, NH/VT/ME, NJ, NM, NY, NC, ND, OH, OK, OR, PA (Turnpike only), TX (TxDOT and Austin), UT, VA, WA, WI, and the National Park Service. **No GA or SC feed.** Each feed's own terms vary; key-gated feeds have their own sign-up terms (**UNVERIFIED** per feed). | Backend job pulls each feed at its stated cadence (1 to 60 min) and caches it, then filters to the route corridor. |
| **State 511 APIs** | Examples: 511GA needs a developer key and is throttled to "Ten calls every 60 seconds" ([doc](https://511ga.org/developers/doc)). Ohio OHGO allows, for example, "25 requests per second", can revoke "without cause or prior notice", is provided "AS IS", and is silent on redistribution ([terms](https://publicapi.ohgo.com/docs/terms-of-use)). WSDOT needs an access code and its page is silent on commercial use ([API](https://wsdot.wa.gov/traffic/api/)). 511NY now renders as a JavaScript app, so its terms could not be read (**UNVERIFIED**). | Commercial redistribution is mostly unaddressed, so get written permission per state, then use a backend cache only. |
| **Waze for Cities** | "You can apply for Waze for Cities if you represent a government agency or a private road operator" ([Google support](https://support.google.com/waze/partners/answer/10453062?hl=en)). Data use is governed by partner T&C. Older reporting says cities agree never to make the data public ([Route Fifty 2018](https://route-fifty.com/digital-government/2018/12/how-waze-partners-with-cities-on-data-sharing/303402)). | Not available to app developers. |
| **HERE Traffic** | Base Plan "Traffic" (flow and incidents): 5,000 free, then $2.92 per 1,000; Advanced Traffic: 2,500 free, then $5.83 ([pricing](https://www.here.com/get-started/pricing/supplemental-pricing)). | Display on non-HERE maps **UNVERIFIED**. |
| **TomTom Traffic** | Traffic Incidents details: 2,500 free per month. Flow segment data: 20,000 free ([pricing](https://docs.tomtom.com/pricing)). | Per-1,000 price and non-TomTom map display **UNVERIFIED**. |
| **Mapbox** | `driving-traffic` returns per-leg incidents. Mapbox Traffic Data may not be resold or re-syndicated (2.12). | Results can't be stored. |

---

## 5. Small backend for secrets, caching, rate limits and budgets

| Platform | Free tier (2026-10-28) | Paid entry | Notes |
|---|---|---|---|
| **Cloudflare Workers** ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | 100,000 requests per day; 10 ms CPU per invocation. KV: 100k reads and **1,000 writes** per day, 1 GB. D1: 5M rows read and 100k rows written per day, 5 GB. Durable Objects (SQLite-backed): 100k requests per day | $5 per month minimum: 10M requests, then $0.30 per million; KV 1M writes; D1 50M writes | Best fit. Secrets via `wrangler secret`. Rate Limiting binding: periods of 10 or 60 s, keyed by user ID; counts are "per Cloudflare location" and approximate. For strict limits, use a Durable Object counter ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)) |
| **Vercel** ([pricing](https://vercel.com/pricing)) | Hobby: 1M function invocations, 4 h active CPU, 100 GB transfer; "personal, non-commercial use" only; no overage | Pro $20 per month | Hobby is not allowed for a commercial App Store app |
| **Supabase** ([pricing](https://supabase.com/pricing)) | 500 MB database, 50k MAU auth, 500k edge function invocations, 5 GB egress; "paused after 1 week of inactivity"; 2 active projects | Pro from $25 per month (2M invocations) | Useful if accounts and synced trips are needed; the pausing makes the free tier unsuitable as an API gateway |
| **Fly.io** ([pricing](https://docs.fly.io/about/pricing)) | No free tier for new organisations; trial of 2 machine-hours or 7 days | shared-cpu-1x: 256 MB $2.19, 512 MB $3.69, 1 GB $6.70 per month | Fine for a tiny proxy; too small for Valhalla or Photon |

### Recommended design (Cloudflare Worker in front of everything)

1. **Keys never ship to clients.** Upstream keys live in Worker secrets: AFDC, Stadia, Google server key (IP-restricted), and 511 keys. The Worker builds each upstream request itself and never forwards arbitrary URLs (Google's proxy guidance).
2. **Client authentication.**
   * iOS: Apple **App Attest** (DeviceCheck) proves a genuine app instance; the Worker then issues a short-lived signed token.
   * Web: Cloudflare **Turnstile** challenge, then a signed session token. Domain checks alone (Origin/Referer) are spoofable outside browsers.
   * Existence and pricing of both services as of 2026-10: **UNVERIFIED** (not re-checked in this pass).
3. **Per-user rate limits.**
   * The Rate Limiting binding keyed by `userId:route` handles bursts (for example, 10 route requests per 60 s).
   * A Durable Object or D1 counter enforces daily quotas per user and per SKU (for example, 30 routes, 50 searches and 20 gas-card loads per day).
4. **Budgets.**
   * D1 table `usage(day, sku, count)`, with a hard monthly cap per SKU and a global kill switch that degrades gracefully (hide prices, fall back to cached OSM data).
   * Provider-side limits as well, such as Google Cloud per-day quotas via "Capping API usage" ([docs](https://docs.cloud.google.com/apis/docs/capping-api-usage)). Quotas cap volume, not spend; budgets only alert.
5. **Caching, by licence.**
   * Self-hosted OSM results (Valhalla, Photon): cache freely, with ODbL attribution.
   * NWS: 60 s.
   * WZDx: at each feed's cadence.
   * AFDC: a daily snapshot.
   * Google content: never cached apart from place IDs, and latitude/longitude for at most 30 days.
   * Mapbox and Apple: none.
   * Free-plan KV allows only 1,000 writes per day, so use the Cache API (per data centre) or D1 for hot caches.
6. **Bring-your-own Google key on the web** stays client-side, so the Worker never sees the driver's key. Tell users to restrict it to Places API (New) and set a daily quota.

---

## 6. Trademark and legal

### Interstate shield

**Registered service mark: verified**

| Field | Value |
|---|---|
| Registration | US Reg. **835,635**, registered 1967-09-19, International Class 42 |
| Owner | American Association of State Highway and Transportation Officials, Inc. |
| Services | "establishment of a marking system of the routes comprising the National System of Interstate and Defense Highways" |
| Disclaimer | The word "INTERSTATE" is disclaimed apart from the mark |
| Status | LIVE; third renewal accepted 2017-10-11 |

Source: [USPTO TSDR](https://tsdr.uspto.gov/statusview/rn0835635). History: [FHWA](https://highways.dot.gov/history/interstate-system/50th-anniversary/shields-and-signs).

The MUTCD 11th Edition §1D.06 confirms the exception: "Traffic control devices contained in this Manual shall not be protected by a patent, trademark, or copyright, except for the Interstate Shield, 511 Travel Information pictograph, National Scenic Byway graphic, and any items under the stewardship of or owned by FHWA" ([MUTCD Part 1 PDF](https://mutcd.fhwa.dot.gov/pdfs/11th_Edition/part1.pdf)).

**What AASHTO allows for maps and navigation apps: UNVERIFIED.** No AASHTO policy page was found. A 2006 news report (secondary, blocked on fetch) says AASHTO permits use "when compensated" and has sent cease-and-desist letters to businesses using shield-like logos.

**Interpretation**: showing the shield only to label the actual Interstate route on a map or in exit lists is the use the mark exists for, and it is universal in navigation products, so the risk is low. Using it in the app icon, name, logo, marketing or merchandise is high risk. Before App Store launch, email AASHTO for written permission. A fallback is a neutral route badge ("I-95" in a rounded rectangle).

### US Route shields

* Not among the §1D.06 exceptions, so as an MUTCD device they are public domain.
* No trademark registration found. A USPTO search was not run, so this is **UNVERIFIED**.
* State route shield designs: copyright status of state-government works varies by state (**UNVERIFIED**). Drawing them from MUTCD and state sign specifications is common practice.

### MUTCD sign colors

* Color specifications are public (tolerances in 23 CFR 655, Subpart F appendix, per MUTCD §1D.05).
* §1D.06(01) puts device design provisions in the public domain.
* Using the standard green, blue and brown is fine.

### Fonts

* **FHWA Series ("Highway Gothic") and Clearview letterforms.** FHWA's report to Congress (note 24) says: "The FHWA has published the letter form details for both the Standard Alphabets and Clearview letters, which are in the public domain ... including for use as an electronic font, and including for the purpose of selling the electronic font on the open market" ([FHWA IA-5 report ch. 5](https://mutcd.fhwa.dot.gov/resources/interim_approval/ia5rptcongress/ch5.htm)).
* **Digital font files.** Each file carries its maker's licence:
  * Commercial "Interstate" (Font Bureau) needs a licence.
  * Community "Roadgeek" fonts have an unclear licence (**UNVERIFIED**).
  * The Clearview font software is sold by its owners. The same report records a cease-and-desist sent to a vendor selling Clearview, and a state DOT paying about $525 per workstation.
  * The Clearview vendor site (clearviewhwy.com) could not be resolved from this session; it must be allowed in the session's network settings to check current licence terms.
* **Clearview's status.** Interim Approval IA-5 was terminated in 2016 and reinstated on 2018-03-28 for jurisdictions approved earlier ([FHWA](https://mutcd.fhwa.dot.gov/resources/interim_approval/ia5rptcongress/exec_summary.htm)). It is not the default MUTCD alphabet.
* **Open alternative: Overpass** (Red Hat, by Delve Fonts, "Inspired by Highway Gothic"). Dual licensed under SIL OFL 1.1 and LGPL 2.1, and available on Google Fonts ([repo](https://github.com/RedHatOfficial/Overpass)). Bundle the OFL text in the app.

### Brand logos of gas stations and restaurants

* **Word marks: nominative fair use.**
  * Under the 9th Circuit *New Kids on the Block* test, the product must not be readily identifiable without the mark, only as much of the mark as necessary may be used ("e.g. the words but not the font or symbol"), and nothing may suggest sponsorship ([Nominative use](https://en.wikipedia.org/wiki/Nominative_use)). Circuits differ: the 5th Circuit requires two of the three factors, and the 3rd Circuit treats it as an affirmative defense ([Kilpatrick Townsend](https://ktslaw.com/insights/alert/2017/1/circuit-split-remains-scotus-passes-on-defining-nominative-fair-use)).
  * Plain-text brand names ("Shell", "Waffle House") are the defensible default.
  * Logos usually go beyond "necessary".
* **App Store.** Guideline 5.2.1: "Don't use protected third-party material such as trademarks ... in your app without permission"; Apple can ask for authorization. Logos without written permission are therefore an App Review risk.
* **Google Places** returns no brand logos, only a generic category `iconMaskBaseUri` and `iconBackgroundColor` (Pro SKU). Photos come with author-attribution duties and cannot be cached.
* **Wikidata and Wikimedia Commons logos.** Wikidata's logo property points to Commons files, where copyright status is per file (often "below threshold"). Trademark rights are separate: the Commons "Trademarked" notice says "If you want to use it, you have to ensure that you have the legal right to do so" ([template](https://commons.wikimedia.org/wiki/Template:Trademarked)). Non-free logos on English Wikipedia are not reusable.
* **Logo APIs** (logo.dev, Brandfetch): their terms place trademark clearance on you (repo doc).
* **Recommendation**: text brand names plus a generic category icon. Add logos only after brands grant written permission. Also avoid copying brand colour schemes, which could be trade dress (**Interpretation**).

---

## Summary of recommendations

1. **Now**, while the app is personal or few-user:
   * Stay on the free public services, adding a remote kill switch, OSM attribution, and an `X-Client-Id` header plus an announcement for Valhalla.
   * Or move to Stadia Free for one compliant vendor with domain auth.
   * Move AFDC behind a free Cloudflare Worker with a registered key.
   * Fix the Google attribution (logo) and keep prices off the SVG map screen.
2. **Before App Store**: Cloudflare Worker gateway ($5) with App Attest or Turnstile, per-user quotas and SKU budgets. Run self-hosted Valhalla + Photon (US) on one 32 GB box (€30 to €141 per month), or Stadia Standard ($80). Use MapKit for display only.
3. **Gas**: Places UI Kit cards (about $90 per month at 100k views, allowed next to an Apple map), EIA averages as a free fallback, and quotes from OPIS, TomTom Fuel Prices, HERE and iExit for data that can drive ranking. Never GasBuddy or AAA without a contract.
4. **Hazards**: NWS + WZDx (free; no GA or SC feeds) now; state 511 only with written permission. Waze for Cities is closed to app developers.
5. **Legal**: the Interstate shield is a live AASHTO service mark (Reg. 835,635), so get written permission and keep it out of branding. US Route shields and MUTCD colors are public domain. Use Overpass (OFL) rather than Clearview. Show brand names as text, not logos.
