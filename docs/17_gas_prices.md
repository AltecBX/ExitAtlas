# 17. Gas prices at zero cost

Status, 2026-10-30: no free, authorized source of US station prices exists (full search and real Yonkers tests in 17.14), so stations show "Price unavailable" unless the owner turns on the optional Google Maps prices (17.8, needs a billing account). Built on the website and iOS; shared driver reports are written and tested on the Worker but not deployed.

The goal: compare station prices along the route before getting off the interstate (Shell, Pilot, Exxon, BP, Wawa and the rest), and pick the best value counting price, distance, detour, range and hours, without any paid service, any billing account, or any data used against its terms.

## 17.1 What the code had before (audit of main, 2b4b060)

| Piece | Where | What it did | What changed |
|---|---|---|---|
| Google Places prices | `web/js/app/prices.js`, `App/ExitAtlas/Services/GasPriceService.swift` | Nearby Search with `fuelOptions`, the driver's own Google key or the owner's proxy; looked up automatically for the fuel stop exits whenever a key was stored | Off by default (`profile.prices.google = false`), never called automatically: only when the driver turns it on and taps "Check Google Maps prices" for an exit. Prices stay in memory, are never stored, and never go into shared reports. |
| Price in SmartStop | `engine/smartstop.js`, `SmartStop.swift` | A raw Google price on a candidate, used only when "cheaper fuel over favorite brands" was on | A current reported price with its payment kind, time and source; the total cost of a fill; a cheaper stop note (17.6). |
| Fuel planner | `engine/fuel.js`, `FuelPlanner.swift` | Range, buffer, favorite brands | Unchanged. |
| Key proxy | `infra/worker` | Google and NREL keys, KV budgets, WZDx pass through | Adds `/v1/price-reports` on D1 (17.5). The Google endpoint is unchanged and only used when the owner sets a key and the driver turns Google prices on. |
| Docs | `02_data_sources_and_licensing.md` | Google `fuelOptions` and iExit, OPIS as paid options; "drop prices older than 48 hours" | This document is the current price policy (24 hours by default, 17.4). |

Open pull requests checked for overlap: none touch prices.

## 17.2 Sources checked (2026-10-29)

[V] read in the primary source; [NV] not verified. Spot checked again by hand: the OSM counts, the EIA download, D1's limits and OpenFuel's terms.

| Source | Station prices | US coverage | Grades | Freshness | Format | Data license and reuse | Key and billing | Decision |
|---|---|---|---|---|---|---|---|---|
| [OpenFuel](https://www.openfuel.app/legal/terms) | Yes, driver reports | US; volume not published [NV] | 87, 89, 91, 93, diesel, E85 and others | Reports seen "within the last several hours" | No public API (only its own app backend) | §4: users grant "the public the same broad license" for prices; §7: the Service is licensed "for personal, non-commercial purposes"; §5: "If you want a research-scale extract of the public price database, contact us first" [V] | None | **Needs written permission** (ask support@openfuel.app for a feed and an explicit license). Not integrated. |
| [coatless-data/club-gas-prices](https://github.com/coatless-data/club-gas-prices) | Yes, Costco and Sam's Club | 589 Costco and 531 Sam's Club US stations (29 Oct capture) | Regular, premium, diesel (mid at Sam's) | 4 captures a day | GitHub releases | Code MIT; "The data files carry no license claim"; collected from the retailers' sites, and [Costco's terms](https://www.costco.com/f/-/terms-and-conditions-of-use) forbid "data mining, robots ... to scrape or extract data" without written consent [V] | None | **Excluded**: a free scraper is not a reusable data source. |
| [Pumperly](https://geiserx.github.io/Pumperly/data/coverage/) | Not in the US | "The United States has no fuel prices" [V] | n/a | n/a | REST | Code AGPL 3.0; hosted data terms not stated | None | **Excluded** for the US. |
| OpenStreetMap | Stations yes, prices no | 110,550 `amenity=fuel`; the key `price` on 6 objects in the whole US ([taginfo](https://taginfo.geofabrik.de/north-america:us/api/4/keys/all?query=price), data to 28 Oct) [V, rechecked] | Fuel types only | Live edits | Dumps, API | ODbL 1.0 | None | **Used for stations** (already in the app, with attribution). No US prices. ExitAtlas reports keyed by OSM ids stay a separate dataset ([OSMF collective database guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)). |
| [Open Prices](https://prices.openfoodfacts.org) | No fuel | 0 fuel prices; its units are per item or kilogram [V] | n/a | Daily dumps | REST, JSONL | ODbL | Read: none | **Excluded** (no data). |
| [US EIA](https://www.eia.gov/petroleum/gasdiesel/) | No: regional averages | US, PADD 1A, 1B, 1C, 2 to 5, 9 states, 10 cities | Regular, mid, premium, diesel | Weekly, Monday 8 AM, published Tuesday | API v2 (free key), XLS and an RSS summary without a key ([RSS](https://www.eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml), 2.5 KB, rechecked) | Public domain; attribution with the date requested ([EIA](https://www.eia.gov/about/copyrights_reuse.php)) | None | **Used as context only** (17.7), never as a station's price. |
| NYSERDA weekly averages | No: metro averages | NY and 16 metros | Regular | Weekly | Socrata | Sourced from the AAA Daily Fuel Gauge (OPIS) | None | Not used (third party data; EIA covers the need). |
| AAA / OPIS | Averages on the site; stations under contract | National | All | Daily | Web | "personal, non-commercial use only" ([AAA](https://gasprices.aaa.com/about-aaa/)) | Contract | **Excluded**. |
| GasBuddy | Yes | National | All | Live | No public license | Terms prohibit automated collection and reuse | Contract | **Excluded**; no unofficial endpoints, no scrapers, no paid Apify actors. |
| [Love's Store & Fuel Prices API](https://developer.loves.com/) | Yes, Love's only | Love's stores | Not stated | Not stated | REST, OAuth | Access through a Love's sales representative; reuse terms not stated [V] | By request; fees not stated | **Needs written permission**. |
| Other retailer sites (Costco, Sheetz, QuikTrip, BP; Wawa, Pilot, Shell, Exxon terms not readable) | Their own stations | Their own | Varies | Varies | Web only | Terms read prohibit scraping or non personal use [V where read] | n/a | **Excluded**. |
| State and city open data | None found with station prices [NV, search] | | | | | | | Nothing to integrate. |

**Verdict.** No source is free, legally reusable, station level and nationwide. So:

* Integrated now: the driver's own reports (on the device), optional shared reports from ExitAtlas drivers (17.5), OSM stations (already in the app), EIA weekly averages as context.
* Needs written permission before any code: OpenFuel, Love's.
* Excluded: club-gas-prices data, GasBuddy, AAA and OPIS, retailer sites, Pumperly and Open Prices for US fuel.
* Google Maps prices stay an option the driver pays for with their own key, off by default (17.8).

## 17.3 The engine (`web/js/engine/gasprices.js`, `Sources/ExitAtlasCore/Planning/GasPrices.swift`)

One record per observed price: station id, location (from the station, not the reporter), brand, grade (Regular, Midgrade, Premium, Diesel), price in dollars per gallon, currency, payment (cash, credit, or not said), member or loyalty price (kept separate), the time it was seen, the reporter (opaque), and the source `{id, name, kind: own | community | open | google | simulated}`.

* Checks on every report: a grade, a price from $1.50 to $9.99 (rounded to a tenth of a cent), cash or credit or none, a time not in the future and not older than 7 days, and, when a regional average is known, within 50% of it.
* Grades are never compared with each other. The grade is the driver's setting, else the vehicle's EPA fuel type.
* One price per station and grade: the latest current report; the driver's payment kind first, then "not said", then the other kind (labeled "cash price"). Other current reports of the same price count as confirmations; a current report more than $0.10 apart is a conflict ("reports differ").
* A repeat of the same price within 30 minutes is the same report; the same reporter's new price within 30 minutes replaces theirs (a correction).

Tests: `Tests/ExitAtlasCoreTests/Fixtures/prices/cases.json`, one set of SIMULATED fixtures run by both `web/tests/gasprices.test.js` and `GasPricesTests.swift`.

## 17.4 Freshness

| Age | Shown | Compared |
|---|---|---|
| Up to the driver's limit (24 hours by default; 6 or 12 in Settings) | "Reported 18 minutes ago", "Reported 3 hours ago" | Yes |
| Past the limit, up to 7 days | Greyed, "Reported yesterday · old, not compared" | Never: it cannot be the cheapest or win a ranking |
| Past 7 days | Not shown | Dropped |
| No report | "Price unavailable" | Sorts after every current price |

A report is never called live or verified: the app says "Prices are reports with their time and source, not verified pump prices." Tapping a station shows each price's source, payment kind and time.

## 17.5 Reporting prices

**Removed from the app on 2026-10-30, at Jerry's request** (17.14): no Report a price button or form on the website or iPhone. Reports saved before still show with their time and source until they expire after 7 days, and can be deleted in Station details. The price book, the Worker's shared reports and their tests stay, so a licensed source can feed the same engine; the text below describes that code.

**On the device (no server, no account).** Station details or a station row, "Report a price": grade, price, credit or cash, member price. Saved in the browser (`ea.priceReports`) or the app; corrected or deleted for 30 minutes from Station details. No photo. If the phone is moving faster than about 10 mph, saving waits for "I'm a passenger".

**Shared (optional, off by default).** Only when the owner deploys the Worker with a D1 database and the driver turns "Shared driver reports" on.

* The app sends the station, grade, price, payment, member flag, a random install id, and `near: true`. The location check happens on the phone: one reading within 250 m of the station (accuracy better than 150 m); the position is never sent. Simulated GPS cannot pass.
* The server stores a salted hash of the install id and of the IP address (never the address), the station, grade, price, payment and time. It publishes a reporter id that is a hash of the install and the station, so one device's reports cannot be linked across stations. No names, profiles or social features.

**Abuse prevention (operational plan).**

| Risk | Control |
|---|---|
| Floods | Daily budgets: 2,000 reports for everyone, 20 per client (IP hash), 20 per install; 5,000 lookups a day. Over a budget the answer is 429 with the reset time, never a charge. |
| Typos and jokes | Price range and grade checks; refused when $0.50 or more from the median of three or more current reports by others. |
| Repeats and edits | Duplicates dropped; a correction within 30 minutes replaces the reporter's own report. |
| Old data | Reports deleted after 7 days; counters after 2. |
| Remote reports | Location check on the phone (an honest phone only; the budgets and the outlier check cover the rest). |
| Coordinated false reports at a station with no other reports | Shown with "ExitAtlas drivers", the time, and the number of confirming reports; a conflict is labeled. Residual risk: accepted for a free community source and disclosed. |
| Abuse found later | The owner can switch shared reports off for everyone (`DISABLED = "community"`, read through `/v1/config`) and delete rows by client hash with `wrangler d1 execute`. |
| Free limits reached | D1 refuses queries after its daily free limits; the Worker answers 503 and the app shows "Shared driver reports could not load", never "no prices". |

**Free plan limits** (checked 2026-10-29): Workers Free has 100,000 requests a day and 10 ms of CPU per request ([limits](https://developers.cloudflare.com/workers/platform/limits/)); D1 Free has 5 million rows read and 100,000 rows written a day, 5 GB, resetting at 00:00 UTC, and "When your account hits the daily read and/or write limits, you will not be able to run queries against D1" ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). The budgets keep the worst case at about 2.5 million rows read (5,000 lookups of at most 500 rows) and about 16,000 rows written (2,000 reports of about 8 writes), half or less of the free limits. Workers Free needs no payment method ("Start building for free — no credit card required", [workers.cloudflare.com](https://workers.cloudflare.com/)); going over a free limit fails the request (Error 1027 for Workers) rather than upgrading. Moving to Workers Paid is a separate step the owner would have to take; do not take it.

## 17.6 SmartStop with prices

* Total cost of a fill: gallons bought = tank size minus the fuel left on arrival (range at the stop divided by mpg); detour fuel = round trip detour miles divided by mpg, bought at the same pump. Cost = price times (gallons plus detour gallons). Labeled an estimate everywhere.
* A cheaper stop is mentioned when it saves at least the driver's minimum ($2 by default; $1, $3 or $5 in Settings) and at least $0.05 a gallon, for the same gallons, both prices current and of the same payment kind.
* It must be one the ranking kept: in range, inside the detour limit, with a restroom when one is required; overnight (12 to 4 AM by default) never one with worse listed hours or restroom confidence than the pick. Cheaper fuel never makes an out of range or closed stop the answer.
* The pick does not change and the favorite brands are not touched: "Cheaper stop: Wawa, Exit 212, 3 mi farther. $2.899 regular, reported 2 hours ago (ExitAtlas drivers). Estimate: about $2.20 less for a 12.6 gal fill, detour fuel included. Your Shell preference stays as it is."
* "Cheaper fuel over favorite brands" (an existing switch) still lets price rank above brand for drivers who want that.

## 17.7 Regional averages (EIA)

Weekly averages from the EIA's public domain summary appear only as context, for example "Lower Atlantic average, regular: $3.832 (EIA, week of Oct 26). Context only, never a station's price.", and as the sanity check on reports (a report more than 50% away is refused). They never fill a station's price, never rank a station, the week is always shown, and they are hidden once more than two weeks old. EIA publishes regular and diesel in this summary, so midgrade and premium have no context line. The EIA site sends no CORS header, so the Worker reads the summary (`/v1/fuel-benchmarks`, cached 6 hours; parser `parseEiaSummary` in `gasprices.js`).

## 17.8 Google Maps prices

Paid by whoever owns the key (Enterprise + Atmosphere tier). Off by default. With it on, the exits the driver is looking at are looked up without a tap (17.13); "Check Google Maps prices" looks up more. Each exit at most once an hour. Shown with Google Maps attribution in lists, never on the ExitAtlas map; held in memory for an hour only; never written to the device's reports or sent to the shared reports. Hours and the restroom field from the same lookup apply to those stations.

## 17.9 Settings (profile `prices` section, website and iOS)

`compare` (on), `payment` (credit), `maxAgeHours` (24), `tellCheaper` (on), `minSavingsDollars` (2), `ownReports` (on), `community` (off), `google` (off). Saved in the profile like every other setting; a profile from before gets these defaults and keeps its vehicles, Home, places, overnight settings and trip history (`web/tests/profile.test.js`, `ProfileTests`). Favorite brands and "Cheaper fuel over favorite brands" stay in the fuel section.

## 17.10 Where prices show

* Drive: the fuel card's pick with its price (or "price unavailable") and the cheaper stop note.
* Road Ahead, Fuel: the recommended stop, then Compare Prices: every station and fuel plaza in the window with brand, exit, miles, price, grade, age, hours at arrival, restroom and detour; sorted by Recommended, Lowest price, Closest, Shortest detour, or the first favorite ("Shell first"). A station the range left does not reach says "Beyond your range" and comes after every one it does, under every sort. Urgent alerts and gas gaps stay below.
* Fuel stop sheet: the pick's price, the note, a Prices button.
* Station details: every grade with its source, saved reports there (delete only), links to the station's posted price on Google Maps and GasBuddy (17.14), and Check Google Maps prices when that is on.
* Exit details: each gas station's price for the driver's grade.
* Settings: Gas prices and Price sources.

iOS: the engine, profile and SmartStop changes are shared and tested; the iOS screens (price lines, Compare Prices, report sheet, settings) follow in the next change, and `GasPriceService` follows the same off by default rule.

## 17.11 What is real, what is simulated, what is missing

* No station prices appear until someone reports one. On a first trip every station says "Price unavailable". That is the honest state of free US price data today.
* Shared reports need the owner to deploy the Worker with D1 (README in `infra/worker`); until then the switch says it is not set up.
* The EIA context line comes through the Worker, so it shows only once the Worker is deployed. Not tested against a deployed Worker; the parser is tested on the 10/26/26 release's format.
* Screenshots and layout checks use SIMULATED prices (`?demo&prices`), labeled "SIMULATED PRICES · test data, not real" and "SIMULATED test data" on every price. They are never stored.
* Proof of no paid calls: `web/tests/layout/prices.layout.mjs` stores a Google key, runs the price screens, and fails on any request to Google; `web/tests/services.test.js` checks that a stored key or the proxy alone never turns Google on; the Worker's price report tests fail if any outside fetch happens.

## 17.12 Why no prices appeared, and real station prices (2026-10-30)

**Why every station said "Price unavailable".** The comparison works; it had no data. On a fresh install there are no own reports, shared reports need the owner's server (not deployed), and Google Maps prices are off by default. No free, authorized feed fills that gap (below). Also, the Drive fuel card shows a price only for SmartStop's pick, which needs a range entered.

**Proof the price path works without any feed.** `web/tests/layout/pricepath.layout.mjs` and the iOS UI test `testPricePath` enter one TEST REPORT through Report a price at SmartStop's pick and check it in Drive, Road Ahead, Compare Prices, Station details and SmartStop's reasons; every other station stays "Price unavailable". This proves the app shows a price it has, not that a live feed exists.

**Bugs found and fixed.**
* The browser layout checks blocked outside requests with `page.route('https://**')`, which matches nothing in Playwright 1.63: the pages were online and the "no Google request" checks proved nothing. They now block with a URL test (`u.protocol === 'https:'`), record every blocked host, and fail on any Google request.
* Testing truly offline then showed the Drive map's "Map offline" note pushing the bottom panel into the right hand controls on a 375 by 667 screen. The note now sits under the speed sign.
* A shared report could take up to six minutes to reach other phones (a 60 second Worker cache plus a five minute re-ask). Lookups are no longer cached (the daily lookup budget already keeps D1 under its free limit) and the app re-asks after 90 seconds.
* The iOS app could not use shared reports at all: there was no client, and the Worker refused requests without a browser Origin. The app now names itself (`X-ExitAtlas-Client: ios/1`), shares and reads reports, with the same location check (its own GPS, within 250 m, never sent).

**Sources checked again for real, station level prices** ([V] read in the source):

| Source | Result |
|---|---|
| OpenFuel | No API, feed or export. Station pages are an app shell; prices load only from its Supabase backend, which may not be called. Terms §5: "If you want a research-scale extract of the public price database, contact us first"; §7 limits the Service to "personal, non-commercial purposes" [V]. Yonkers: one listing (BP, 594 Nepperhan Ave, E85), no price visible in its HTML [V]. Usable only with the operator's written permission; draft email below. |
| GitHub feeds (jacobschulman/gas-tracker, coatless-data/club-gas-prices, TravIR-Fuel-History, GasBuddy scrapers) | Every station level feed found collects from GasBuddy, Costco, Circle K, Sam's Club or Marathon. GasBuddy (terms effective Apr 24, 2026), Costco (Oct 7, 2026) and Circle K terms forbid it; gas-tracker is AAA state averages, which AAA's terms forbid reusing [V]. A repository's code license gives no rights to the data. Not used. |
| Public open data | No US state or city publishes station prices. NYSERDA (data.ny.gov) has weekly metro averages from AAA, latest week 2026-10-05; EIA has weekly averages (public domain). Open Prices: 0 fuel prices in New York; OpenStreetMap: 4,065 New York stations, 0 with a price [V]. |
| TomTom Fuel Prices | Station level, but "not available as part of our free evaluation or Pay As You Grow (PAYG) offering" [V]. Contract only. |
| HERE Fuel Prices | Billed from the first request [V]. Not $0. |
| Love's, OPIS, Barchart, GasBuddy data | Sales or contract only; GasBuddy offers no API or license and forbids scraping [V]. |
| Google Places (`fuelOptions`) | Station level with update times. Needs a Google Cloud billing account, so off unless Jerry approves (below). |

**Yonkers result.** No authorized $0 method returned a real Yonkers station price. Nothing in the app shows one until a driver reports it or Jerry approves the capped Google key.

**The one $0 option that returns real station prices, with Jerry's approval.** Google's Nearby Search with fuel prices bills as "Nearby Search Enterprise + Atmosphere", with 1,000 free requests a month. Google's own guidance: "To put a hard cap on usage of an API, lower its per-day quota" and "A daily limit of 32 keeps usage at or below 992 in any month" ([manage costs](https://developers.google.com/maps/billing-and-pricing/manage-costs)); budgets alone do not stop spending. With a daily quota of 30 (at most 930 a month) on a project used for nothing else, the bill stays $0. Each lookup covers the stations within 1 mile of one exit. In ExitAtlas: Settings, Gas prices, Google Maps prices on, paste the key; then Road Ahead, Fuel, "Check Google Maps prices for the next 3 exits", or Station details. Google's terms keep its data off non-Google maps, so a Google price never shows on the Drive screen (map); it shows in Road Ahead, Station details and the fuel sheet, with Google's name, and is never stored.

**Approved by Jerry on 2026-10-30: Google key with a 30 a day cap.** Pricing checked 2026-10-30: Nearby Search Enterprise + Atmosphere (which `fuelOptions` triggers) has a monthly free usage cap of 1,000, then $40 per 1,000 ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing), [Nearby Search fields](https://developers.google.com/maps/documentation/places/web-service/nearby-search)); daily quotas "reset at midnight Pacific time" and a budget "does not automatically cap" usage ([manage costs](https://developers.google.com/maps/billing-and-pricing/manage-costs)). The app matches the cap: at most 30 Google lookups a day per device (counted by the Pacific day; `GOOGLE_DAILY_LIMIT` in `web/js/app/prices.js`, `PriceCallCounter.dailyLimit` on iOS), Settings shows "Today: n of 30", and past the limit, or when Google answers 429 RESOURCE_EXHAUSTED, the lookup says the daily limit is reached instead of showing no prices. The Worker's `DAILY_PRICES` is 30 too. The project quota is the hard cap across devices. Setup (owner, in Google Cloud):
1. Create a project used only for ExitAtlas prices and link a billing account (Google requires one).
2. Enable Places API (New) only.
3. Google Maps Platform, Quotas: Places API (New), the per day quota for Nearby Search: Edit, 30. Check that it shows 30 before using the key.
4. Credentials: a website key restricted to `https://altecbx.github.io/*` and an iPhone key restricted to the bundle id `com.cobyconstruction.exitatlas`, both restricted to Places API (New). Both share the project's 30 a day.
5. Optional: a $1 budget with email alerts (alerts only, not a cap).
6. ExitAtlas, Settings, Gas prices: Google Maps prices on, paste the key. Then Road Ahead, Fuel, "Check Google Maps prices for the next 3 exits", or Station details.

**Check the posted price (no data copied).** Station details now link to the station on Google Maps (a documented Maps URLs search for the brand at the station's coordinates; checked to list the nearest station of that brand first, for example Shell at 1063 Yonkers Ave) and to GasBuddy's city price page (for example https://www.gasbuddy.com/gasprices/new-york/yonkers, found by one reverse lookup when the sheet opens; the state page when no city is known). The driver sees the posted price there and reports it in a few taps.

**Shared reports.** Tested on Cloudflare's own runtime (`wrangler dev` with a local D1): a report from one install is read by another, repeats are dropped, a report without the location check, an out of range price and other sites are refused (`infra/worker/scripts/smoke.mjs`, `web/tests/layout/share.layout.mjs`; both run in CI). Not deployed: deploying needs Jerry's Cloudflare account (README, "One click deploy").

**Request to OpenFuel (support@openfuel.app), sent by Jerry on 2026-10-30:**

> Hi Anthony, I'm Jerry, and I build ExitAtlas, a free, personal, non-commercial road trip planner (web and iOS). I'd like to show drivers recent gas prices along their route, and OpenFuel's community reports would be a great fit. Would you consider giving me a free, read-only feed or periodic extract of the public price reports? I would credit OpenFuel (and OpenStreetMap where station data is used) and link back to your station pages; keep to whatever rate limits or refresh schedule you set; and use the data only to display each price with its grade, report time and source, never resold or republished. I won't scrape the site or call your backend without your OK. Thanks for building OpenFuel. Jerry

## 17.13 Automatic Google Maps prices (2026-10-30)

Jerry will not report prices, so the price comparison has to fill itself. The only authorized source that returns current, station level prices is Google Places (17.12); with Google Maps prices on and a key set, ExitAtlas now looks prices up by itself.

**What is looked up, and when.** Google forbids pre-fetching ("You must not pre-fetch, cache, or store Places API content beyond the allowed exceptions", [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies)), so only exits on screen are looked up: Road Ahead with the Fuel filter, the fuel stop sheet, station details (and exit details on the website). Most relevant first: the sheet's own exit, SmartStop's pick and alternatives, then Road Ahead's stations in SmartStop's order (the favorite brand, Shell by default, first), then the nearest. The Drive screen asks nothing (Google prices never go on a non-Google map). Rules (`AUTO_LOOKUP_RULES` in `web/js/engine/gasprices.js`, `GasPrices.AutoLookupRules` in Swift, same tests on both):
* only the 4 most relevant exits are considered, chosen once per screen and every 5 miles of driving (`lookupCohort`, `GasPrices.LookupCohort`): Google's answers reorder the ranking (a station it lists closed at arrival drops out), so choosing again on every update would pull in exit after exit on one screen (found by the Codex review on #35);
* each exit once an hour; Google's answer is kept in memory for that hour and never saved;
* at most 24 a day without a tap, leaving 6 of the device's 30 for taps;
* re-checked as the driver moves (every half mile while a price screen is open on iOS; on each update on the website).

One lookup covers every station Google lists within 1 mile of the exit, so 4 lookups usually compare about 10 to 30 stations. Shown with the price, grade, Google's update time and "Google Maps" as the source; a station without one says "Price unavailable". SmartStop uses these prices for the cost of the fill, the detour fuel and the cheaper stop note, and never trades range, reserve, hours or restroom requirements for a lower price.

**Verified with a TEST FIXTURE only.** `web/tests/layout/autoprices.layout.mjs` (Google's API answered by made up prices in Google's format) and the iOS UI test `testAutoGooglePrices` (`-googleFixture`, labeled SIMULATED PRICES) check that nothing is asked with Google off or on the Drive screen, Road Ahead, Fuel looks up at most 4 exits by itself and shows them with their source, fresh exits are not asked again, SmartStop uses them, and the daily budget stops it. That proves the app's behavior, not that a live feed exists: no real Google price has been retrieved yet, because the key needs Jerry's Google Cloud project with billing (17.12, "Approved by Jerry"). The first real lookup near Yonkers is the remaining check.

**Coverage.** 24 automatic lookups a day are about two fuel decisions (each about 4 exits, refreshed once as the stop nears) plus station details. Which US stations Google has prices for is not verified until a real key runs; a station Google has no price for shows "Price unavailable".

**Other sources checked again on 2026-10-30.** No Azure Maps fuel price API was found. Gemini's Grounding with Google Maps is not in the Gemini free tier (5,000 a month on the paid tier, then $14 per 1,000) and returns prices only inside generated text, which could misstate a price; not used. API marketplaces (Zyla, Apify) sell GasBuddy scrapes or state averages; not used. OpenFuel still has no API; Jerry sent the request below for a free read only feed on 2026-10-30, no reply yet.

## 17.14 Free automatic prices: full search and real tests (2026-10-30)

Jerry's rules for this search: no paid API, no credit card or billing account, no trial that expires, no subscription, no allowance that becomes chargeable, nothing he has to report or confirm, no made up prices, no scraping or getting around access limits, and Shell first, vehicles and SmartStop kept as they are. Google Places (17.8, 17.13) needs a billing account and bills past 1,000 a month, so it fails rules 2 and 5; it stays off by default and optional, and is not the answer here.

**Result.** No source passes. Nothing returned a real price for a Yonkers station, or any I-95 station, through a free and authorized route. Every source of current US station prices is paid (Google, HERE, TomTom, OPIS, Barchart, GasBuddy licensing), contract or partner only (Love's, fleet cards), or a scrape of GasBuddy or a retailer, which their terms forbid. So nothing new is integrated, no adapter or GitHub Actions dataset is built (there is no licensed data to put in one), and no screen shows a price it does not have.

**Searched** ([V] read in the primary source, [NV] secondary or unreadable):

| Area | What was checked | Finding |
|---|---|---|
| Government | Every US state and city portal, Westchester County, EIA, NYSERDA, California, Hawaii, Washington, Puerto Rico, Indiana | One US program publishes station prices: [IN Fuel Watch](https://www.infuelwatch.com/) by the Indiana Attorney General (regular only, Indiana only, a CSV button, no license; "The OAG uses publicly available data for these metrics") [V]. Nothing for New York or any I-95 state. Westchester County sends consumers to GasBuddy and AAA ([county page](https://consumer.westchestercountyny.gov/consumer-information/find-lowest-gas-and-oil-prices)) [V]. EIA: "EIA does not have gasoline prices by county" [V]. Puerto Rico's registry is a pending bill [V]. |
| Open data | data.gov, Kaggle, Hugging Face, Zenodo, GitHub, Open Prices, OpenStreetMap, Wikidata, Overture | No current licensed US station prices. Open Prices: 136 fuel stations worldwide, 2 in the US [V, API]. OpenStreetMap: no fuel price key in use in the US, only 6 objects with `price` at all ([taginfo](https://taginfo.geofabrik.de/north-america:us/api/4/keys/all?query=price), data to Oct 29) [V]. GitHub and Hugging Face sets are GasBuddy scrapes or other countries [V]. |
| Map and data APIs | Apple MapKit, MapKit JS, Apple Maps Server API, Google (Places, Embed, Maps URLs), TomTom, HERE, MapQuest, Mapbox, Geoapify, Foursquare, Yelp, Azure, Kroger, NREL, fueleconomy.gov, CollectAPI, RapidAPI and Apify listings, OPIS, Barchart, Upside, iExit, Waze | Apple exposes no fuel prices: MKMapItem has no price field and Apple's place card "displays place information such as addresses and phone numbers" ([MKMapItemDetailViewController](https://developer.apple.com/documentation/mapkit/mkmapitemdetailviewcontroller)) [V]; no evidence Apple Maps shows US prices [NV]. TomTom: "not available as part of our free evaluation or Pay As You Grow (PAYG) offering" [V]. HERE: billed under its Base Plan [V]. Free APIs (fueleconomy.gov, EIA, CollectAPI) return averages [V, NV]. Marketplace "gas price APIs" resell GasBuddy scrapes [V]. Waze has no read API; its partner feed carries alerts and traffic, not prices ([Waze partners](https://support.google.com/waze/partners/answer/13458165)) [V]. |
| Retailers and truck stops | Love's, Pilot Flying J, TA and Petro, Road Ranger, Buc-ee's, Shell, ExxonMobil, Sunoco, Gulf, Citgo, Getty, Valero, 7-Eleven and Speedway, Circle K, Cumberland Farms, Wawa, Sheetz, QuikTrip, Murphy USA, Costco, Sam's Club, BJ's, Walmart, Kroger and Harris Teeter, Stewart's, fleet cards | None grants free automated reuse. [Love's Store & Fuel Prices API](https://developer.loves.com/ad47e8c2-fb2b-4eaf-9d61-099061f1cfaa/loves-store-fuel-price-exp-api/) returns station fuel prices, but access is by request: "contact your Love's sales representative or click on the 'Request Access' button"; no fees or data terms are stated [V]. TA's developer program has no fuel prices in its retail API [V]. The rest forbid robots or limit use to personal use, for example Sunoco ("any robot, spider or other automatic device"), Wawa ("screen scraping", "personal, non-commercial use only"), Cumberland Farms (only "published interfaces" unless a separate agreement) [V]. |
| Community networks | OpenFuel, Fuelio, Trucker Path, Mudflap, TruckSmarter, Upside, Waze, GasPriceWatch, Gas Guru, Bee Maps, open source apps | No public API with reuse rights. OpenFuel: still no API; §5 "contact us first"; Jerry's request (17.12) has no reply as of Oct 30 [V]. Others need written permission, are business partner only, are defunct, or sell credits [V, NV]. |

**Real tests, Yonkers** (stations from OpenStreetMap through Nominatim, ODbL; no request to any restricted service):

| Station (OSM id) | Address | Coordinates | Open Prices API | OSM price tags | Brand's own station page |
|---|---|---|---|---|---|
| Shell (node 11018157238) | Ashburton Ave, 10701 | 40.93905, -73.88573 | 0 prices | none | not checked |
| Shell (way 850477822) | Midland Ave, 10704 | 40.93630, -73.85667 | 0 | none | not checked |
| Shell (way 1412631480) | Bronx River Rd, 10708 | 40.90603, -73.85829 | 0 | none | not checked |
| Shell, tagged bp in OSM (way 1444376006) | 731 Central Park Ave, 10704 | 40.92633, -73.85850 | not checked | none | [find.shell.com](https://find.shell.com/us/fuel/10009822-731-central-park-avenue/en_US): no prices |
| BP (way 1463849063) | Yonkers Ave, 10701 | 40.93513, -73.88562 | 0 | none | not checked |
| BP (node 10716858637) | Pelton St, 10705 | 40.91427, -73.88984 | 0 | none | not checked |
| Mobil (way 1012806749) | 142 Tuckahoe Rd, 10710 | 40.95436, -73.86399 | 0 | none | [exxonmobilfuels.com](https://www.exxonmobilfuels.com/en/find-gas-station/mobil-yonkers-ny-tuckahoeroadmobil-200317659): fuels listed, no prices |
| Mobil (node 10717826422) | 838 Kimball Ave, 10704 | 40.92899, -73.84843 | 0 | none | not checked |
| Mobil (node 10206431769) | McLean Ave, 10705 | 40.91056, -73.88931 | 0 | none | not checked |
| Sunoco (node 2310485829) | 931 McLean Ave, 10704 | 40.90358, -73.86732 | 0 | none | [sunoco.com](https://www.sunoco.com/locations/store/931-mclean-ave-yonkers-ny-0505638700): no prices |
| 76 (way 1118730022) | 918 McLean Ave, 10704 | 40.90443, -73.86777 | 0 | none | not checked |
| Citgo (way 1447978017) | 95 Vredenburgh Ave, 10704 | 40.92373, -73.85559 | 0 | none | not checked |
| Global (node 6596749847) | 1800 Central Park Ave, 10710 | 40.96017, -73.84101 | 0 | none | not checked |

No Exxon branded station is mapped inside the Yonkers search area. Regular, premium and diesel prices, cash or credit, report times and permission: none, because no source returned a price. Brand pages were read once by hand to see whether a price exists; their terms forbid automated collection, so they cannot be a source either way.

**I-95.** The two sources that are free and legally reusable (Open Prices, OpenStreetMap) have no US fuel prices at all (counts above), so no I-95 station can return one. Every other source is excluded before a request is made.

**What the app does.** No change to prices: every station without a price from the optional Google key says "Price unavailable", is never ranked as cheaper, and EIA averages stay context only (17.7). Shell first, vehicles, SmartStop and the overnight rules are unchanged.

**Consumer pages (the fallback; a plain link, not price integration).** Station details already link to Google Maps and GasBuddy (17.12). Terms checked:
* Google Maps URLs: "You don't need a Google API key to use Maps URLs"; on iOS the URL opens the Google Maps app if installed, else a browser ([Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)) [V]. Google's consumer terms forbid copying the content and bulk feeds ([Google Maps terms](https://www.google.com/help/terms_maps/)) [V]; ExitAtlas reads nothing from the page.
* GasBuddy: its terms forbid users to "use, display, mirror or frame the Site" and to scrape fuel prices ([terms, effective Apr 24, 2026](https://www.gasbuddy.com/Disclaimer)) [V]. So GasBuddy is only ever a plain link that opens in the browser, never shown inside ExitAtlas.
* Waze: documented deep links (`https://waze.com/ul?ll=...`) need no key ([Waze deep links](https://developers.google.com/waze/deeplinks)) [V]; Waze shows its prices inside its own app only.
* No page is put in an iframe. Approved by Jerry on Oct 30 from a render, and built: Station details, "See the posted price". On iPhone, Google Maps opens in Apple's Safari view inside ExitAtlas (`SFSafariViewController`; Done returns to the station with the trip running), and GasBuddy opens in Safari. On the website both open in a new tab. Both are labeled "Consumer webpages, not ExitAtlas data"; the station keeps "Price unavailable". Report a price was removed at the same time (17.5). Whether Google's mobile web page shows the price for a given station is not verified here (automated viewing of Google Maps was not done). Checked by `web/tests/layout/prices.layout.mjs`, `pricepath.layout.mjs` and the iOS UI test `testPrices`.

**Strongest next steps (permission, not payment).**
1. OpenFuel: the only US community network that invites a data request; follow up on Jerry's Oct 30 email. Coverage near Yonkers is thin (one Yonkers listing seen in 17.12).
2. Love's: request free, non commercial access to the Store & Fuel Prices API (the "Request Access" button on its page). Love's stations only, none near Yonkers [NV].
3. Wawa and Cumberland Farms: written permission for their own station prices (many I-95 stations in NJ, PA, DE, MD, VA and FL; Cumberland Farms in the Northeast).
4. Watch: New York price transparency bills, Puerto Rico's registry, Indiana's program (ask about reuse only if a route crosses Indiana).

Any of these, once granted in writing, plugs into the existing price engine as one more source with its own name, time, grade and payment kind (17.3); until then nothing is integrated.

