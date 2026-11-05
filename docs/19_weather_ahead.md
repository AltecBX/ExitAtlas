# Weather ahead on the route (web)

Asked for on the NY to Tampa drive, Nov 4 2026: "warn me of bad weather ahead on my route".

## What it does

During a trip, ExitAtlas reads the National Weather Service hourly forecast for points along the route ahead,
at the time the driver will get to each one, and flags:

* rain or showers with a 40% chance or more (a 20 to 39% chance is a quiet line, not a warning);
* thunderstorms, at any chance;
* snow, sleet and freezing rain ("Wintry mix"), at any chance;
* fog.

Consecutive points with the same level become a stretch, for example "Showers likely, 60%" for 24 miles,
arriving about 3:40 PM. Where it shows:

* **Drive screen** (both presentations): the weather pill in the top bar shows the first warning within 60
  miles, in amber, e.g. "Showers in 18 mi" or "Fog next 29 mi". When the words do not fit, the temperature
  goes first, then the icon, then the words shorten to "Fog ahead" ("Fog now" when already in it), then "Fog".
  The top bar uses the system font, so how much fits depends on the phone and its text size (a Linux CI runner's
  wider font cut "Fog next 31 mi" off before these shorter forms existed).
* **Road Ahead**: a row at the stretch's start under All (warnings, chances, unavailable stretches) and under
  Alerts (warnings only).
* **Weather sheet** (tap the pill or a row): "Ahead on your route" lists each stretch with where it starts, how
  long it is, the arrival time and when NWS updated the forecast. Warnings come first.
* **Voice** (road alert voice on): once per stretch, about 20 miles ahead, e.g. "Weather forecast: showers
  likely ahead, in about 15 miles."

The Weather switch in Settings, Road alerts, turns it off along with the NWS warnings.

## Source

National Weather Service API (api.weather.gov), public domain, no key. Requests:

* `/points/<lat>,<lon>` for each route position, every 12 miles at fixed route positions (so a position is
  looked up once per trip), rounded to 2 decimals (about 1 km);
* the `forecastHourly` URL it names, once per forecast grid, again after 20 minutes.

The window is the next 150 miles or 3 hours of driving, whichever comes first. A refresh runs every 20 minutes
or after 40 miles, one request at a time with a 250 ms pause. A typical 150 mile window is 13 points, so the
first refresh makes 13 point requests and up to 13 forecast requests (fewer where points share a grid).
Later refreshes make only the forecast requests, plus a point request for each new position at the far end.
Forecasts no point uses any more are dropped (each is about 160 KB).

## Rules

* A point whose forecast could not be read shows as **Weather ahead unavailable** for the stretch it covers,
  never as clear. So does one fetched more than 2 hours ago, one whose grid NWS last updated more than 12 hours
  ago, and one with no hour for the arrival time.
* An hour that has ended is never used. An arrival in the past reads the current hour.
* Everything is labeled as the NWS forecast with NWS's update time. It is never called radar or live.
* An NWS warning already on the route (a road alert, e.g. a Dense Fog Advisory or a Severe Thunderstorm
  Warning) covers forecast stretches of the same kind that it overlaps. Those stretches are not shown again on
  the Drive screen or in Road Ahead, and are not spoken. The sheet still lists them with a pointer to the alert.

About the 2 hour rule: NWS's own `updateTime` on these grids was 3 to 5.5 hours old when recorded (Nov 5,
03:26 UTC). A 2 hour limit on it would blank the feature most of the day. So the 2 hours apply to ExitAtlas's
copy (fetched every 20 minutes), and NWS's update time has a 12 hour sanity limit.

## Limits

* **This is a forecast, not radar.** An hourly forecast for a 2.5 km grid cell cannot see a passing shower
  cell. A sudden downpour under a "20% chance" hour can still happen without a warning.
* Points are 12 miles apart. A narrow band of weather between two points can be missed.
* The browser cannot set the User-Agent header NWS asks API clients to send. The current weather pill has
  the same limit.
* Web only for now. The iOS app does not have it yet.

## Possible later: rain right now ahead (radar)

The Iowa Environmental Mesonet (Iowa State University) publishes a NEXRAD base reflectivity mosaic (N0Q,
every 5 minutes) as PNG and as map tiles. Its disclaimer page says: "The materials found on this website are
in the public domain and may be used freely by anyone for any lawful purpose." It also says data comes
"without any warranty of accuracy" and that attribution is appreciated.

A tile request on Nov 5 2026 answered with `Access-Control-Allow-Origin: *` and a 5 minute cache. A browser
could therefore read the reflectivity at points ahead from the tiles. It is a university service with no
stated uptime or capacity commitment. Not built.

## Tests

* `web/tests/weatherahead.test.js`: the hour at the arrival time, levels, phrases, stretches, unavailable
  cases, the NWS warning overlap, the sample positions, and the fetcher's requests and failures. These run on
  real NWS answers recorded on I-95 (`web/tests/fixtures/weatherahead`).
* `web/tests/layout/weatherahead.layout.mjs`: the pill, the Road Ahead row and the sheet at 390 and 375 points
  wide, light and dark, in Navigation View and Focus View, with the browser clock inside the recording. It also
  checks "unavailable" (and no warning) when the forecasts fail.
