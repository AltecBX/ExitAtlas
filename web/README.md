# ExitAtlas web

A browser version of ExitAtlas for using on a phone before the iOS app is installed. Same engine, ported from `Sources/ExitAtlasCore` to JavaScript, tested against the same route fixtures and oracles.

## What works

* Plan a route: place search (Nominatim), routing with stops and alternatives (OSRM demo server, OpenStreetMap data).
* Live GPS in Safari: state line card (next state, miles to the line, exits left, local crossing time), next exit with services, destination, arrival and states left.
* Exits ahead with state lines inline, category filters, exit detail with detours, find along route, gas ahead by fuel range, stop planner by drive time.
* Trip overview: offline SVG map by state, completed, current and upcoming states with local entry times.
* Automatic reroute when you leave the route; miles per state survive reroutes.
* Discovery mode: no destination, locks onto the interstate and direction you are driving.
* Vehicle picker: EPA fuel economy for every gasoline, diesel, hybrid and electric version since 2000 (all makes), tank size where verified (20 makes, 6,925 versions), otherwise entered once. Highway, combined or your own MPG.
* Fuel stop: enter the miles to empty from your dashboard (or the gauge). Range counts down as you drive; ExitAtlas picks the last interstate exit with gas that you reach with about your buffer left (25, 50, 75 or 100 mi), shows earlier options and the last gas before empty, and announces it.
* Dash: ring speedometer from GPS with the posted speed limit sign beside it (OpenStreetMap `maxspeed` via the public Valhalla server, fetched about every 50 miles), the next limit change within 2 miles, amber when over the limit and red when over by your threshold (Settings). Two column layout when the phone is mounted sideways.
* Favorite gas brands (Shell, Wawa, Buc-ee's and so on): the fuel stop picks the last exit with one of them that you reach with your buffer left, anywhere in range, and says so when none does.
* Live gas prices per station near each exit from Google Maps (Places API, Nearby Search with fuel options), using your own Google Maps Platform key entered in Settings: your favorite brand's price and the cheapest nearby, with the update time. Off without a key. Billed by Google at $40 per 1,000 lookups after 1,000 free a month (Enterprise + Atmosphere tier); ExitAtlas looks up one exit at a time, at most every 15 minutes, and counts lookups in Settings. Shown with Google Maps attribution, never on the map, never stored.
* Electric vehicles: EPA range for every EV since 2000; charging stops at Tesla Superchargers (or all DC fast chargers) within 2.5 miles of the route from the U.S. DOE Alternative Fuels Data Center, one request per route (demo key: 10 an hour; a free NREL key raises that). Range by miles or battery percent.
* Home and recent places: set Home from any search result; Home and recent places appear first when choosing a start, stop or destination, and on the Drive screen for one tap routing.
* Voice for state lines, exits and fuel stops, screen wake lock, light and dark mode.
* The trip is saved on the phone every 30 seconds and can be resumed after the page reloads, without a network connection.
* Offline data: states, time zones, 38,553 interstate exits and 22,468 exits on other freeways load once (about 24 MB) and are cached by a service worker.
* Simulated demo (Miami to Manhattan), clearly marked as a simulation.

## Limits of a web page on iPhone

* GPS stops when the screen locks or Safari is not in front. Keep the screen on (the app requests a wake lock; if that is not available, set Auto Lock to Never). Short gaps are dead reckoned and the trip catches up on return.
* Travel times start from OSRM road speeds, which are OpenStreetMap speed limits times 0.8 (OSRM car profile `speed_reduction = 0.8`; 90 km/h where no limit is mapped), so about 56 mph on a 70 mph interstate, and no live traffic. While you drive, the next 30 minutes of road follow your speed over the last few minutes (5 minute memory, moving time only), and later stretches blend into your trip pace and your usual pace from earlier trips. In simulation, driving 1.7 times the model speed, the next state line ETA error is 12% after 5 minutes, 8% after 10 and 3% after 20 on a first trip, and under 1% once your pace is learned from an earlier trip.
* Avoid tolls is not available on the OSRM demo server.
* Gas prices need your own Google Maps Platform key (Settings, Gas prices), or the URL of an ExitAtlas key proxy (`infra/worker`) that holds one. Without either, exits list their stations without prices.
* Routing and search need a connection. The demo server is for light personal use.

## Hosting

The page needs HTTPS (Safari only gives GPS to secure pages) and must be served together with the repository's `App/ExitAtlas/Resources/Data` folder.

* GitHub Pages (recommended, stable link): repository Settings, Pages, Build and deployment, Source "Deploy from a branch", branch with this code, folder "/ (root)". The app is then at `https://<owner>.github.io/ExitAtlas/web/`. The `.nojekyll` file at the root serves files as they are.
* Updates: the service worker serves the app from the set it precached for its version, so a phone sees a deploy only when `web/sw.js` changes. After changing any app file run `node web/tests/swhash.js --write` (it sets `APP_HASH`, which names the new version; `npm test` fails until it matches). Phones install the new version on their next visit online and show it from the load after.
* Immediate link with no setup: `https://rawcdn.githack.com/<owner>/ExitAtlas/<commit>/web/index.html`. githack shows a one time "Open the page" step (with an ad) before the app; data files are redirected to raw.githubusercontent.com. Each commit has its own link.

## Run locally

Serve the repository root (the page loads data from `../App/ExitAtlas/Resources/Data/`):

```
python3 -m http.server 8000
```

Open http://localhost:8000/web/. GPS needs HTTPS on a phone; localhost works on a computer.

## Tests

```
cd web
npm test
```

46 tests: geodesy, synthetic regions, state segmentation against the shapely/pyproj oracle on four real routes (0.05 mi tolerance), published I-95 state lengths, exits against OSM node membership, snapshot values, time zones, GPS tracking (noise, tunnel, departure, out and back), reroute ledger, discovery, fuel stop planner, pace blending and ETA accuracy, speed limit loading, favorite brands, charging stops, price and charger clients.
