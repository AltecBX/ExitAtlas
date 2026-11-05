Real National Weather Service answers recorded on 2026-11-05 at 03:26 UTC for five points on I-95:
Emporia VA (36.69,-77.54), Lumberton NC (34.62,-79.01), Walterboro SC (32.90,-80.66), Brunswick GA
(31.15,-81.49) and Jacksonville FL (30.33,-81.66).

* `points_*.json`: `https://api.weather.gov/points/<lat>,<lon>`, unchanged.
* `hourly_*.json`: the `forecastHourly` URL each point names, with `properties.periods` cut to the first 50 hours
  (through Nov 6, 11 PM Eastern) to keep the files small. Nothing else is changed.

Used by `web/tests/weatherahead.test.js` and `web/tests/layout/weatherahead.layout.mjs`. Some tests read the
Nov 6 hours (rain and thunderstorms in VA, NC and SC) with a scenario clock a day after the recording; those
say so and widen the "NWS last updated" limit for that scenario only.
