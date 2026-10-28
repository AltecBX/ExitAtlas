# 11. Release readiness (2026-10-28)

What is in place for data updates, keys and an App Store submission, what was verified, and what only the owner can do. Milestone 6 of docs/09.

## 11.1 Offline data: versions, updates, rollback

| Part | What it does | Verified |
|---|---|---|
| `tools/data-pipeline/build_manifest.py` | Writes `manifest.json`: version (UTC build time, never goes down), schema, content hash, and per file the size, SHA-256, whether it is required, and its source, license and build date. Rebuilding unchanged data keeps the version. Last step of `build_all.sh`. | Run twice on the current data: same version |
| Web (`web/js/engine/datamanifest.js`, `services.js`, `sw.js`) | Fetches the manifest fresh, loads each file by its hash (`?v=` first 16 hex), checks size and SHA-256 (Web Crypto) and that it parses, and falls back to the last set that loaded (kept in `localStorage`). The service worker keeps the two newest versions of each file and serves the manifest network first. Settings shows the data version and any fallback. | 6 unit tests (update, corrupted, truncated, missing and unreadable files, older or newer schema manifests); a browser run where a fake newer manifest served a corrupted `interstates.eax`: the app loaded the previous file and said so |
| iOS (`DataUpdater.swift`, `DataStore.swift`) | Once a day on Wi-Fi (not cellular or Low Data Mode) reads the manifest from GitHub Pages, downloads only changed files into a staging folder, checks each one (size and SHA-256, CryptoKit), loads the whole set, then makes it current and keeps the old set as previous. At launch it loads the newest set that works: current, previous, then the data bundled with the app; a downloaded set older than the app's own data (after an app update) is skipped, and one that fails to load is deleted. A trip in progress keeps its data; new data applies when no trip is running. Settings, Data sources shows the version and source, "Check for data updates" and "Use the data included with the app". | 4 engine tests on the same rules (update decision, stale or newer schema manifests, launch order and fallback). The download path runs only on a device or simulator with network: **not yet exercised** |

Publishing new data: run `tools/data-pipeline/build_all.sh`, commit the changed files with the new `manifest.json`, merge to `main`. GitHub Pages serves them to the web version and to iOS apps within minutes. A test (`web/tests/datamanifest.test.js`) fails if any data file changes without a new manifest.

Limits: GitHub Pages has a soft bandwidth limit of 100 GB a month ([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)), about 4,700 full downloads of the 21 MB set; fine for personal use, not for a large audience. Old schema apps stop at the last data they can read; bump `SCHEMA` in `build_manifest.py` with any incompatible format change.

## 11.2 Keys and public services

| Part | What it does | Verified |
|---|---|---|
| `infra/worker` (Cloudflare Worker) | Holds the Google Places and NREL keys server side. Answers only listed origins; fixed request shapes (a client cannot change the radius, fields or key); never caches prices (Google's terms); caches AFDC charger results for a day; daily budgets for all clients and per client by a salted IP hash (no addresses stored); `/v1/config` switches routing, search, prices or chargers off for everyone. | 7 tests in CI (key never returned, shapes fixed, origin and input checks, budgets per client and overall, cache hits free, upstream errors not cached, failed counter writes do not fail requests). A browser run against the Worker code on localhost with a fake upstream: prices came through the proxy and no request went to Google directly |
| Web client | Settings, Gas prices: "ExitAtlas key proxy" URL. When set and reachable, prices and charger lookups use it; the driver's own keys still work without it. Off switches stop routing or search with a clear message. | 2 unit tests; the browser run above |

**Not deployed.** It needs the owner's Cloudflare account, a Google key restricted to Places API (New) with a daily quota, and an NREL key (steps in `infra/worker/README.md`). The Workers Free plan allows 1,000 KV writes a day, which the default budgets fit ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)).

Still on public servers (fine for personal use, not for an App Store app; docs/09.6): OSRM demo routing and Nominatim search (web), FOSSGIS Valhalla speed limits (web and iOS). The iOS app routes and searches with Apple MapKit.

## 11.3 App Store submission

**In place**
* Privacy manifest `App/ExitAtlas/PrivacyInfo.xcprivacy`: no tracking, no data collected by the developer, UserDefaults read only by the app (reason CA92.1). CI checks that it is in the built app.
* `ITSAppUsesNonExemptEncryption = NO` (HTTPS and checksums only).
* Location strings for When In Use and Always, background modes location and audio (spoken announcements), Live Activities.
* In app data attribution and licenses (Settings, Data sources), ODbL notices for OpenStreetMap derived data.

**Decisions only the owner can make**
* **Privacy label answers.** The developer receives no data. The app does send location derived data to third parties to answer requests in real time: route shape to FOSSGIS Valhalla (speed limits), route shape to the DOE AFDC (chargers), exit coordinates to Google with the driver's own key (prices), and the user's IP address to GitHub Pages (data updates). Apple counts data as "collected" when it is kept longer than needed to answer the request; whether these services keep logs is up to them. The conservative answer is to declare Precise Location (route shapes start at the driver's position), used for App Functionality, not used for tracking. Decide before submitting, and keep the manifest's `NSPrivacyCollectedDataTypes` in step.
* **Privacy policy URL** (required for every app). Draft: `docs/release/privacy_policy.md`. Review, then publish it (for example as a page on GitHub Pages).
* **Publisher name and support URL** in App Store Connect; the bundle id is `com.cobyconstruction.exitatlas`.
* **AASHTO.** The Interstate shield is a registered AASHTO mark (USPTO 835,635). Draft letter asking for confirmation of route identification use: `docs/release/aashto_letter.md`. Keep the shield out of the app icon and marketing.

**Review risks** ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/))
* 2.5.4, background services only for their purpose: background location is used for trip progress and announcements while driving, which is the app's purpose; the audio mode is for spoken announcements. Say so in the review notes.
* 5.1.5, Location Services: location must be directly relevant (it is), and features that do not need it should still work when it is off. **To verify on a device:** planning a route, the demo, Exits for a planned route, Discover and Settings with location denied.
* 5.2.1, intellectual property: Interstate shield (AASHTO, above); brand names shown as text only, no logos.
* 4.1, copycats: no other app's name, icon, screenshots or layouts are used (docs/09.4 compared features, not designs).
* 2.3, accurate metadata: screenshots must come from the app (the CI screenshots qualify) and must not show simulated data as real; the app marks simulated drives.
* CarPlay: a CarPlay app needs Apple's driving task entitlement first (docs/10); the Live Activity on the CarPlay Dashboard does not.

**Still to do before submitting**
1. A real drive with a development build (location in the background, Live Activity on the Lock Screen, CarPlay Dashboard and Watch, voice with other audio, data update on Wi-Fi).
2. Move speed limits off the FOSSGIS public server for an App Store build (self hosted Valhalla or a paid provider), or turn the feature off there.
3. App icon review (no shield), App Store screenshots, description and keywords.
4. TestFlight build: needs the owner's Apple Developer account and signing team.
