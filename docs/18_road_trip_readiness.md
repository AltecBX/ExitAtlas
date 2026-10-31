# 18. Road trip readiness (website on iPhone)

Audit date: 2026-10-30, for a drive from Yonkers NY south through several states on 2026-10-31. Scope: the website at https://altecbx.github.io/ExitAtlas/web/ in Safari on iPhone. The native iOS app was only kept compatible (its shared Swift engine got the same rule changes).

## Verdict

Ready for the drive with the limits below, which come from the browser and from free data, not from known defects. Every confirmed critical and major defect found in the audit is fixed and covered by an automated test. Testing used Chromium with iPhone emulation; Safari itself (WebKit) could not be installed in the test environment, so the items under "Needs a real iPhone" are not verified.

## How it was tested

* Unit and engine tests: 200 web tests (was 142), 168 Swift tests (was 147).
* Browser tests (Chromium, iPhone sizes 375x667, 390x844, 430x932, 844x390, 667x375, light and dark): drive, ahead, prices, pricepath, autoprices, trip (a whole trip against fixture servers: plan, drive, stalled and failed routing, reroute, reload, resume, end), offline (the real service worker: first visit, deploy, start with no network), mobile (sheets, tap sizes, open sections, wake lock, paused location, parked map), and shared reports on the Worker runtime. All run in CI on every push.
* Long drive simulations at one GPS fix per second on real OSRM routes: Yonkers to Orlando (1,091 mi through the overnight window and the end of daylight saving time, with urban drift, GPS gaps of 1 to 20 minutes, stops off the route and detours) and Yonkers to Morristown. Position error 3.4 m typical, 22 m worst; state mileage within 0.1 mi of published I-95 lengths; no false off route; each state line warned and welcomed once.
* Long session: about 1,160 simulated miles with no memory, DOM or listener growth.

## Defects fixed (PR #39)

Severity: P1 would hurt the trip, P2 polish.

| Area | Defect | Severity |
|---|---|---|
| Offline | A deploy deleted the 16 MB offline data (and other apps' caches on the host) | P1 |
| Offline | Data from a first visit was not kept for offline use | P1 |
| Routing | Routing and search had no time limit; "Finding routes" or "Rerouting" could stick for good | P1 |
| Resume | A resumed trip restarted at mile 0; miles driven meanwhile were lost | P1 |
| Tracking | GPS drift of 60 to 80 m flipped to off route and rerouted, up to 39 times a mile | P1 |
| Tracking | A short stop during a GPS gap moved the arrival time by hours; a parked phone added phantom miles | P1 |
| Tracking | After an ignored reroute the app stayed "Acquiring" and never rerouted again | P1 |
| Road alerts | A failing weather server was asked on every GPS fix (about 3,600 an hour) | P1 |
| Road alerts | Weather alerts for the zone the driver is in vanished or showed as miles ahead | P1 |
| Road alerts | Storm warnings between sample points were never fetched | P1 |
| Road alerts | Stalled weather, work zone and speed limit requests blocked later refreshes | P1 |
| Road alerts | A southbound NJ Turnpike incident was dropped as the other direction; road names were case sensitive | P1 |
| Fuel | NJ Turnpike and Maryland plazas with fuel were missing: a false 91 mi "no gas" stretch | P1 |
| Fuel | Rest areas were ranked as a 9 min detour; a stop 52 mi ahead beat a welcome center 12 mi ahead | P1 |
| Fuel | With low fuel, a Love's beat the Shell at the same exit | P1 |
| Fuel | Stations beyond the range were listed first under "Shell first" with no warning | P1 |
| Fuel | Stations rebranded away from Shell still ranked as Shell | P1 |
| Mobile | The map redrew about 1,600 times a minute while parked (battery) | P1 |
| Mobile | The wake lock could stay on after End; a refusal was silent | P2 |
| Mobile | Sideways iPhone SE hid miles left, arrival and the Fuel and Restroom buttons | P2 |
| Mobile | Two notes in the Navigation View's left column ran into the bottom panel on small phones | P2 |
| Mobile | Close buttons 25 pt, small taps, low contrast, double tap zoom, sections closing while driving | P2 |
| Voice | The same event spoken again from an update or a second feed; "New route." every 20 s | P2 |
| Voice | Turning voice on said nothing (Safari needs speech to start from a tap) | P2 |
| Other | "None" shown before any alert source answered; speed limit "loading" forever; the demo alert labeled "Official source" and kept on a later real trip; stale "Will retry"; a failed "Add stop" kept silently; an unreadable saved trip froze start up; raw system error text | P2 |

## Also fixed (PR #40)

* Routing: when the OSRM demo server fails (no connection, no answer in time, HTTP 5xx or 429), the FOSSGIS server (`routing.openstreetmap.de`) is asked once; each server at most once a second.
* App files come from the version's own precached set, so a reload on a weak connection opens in about 0.2 s and a deploy never mixes old and new files (cache `exitatlas-v34-<hash>`; `node web/tests/swhash.js --write` after changing an app file).
* The route is saved only when it changes (the 30 second save went from about 370,000 characters to about 0.5 KB); trips saved by v32 and v33 still resume.
* End asks before ending a real trip ("End this trip? It cannot be resumed after this.").
* A new trip from Home or a recent place no longer keeps the previous trip's start and stops.

## Also fixed (after the Berkshires drive, Oct 31)

* Parkway and freeway exits nationwide (freeways.eax, 22,468 exits from OpenStreetMap), route choices name their roads, and automatic reroutes keep the driver's highway (PR #43).
* Navigation View map: while it followed the vehicle, each camera move cancelled the driver's pan or pinch before it started, so the map ignored the finger and no recenter button appeared. The camera now waits while a finger is on the map; a pan or pinch stops following and shows the recenter button; left alone 15 s, the map follows again.
* A map that stops drawing (iOS Safari can take a page's WebGL context away) is replaced by a new one on the vehicle within a few seconds; after 3 in 10 minutes it says "Map unavailable" and Focus View still works.
* The simulated drive's speed button steps through 30, 60, 90 and 120 times.

## Known limits (not defects)

* Safari pauses a web page's GPS, timers and voice when the screen locks or another app is in front. ExitAtlas cannot navigate in the background; it estimates through short gaps and catches up when you return, and says how long location was paused.
* Arrival times use your own pace and road speeds; the website has no traffic source (none is licensed for it at no cost). The Trip tab says so.
* Gas prices: no free, authorized source exists (docs/17.14), so stations say "Price unavailable". The Google Maps and GasBuddy links in Station details open their own pages.
* Police reports: no source is connected, and the app says so.
* Work zones: only Delaware's feed is readable from the browser; New Jersey and Maryland need the optional proxy (not deployed).
* Speed limits show only where OpenStreetMap has them; otherwise "No limit data".
* Routing uses free public OpenStreetMap servers (the OSRM demo server, with the FOSSGIS server as a backup). If both are down, a new trip or reroute waits and says why; the route already loaded keeps working offline.
* FOSSGIS's usage policy (it also runs the speed limit server) asks a website to show an easily reachable contact email for its operator. The site shows none yet; adding one is Jerry's decision.
* The interstate direction letter can be wrong on short stretches (for example I-95 on the George Washington Bridge).
* Overnight, a station listed open outranks a rest area with no listed hours (documented rule).
* Home Screen web apps keep storage separate from Safari: a profile set up in Safari is not in the Home Screen copy until exported and imported.

## Needs a real iPhone or a real drive

* Wake lock in Safari after a tap, and in the Home Screen app (needs iOS 18.4 or later there).
* Voice heard in the car; whether iOS speech stalls after the app was in the background.
* GPS behavior with the screen locked or Safari in the background, and how a parked phone wanders.
* Urban drift tolerance on the Henry Hudson Parkway and in DC; the pace model over a full day.
* Real NWS zone alerts on screen; how many roads have OSM speed limits.
* Heights with Safari's toolbars showing; keyboard placement in place search.
* Battery, heat and map tile traffic over hours.

## Before leaving (checklist)

1. Tonight, on Wi-Fi: open https://altecbx.github.io/ExitAtlas/web/ in Safari, let it load, then reload once (installs the offline copy of the app and its data).
2. Settings (profile button): check the vehicle, fuel grade, favorite brands with Shell first, Home, voice on, and "Keep screen awake while driving" on.
3. iPhone Settings, Privacy and Security, Location Services, Safari Websites: While Using the App, Precise Location on.
4. iPhone Settings, Display and Brightness, Auto Lock: Never for the drive (set it back after). Keep the phone on a charger and in a mount.
5. Use the Safari tab, not a Home Screen icon (your profile lives in Safari). If you prefer the Home Screen icon, first use Settings, Export profile in Safari, then Import profile in the Home Screen copy.
6. Before driving: enter the destination, pick the route, Start. Then enter miles to empty from the dashboard (or "I filled up").
7. Tap the screen once after starting so Safari allows the screen to stay on and the voice to speak. If "Screen may lock" shows, tap it.
8. While driving: keep ExitAtlas in front. If you switch apps or the screen locks, location pauses until you come back.
9. If Safari reloads or you closed the tab: open the site again and tap Resume (not a new trip); progress and miles come back. End asks before it ends the trip, so a mis tap is harmless.
10. In a dead zone: the route, exits, stations and rest areas stay available; alerts and weather show as unavailable, never as clear. When signal returns, they refresh by themselves.
