# Application audit (Nov 13, 2026)

Scope: the web app (`web/`), the key proxy Worker (`infra/worker`), CI, and the Swift engine's tests. Method: a green
baseline first, three independent code reviews (web runtime, car and cockpit, backend and security), CPU profiles on
a 4x slowed processor, and every finding reproduced before it was fixed. Each fix has a test. Published as PRs #66,
#67 and #68.

What "verified" means below: a test in this repository shows it, in Node or in Chromium with fixture servers and a
SIMULATED OBD2 adapter. Nothing here was run on the iPhone, in Safari, or against a real car.

## Test results after the audit

| Suite | Result |
| --- | --- |
| Web unit tests (`cd web && npm test`) | 314 pass (289 before) |
| Worker tests (`cd infra/worker && npm test`) | 26 pass (20 before) |
| Swift engine (`swift test`) | 170 pass |
| Browser suites (Chromium, 14 with the new security suite) | 14 pass, each by its exit code: drive, ahead, mobile, trip, parkway, navmap, prices, pricepath, autoprices, weatherahead, offline, security, carlink, cockpit |
| iOS app build and UI tests | CI only (macOS runner); not run here |

## Performance

Measured in Chromium, phone size, CPU slowed 4x, simulated drive, 20 s per tab.

| Measure | Before | After |
| --- | --- | --- |
| Drive tab, share of CPU time busy | 52.7% | 31.8% |
| Road Ahead tab | 29.5% | 4.3% |
| Trip tab | 30.5% | 8.0% |
| Long tasks (over 50 ms) in 20 s: Drive, Road Ahead, Trip | 129, 81, 73 | 34, 1, 5 |
| Longest task: Drive, Road Ahead, Trip | 175, 120, 119 ms | 86, 67, 75 ms |
| Start to first screen (58 modules, demo trip) | 3.9 s | 3.6 s (within run to run noise) |
| Memory after 20 s (heap) | 51 to 53 MB | 51 to 52 MB, no growth trend |
| Horizontal overflow at 1440, 820, 430 and 320 px wide | none | none |

What is left on Drive is mostly the map library drawing and the layout measurements that place the map under the
cards (about 0.7 s of 20 s here, with the simulation feeding fixes many times a second; a real drive has one fix a
second). The only tap targets under 30 px are text links in credit lines (OpenStreetMap, report a map error).

Cause of the largest cost: the time zone of every stop was found with a point in polygon test on every redraw. It is
now profiled once per trip along the route (`engine/trip.js`), opening hours are parsed once per text and local time
uses a cached offset (`engine/openinghours.js`). The profile is checked against the exact lookup at more than 3,000
points, and local time against `Intl` at 20,000 random times across daylight saving changes.

Not changed: the first visit downloads about 13.5 MB of data (gzipped), by design (the app works offline after it).

## Fixed: web runtime

| Defect | Fix |
| --- | --- |
| Discovery mode rebuilt its plan on every GPS fix in the last 50 miles of a corridor part (speed limits, weather ahead and mile counts restarted each time) | Rebuilt only when the corridor goes on past the plan (`discoveryNeedsPlan`) |
| A route answer could land on a newer request, and a reroute answer on another trip | Answers are tied to their request and trip |
| In discovery mode the fuel range jumped back after a reload | The range is anchored as the miles are driven |
| A failed corridor load was never tried again | Tried again |
| A failed reroute counted as a route the driver left, so after an outage the next reroute could wait 10 minutes | Failed requests keep the 2 minute spacing |
| Stops were matched by name only (two stops with one name) | Name and position |
| The map library was not kept for offline starts, and a failed load was permanent | Kept by the service worker; retried every 30 s, 20 s limit per load |
| A background answer redrew a sheet while it was typed in (keyboard and entry lost) | Redraw waits until the sheet is free |
| Google price lookups: counted before they were sent, a failure was kept an hour, no time limit | 15 s limit; counted once they may have reached Google; requests on their way count against the daily limit; one that never left is tried again in 2 minutes |
| Shared prices, fuel benchmarks, station town and proxy config requests could stall forever | 15 s limit |
| Place search results could be overwritten by older suggestions | Latest wins |

## Fixed: car connection and cockpit

| Defect | Fix |
| --- | --- |
| One late answer shifted every later answer by one request: on a BlueDriver each gauge showed another PID's bytes as live (simulated: coolant 24 °C shown, 83 true); on an ELM327 every PID went unreadable | A late answer is dropped and the next request waits for it (at most 2 s); the time limit starts when the request is on the air; a failed write leaves nothing behind |
| After a dropped link live data never restarted, and codes or the Porsche probe could hang | The request in the air ends with the link; live data restarts after the reconnect |
| Disconnect then Connect during the first request broke the new connection 15 s later | An old attempt changes nothing |
| Opening the cockpit from Diagnostics ran two live loops (each PID asked twice, duplicate recording samples) | One loop |
| An item answering NO DATA was asked on every pass (three good gauges fell from 11 to 3.5 readings a second) | After two misses in a row, every 15 s |
| The Porsche probe ended a running recording | Live data is paused, the recording goes on |
| ELM327: after a Porsche request standard requests went to one module (fuel level stopped updating) | Pointed back before any standard request, and after a reconnect |
| ELM327: answers from two control units (codes "unreadable", only the first unit's PID list and check engine light) | Codes, PID lists and monitor status from every unit |
| ELM327: several PIDs per request never used when the cockpit opened first; PID 68 broke it | Probed in cockpit sessions; PID 68 is 7 bytes |
| BlueDriver: an answer of the wrong length was decoded (it carries no PID) | For classic PIDs (below 60) the length must match |
| After a long pause a stopped gauge showed LIVE for minutes | A pause is not counted into the update interval |
| Listeners doubled on every reconnect (answers taken twice, reconnects slower each time) | One listener per connection |
| Cockpit: targets, alert limits and oil temperature were not read in modes without those gauges; an old target or warm up line showed as current | They are in every plan; shown only while current |
| A sensor gauge's needle used a different scale than its face | One scale; the face is redrawn when a reading leaves it |
| Recordings with Porsche channels could not be exported as CSV or played | Both work |
| A failed save lost the recording silently | Retried on a fresh connection, then kept in memory with a notice |
| The cockpit kept the screen on after closing; playback could not reach the cockpit | Released; playback follows into the cockpit |

## Fixed: security and privacy

| Defect | Fix |
| --- | --- |
| A tile style's attribution was put into the page as HTML (script injection by a compromised tile server) | The map credit is the app's own fixed text |
| No Content Security Policy | Policy in `index.html`: no inline event handlers, plugins, base tag, plain http data or foreign script hosts |
| Worker: the Google price budget was read then written (calls at the same moment slipped under it) and had no limit when unset or uncountable | One atomic statement in D1; defaults when unset; no request to Google when the count cannot be kept |
| Worker: per client limits by single IPv6 address (no limit at all), one client could use up everyone's lookups, several install ids from one address could outvote others | Clients by /64; per client lookup limit; one vote per client in the outlier check |
| Worker: request size trusted Content-Length; charger parameters unchecked; hashes unsalted without `CLIENT_SALT`; old rows deleted only when someone reported | Capped reads; parameters checked; no shared reports without the salt; cleanup on lookups too |
| Settings said places are "searched only when you tap Search" while suggestions were sent as typed, with the position to 3 decimals | The text says what happens; the position is rounded to 1 decimal |
| An imported profile file could turn on Google Maps prices or shared reports | It cannot; the driver is told |
| Erase left the kept copy of a damaged profile | Removed; the prompt says what stays |
| CI token had default permissions; the deploy step reported success when the deploy failed | Read only; `pipefail` |

The Worker changes take effect on the next "Deploy proxy" run (it is deployed by hand).

## Open: needs Jerry or a real device

| Item | Why it is open | What it takes |
| --- | --- | --- |
| Car connection and cockpit on the real car | Every car fix is verified against a simulated adapter only | A drive with the BlueDriver; send the session Log |
| Porsche Mode 22 through the BlueDriver | Its answer format is unknown, so a wrong length cannot be told from a right one there | The probe on the car (cockpit settings) |
| The security policy with the beacio extension on iPhone | Not testable here. Script elements were left open on purpose so the extension cannot be blocked, which makes the policy a partial guard: it stops inline event handlers, not injected script elements or javascript: links. The app's escaping of outside text is the main defense (reviewed, no gap found) | If Connect car still works after this update, a stricter policy can be tried next, with a test page first |
| The site shares its origin with every other altecbx.github.io page | Storage and service worker scope are per origin | A custom domain |
| GitHub Actions are pinned by tag, `wrangler@4` floats | Pinning by commit needs each action's commit, which could not be looked up from this session | Pin by SHA |
| Shared price reports cannot be proven honest | The position is never sent (by design), so "at the station" is the app's own check, and an install id is the sender's choice | Accepted limits, documented in `infra/worker/README.md` |
| ELM327: calibration ids from two control units are joined into one text | Cosmetic, ELM only | Parse per unit |
| A slow new data file can delay the start although an older copy is cached | Reported by the review with low confidence, not reproduced | Reproduce first |
| iOS app | Not part of this audit beyond its CI job; never run on a device | Web first, per Jerry |
| Safari | All browser checks ran in Chromium | A pass on the iPhone |
