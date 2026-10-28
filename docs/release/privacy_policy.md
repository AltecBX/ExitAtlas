# ExitAtlas privacy policy (DRAFT)

> Draft for the owner to review before it is published or linked from App Store Connect. It describes what the code does as of 2026-10-28; it is not legal advice. Items in [brackets] need the owner's details.

**Effective [date]. Publisher: [publisher name]. Contact: [contact].**

ExitAtlas is an interstate road trip companion. It has no accounts, no ads, no analytics and no tracking. We (the publisher) do not receive your location, your trips or anything else you do in the app.

## What stays on your phone

Your trips and trip history, saved places (Home and recent), settings, vehicle, favorite brands, the license plate game and any API keys you enter are stored only on your phone. Deleting the app deletes them.

## Location

ExitAtlas uses your location on your phone to follow your route: the exits ahead, miles left in each state, arrival times, the speedometer and voice announcements. If you allow "Always", it keeps doing this while the screen is off or another app is open during a trip. Location is not sent to us.

## Services ExitAtlas contacts

To answer a request, the app sends the minimum needed to these services. Each has its own privacy policy.

| Service | When | What it receives |
|---|---|---|
| Apple Maps (iPhone app) | Planning a route, searching for a place, showing the map | Your search text, start and destination, map area |
| FOSSGIS Valhalla (valhalla1.openstreetmap.de) | Speed limits during a trip | Sections of the route ahead of you |
| U.S. Department of Energy, Alternative Fuels Data Center | Charging stops for electric vehicles | The shape of your route |
| Google Maps Platform | Gas prices, only if you enter your own Google key (or use the publisher's key proxy) | The location of the exit you are looking at |
| GitHub Pages | Data updates (once a day on Wi-Fi) and the web version itself | A normal web request (your IP address) |
| OSRM demo server and Nominatim (web version only) | Routing and place search | Start, stops and destination; your search text |
| ExitAtlas key proxy on Cloudflare (only if set up) | Gas prices and charging stops | The same as Google and the DOE above; daily limits are counted with a one way hash of your IP address, kept for two days |

These services see your IP address, as with any internet request.

## Children

ExitAtlas is not directed to children under 13 and does not knowingly collect their information.

## Changes

If this policy changes, the new version will be posted at [URL] with a new effective date.
