# ExitAtlas web

A browser version of ExitAtlas for using on a phone before the iOS app is installed. Same engine, ported from `Sources/ExitAtlasCore` to JavaScript, tested against the same route fixtures and oracles.

## What works

* Plan a route: place search (Nominatim), routing with stops and alternatives (OSRM demo server, OpenStreetMap data).
* Live GPS in Safari: state line card (next state, miles to the line, exits left, local crossing time), next exit with services, destination, arrival and states left.
* Exits ahead with state lines inline, category filters, exit detail with detours, find along route, gas ahead by fuel range, stop planner by drive time.
* Trip overview: offline SVG map by state, completed, current and upcoming states with local entry times.
* Automatic reroute when you leave the route; miles per state survive reroutes.
* Discovery mode: no destination, locks onto the interstate and direction you are driving.
* Voice for state lines and exits, screen wake lock, light and dark mode.
* The trip is saved on the phone every 30 seconds and can be resumed after the page reloads, without a network connection.
* Offline data: states, time zones and 38,553 exits load once (about 15 MB) and are cached by a service worker.
* Simulated demo (Miami to Manhattan), clearly marked as a simulation.

## Limits of a web page on iPhone

* GPS stops when the screen locks or Safari is not in front. Keep the screen on (the app requests a wake lock; if that is not available, set Auto Lock to Never). Short gaps are dead reckoned and the trip catches up on return.
* Travel times come from OSRM's typical speeds without live traffic. They run slow on interstates (OSRM estimates 24.2 h for the 1,281 mi Miami to Manhattan route). The pace model corrects arrival times from your actual driving within the first hour or two.
* Avoid tolls is not available on the OSRM demo server.
* No fuel prices: there is no licensed price source.
* Routing and search need a connection. The demo server is for light personal use.

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

31 tests: geodesy, synthetic regions, state segmentation against the shapely/pyproj oracle on four real routes (0.05 mi tolerance), published I-95 state lengths, exits against OSM node membership, snapshot values, time zones, GPS tracking (noise, tunnel, departure, out and back), reroute ledger, discovery.
