# 14. Google navigation with live police alerts, Waze handoff, Roadbeacon (2026-10-29)

Request: investigate the Google Maps Navigation SDK for iOS real time disruptions (police, speed cameras, crashes) and prototype an optional Google navigation mode that keeps the ExitAtlas essentials; add an official Waze destination handoff; research Roadbeacon as a future open reporting provider. Facts carry a source (read 2026-10-29); UNVERIFIED marks what no primary source confirms; nothing here is legal advice.

## 14.1 Status of each requirement

Nothing below is claimed to work on a phone until the device tests in 14.7 pass. "Compiles" means the iOS build in CI, not a run.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Police reports on U.S. interstate routes | **Not verified.** Documented as a disruption type; U.S. availability of police specifically is not published | Google lists "police and speed camera presence" among disruptions, and the U.S. has real time disruptions with good quality (⬤). But "some real time disruption features, such as police presence and mobile speed cameras, are not available in all countries where real time disruptions are available", with no per country list ([disruptions](https://developers.google.com/maps/documentation/navigation/ios-sdk/real-time-disruptions), [coverage](https://developers.google.com/maps/documentation/navigation/ios-sdk/coverage-nav-sdk)). Only a drive settles it (14.7, D1) |
| 2 | Warnings during active navigation | Documented, not verified | Callouts along the route, an alert with voting when approaching a disruption, and info cards on tap; all on by default (`shouldDisplayPrompts`, `showsIncidentCards`) |
| 3 | Audio announcements | Documented, not verified | "When a user approaches a disruption along a route during active navigation, the disruption is announced with an audio alert", independent of the prompt setting; all voice through `voiceGuidance` |
| 4 | ExitAtlas state progress shown safely | Built on the experimental branch, compiles in CI; not verified | A panel below Google's map, never over it (14.5) |
| 5 | Google branding and map rules | Designed in; to confirm on device | Google's map, header, footer and attribution are left untouched; no Google data leaves Google's map (14.4) |
| 6 | Consent, billing, configuration | Built on the experimental branch | ExitAtlas consent sheet, then Google's own terms dialog (required, unmodified), then location and notification prompts; key in the Keychain; destinations counted per month (14.3, 14.6) |
| 7 | The native app works without Google | By construction | The Google mode is a separate build (`ExitAtlasGoogle`); the regular `ExitAtlas` build does not link Google's SDK, and the Google build falls back to the native app without a key or consent |
| 8 | No claim before a real device test | Kept | 14.7 lists what to test; results get recorded there |

## 14.2 What the Navigation SDK does with disruptions

From [Configure real time disruptions](https://developers.google.com/maps/documentation/navigation/ios-sdk/real-time-disruptions) and the SDK 11.2.0 headers (checked against the downloaded binary, checksum matching Google's package):

* **Types:** "vehicle accidents, traffic congestion, police and speed camera presence, construction, lane closures, and certain weather conditions", plus road closures.
* **Display:** callouts with a type icon along the route (route overview and active navigation), off route callouts when the traffic layer is on, an alert with "still there" voting when approaching one during active navigation, and info cards with the type and the time last reported.
* **Controls:** `navigator.shouldDisplayPrompts` (callouts, alerts, cards during navigation), `settings.showsIncidentCards` (cards before navigation), `settings.navigationReportIncidentButtonEnabled` (Google's report button). All default to on.
* **Reporting and votes:** reports and votes go to Google and "may be surfaced on the map for other Google Maps and Navigation SDK users". Voting is within 5 km of the driver, never for road closures.
* **Audio:** approach alerts are spoken regardless of `shouldDisplayPrompts`; `voiceGuidance` (silent, alerts only, alerts and guidance) controls all speech.
* **Layout hooks:** `navigatorWillPresentPrompt` and `navigatorDidDismissPrompt` (experimental) tell the app before Google shows a prompt; `bottomTrailingButtonsLayoutGuide` moves the report button.
* **Not available:** disruptions on Apple CarPlay ("real time disruptions are not available on Apple CarPlay").
* **No data access:** the SDK shows disruptions; it has no API that hands the app the list of reports, and ExitAtlas does not try to obtain one.
* **Requirements:** Navigation SDK 11.2.0 (September 2026), iOS 16 or later, Xcode 26; Maps SDK installed with it; Background Modes (location, audio); "Always" location and notification permission for guidance in the background ([setup](https://developers.google.com/maps/documentation/navigation/ios-sdk/config), [navigate a route](https://developers.google.com/maps/documentation/navigation/ios-sdk/route), [release notes](https://developers.google.com/maps/documentation/navigation/ios-sdk/release-notes)).

## 14.3 Costs

From the [Navigation SDK billing page](https://developers.google.com/maps/documentation/navigation/ios-sdk/usage-and-billing) and the [global price list](https://developers.google.com/maps/billing-and-pricing/pricing):

* Billed per destination requested: SKU "Navigation Request" (Enterprise). First 1,000 a month free, then $25.00 per 1,000 (2.5 cents each) up to 100,000, $20.00 to 500,000, $15.00 to 1,000,000, $8.00 to 5,000,000, $2.00 above.
* No charge to start guidance, for reroutes, traffic changes, closures or leaving the route. A route with 3 stops and a destination costs 4 destinations.
* The map itself (Maps SDK for iOS) is free and unlimited.
* Billing must be enabled on the Google Cloud project, and the key must allow the Navigation SDK for iOS and the Maps SDK for iOS. A daily quota cap in the Cloud console stops charges past a set number.

Estimates (Interpretation): one driver with 60 destinations a month pays $0 (under 1,000). A public app with 10,000 trips a month at 1.5 destinations each pays about (15,000 − 1,000) × $0.025 ≈ $350 a month. A user entering a key pays on their own Google account; a key shipped by ExitAtlas bills Coby Construction.

## 14.4 Google's rules that shape the design

From [Navigation SDK policies](https://developers.google.com/maps/documentation/navigation/ios-sdk/policies):

* **Commercial use only:** "You can use the Navigation SDK for iOS only for commercial applications." Owner decision: confirm with Google that ExitAtlas (published by Coby Construction LLC) qualifies before release.
* **Terms dialog:** "Your app must display ... the Navigation SDK terms of use" and the notices on independent judgment and tolls; the in product terms cannot be modified. The prototype calls Google's own `showTermsAndConditionsDialogIfNeeded` with the company name "ExitAtlas" and does nothing until it is accepted.
* **Safe UI changes only:** no distracting animations, no overlays on the navigation screen without explicit driver action, nothing that hides the driver's position, upcoming turns, lane guidance, compass or "all standard UI elements". The ExitAtlas panel sits below Google's map view, outside it.
* **Attribution:** Google Maps attribution included in the map must not be removed, hidden or obscured, and Google Maps content must be visually separated from other content (border, background, whitespace). The panel has its own background and a gap.
* **No scraping:** road names and speed limits returned during a session must not be kept for other uses. ExitAtlas reads no road names, speed limits, routes or disruptions from Google; its state progress comes from its own route and GPS, as in the native app. Google's route is never drawn on another map or fed into ExitAtlas calculations.
* **License restrictions** of the [Google Maps Platform Terms](https://cloud.google.com/maps-platform/terms) apply (no caching or redistribution of Google content). Police reports stay inside Google's own interface.

## 14.5 Proof of concept: the experimental Google build

Branch `claude/google-nav-experiment`, draft PR #15, **not merged**: it can only be judged on a phone, with a key and Google's terms accepted.

* **Separate build:** a second app target `ExitAtlasGoogle` in `App/project.yml` with the same sources and bundle identifier (installing it over ExitAtlas keeps every saved preference, and installing the regular build again removes Google), plus Google's package `GoogleNavigation` 11.2.0 and the `GOOGLE_NAVIGATION` flag. The regular `ExitAtlas` target is unchanged and never links Google; CI fails if the regular app ever contains Google's SDK.
* **Off until set up:** in the Google build, Settings has a "Navigate with Google (experimental)" section with the key (stored in the Keychain, this device only), what is shared and what it costs, and the destinations used this month. Without a key, nothing Google related appears elsewhere.
* **Entry:** Trip, "Navigate with Google (experimental)", for planned trips with a destination.
* **Consent:** an ExitAtlas sheet first (Google receives your location and route while it navigates; police and camera alerts come from Google Maps users; each destination is a billed request on the key's Google account; ExitAtlas does not read or keep Google's reports). Then Google's terms dialog, then location "Always" and notifications. Declining any step returns to the native app.
* **Navigation:** Google's map with navigation enabled, the traffic layer on, callouts, alerts, cards and the report button left at Google's defaults, voice "alerts and guidance", background notifications on, camera following. Destinations: the remaining ExitAtlas stops and destination (up to 25), counted toward the monthly total before the request.
* **ExitAtlas panel:** below the map, never over it: current state badge, miles to the next state line or "final state", exits left in the state, the next exit. It comes from the ExitAtlas trip, which keeps tracking with its own GPS. ExitAtlas voice pauses for the whole Google session (Google speaks the guidance and the alerts), so the two never talk over each other.
* **Parked tests** (a menu in the top bar, outside the map): "Simulate the drive (parked test)" moves Google's simulated location along the route, and "Show Google's test alert" shows Google's own test traffic prompt (`simulateTrafficIncidentReport`). The top bar reads "SIMULATED DRIVE · TEST" while the simulation runs; neither is ever presented as a real report.
* **End:** stops guidance, clears Google's destinations and returns to the native Drive screen; the ExitAtlas trip continues.

## 14.6 Setup steps (owner)

1. Google Cloud console: create or pick a project, enable billing, enable **Navigation SDK for iOS** and **Maps SDK for iOS**.
2. Create an API key restricted to iOS apps with bundle `com.cobyconstruction.exitatlas` and to those two APIs.
3. Quotas: set a daily cap on Navigation SDK requests (for one driver, 40 a day keeps a month under the free 1,000).
4. On a Mac with Xcode 26: `cd App && xcodegen generate`, open `ExitAtlas.xcodeproj` on the branch `claude/google-nav-experiment`, choose the `ExitAtlasGoogle` scheme, set your Apple developer team, and run it on the iPhone (USB or Wi Fi). It installs over ExitAtlas and keeps your data.
5. In the app: Settings, Navigate with Google, paste the key. Plan a trip, then Trip, Navigate with Google.
6. To go back: run the `ExitAtlas` scheme again (or the App Store or TestFlight build when there is one).

## 14.7 Real device test plan

Record date, iOS version, phone and result for each line in this section.

| ID | Test | Pass when |
|---|---|---|
| P1 | Consent sheet, then Google's terms dialog naming ExitAtlas | Both appear once; declining returns to the native app with nothing sent |
| P2 | Location Always and notification prompts | Shown after the terms; record whether guidance runs with "While Using" only and whether it continues in the background |
| P3 | Route to the trip's destination | Google route appears; the monthly counter goes up by the number of destinations; Cloud console shows the same count |
| P4 | Simulate the drive (parked) | Voice guidance plays; the ExitAtlas panel stays below the map and never covers turns, lanes, compass or attribution |
| P5 | Show Google's test alert (parked) | Google's test prompt appears and is not mistaken for a real report |
| D1 | Drive a U.S. interstate where Google Maps shows police (passenger checks Google Maps or Waze on another phone) | A police callout shows on the route and an approach alert is spoken; if no police appear on any test drive, record "not observed", not "not supported" |
| D2 | Crash, construction or speed camera on the route | Callout, spoken alert and voting prompt |
| D3 | Report button (passenger only) | Google's report menu opens; never touched by the driver while moving |
| D4 | Screen locked or another app open | Spoken guidance and alerts continue |
| D5 | State line crossing | The panel's state and miles match the native Drive screen after the crossing |
| D6 | End Google navigation | Native Drive screen returns with the trip, miles per state and SmartStop intact; ExitAtlas voice resumes |
| D7 | CarPlay | Guidance shows; disruptions do not (documented limit) |
| F1 | Airplane mode, then start | Clear error and a way back; no "all clear" anywhere |
| F2 | Wrong or unrestricted key | Google's error; the native app unaffected |

## 14.8 Platform limits

* No police or disruption data on CarPlay through the SDK; ExitAtlas's own CarPlay template work (docs/10) is unaffected.
* Police availability by country is not published; U.S. availability needs the D1 drive.
* The SDK needs iOS 16, Xcode 26 and background location; the app's App Privacy answers must add location shared with Google before an App Store release.
* The SDK is commercial use only (14.4) and adds about 50 MB of Google libraries to the Google build (UNVERIFIED final size).
* Google reports cannot be shown in ExitAtlas's own Road Ahead list, spoken by ExitAtlas, or used offline; they exist only inside Google's navigation screen.
* One destination change is a billed request; changing stops repeatedly costs money.

## 14.9 Waze handoff (live on the website and in the app)

From [Waze deep links](https://developers.google.com/waze/deeplinks):

* Link: `https://waze.com/ul?ll=LAT,LON&navigate=yes&utm_source=…`. It opens the Waze app when installed and the Waze website otherwise. `utm_source` names ExitAtlas, as Waze asks of partners.
* iOS: as Waze documents, `canOpenURL("waze://")` (with `waze` in `LSApplicationQueriesSchemes`) decides between the link and Waze's App Store page (id 323229106).
* Where: Trip, "Drive to (next stop or destination) in Waze"; exit details, rest areas and Discover places, "Waze" beside Apple Maps and Google Maps. One destination per link, so a trip with stops hands off the next stop.
* Built the same way by both engines (`NavigationHandoff.swift`, `web/js/engine/handoff.js`, shared cases in `Tests/ExitAtlasCoreTests/Fixtures/handoff`).
* Waze shows its own police reports in its own app; ExitAtlas reads nothing back from Waze.

## 14.10 Roadbeacon as a future reporting provider

Source: [github.com/jooray/roadbeacon](https://github.com/jooray/roadbeacon) at 83f7dd9 (2026-10-27): `README.md`, `SPECIFICATION.md`, `nips/road-events.md`.

* **License:** code under the Unlicense (public domain). The reports themselves carry no license: they are posts by individual users on public Nostr relays, each relay with its own terms. Interpretation: showing them in ExitAtlas is not the same as being allowed to redistribute them; it needs a decision with counsel (13.5).
* **Protocol:** Nostr events, kind 1315 for reports and kind 1316 for votes ("still there", "no longer there"); position as `lat`, `lon` and geohash tags at 4, 5 and 6 characters; type in `t` (police, police_station, speed_camera, surveillance_camera, traffic_jam, accident, road_closure, construction, hazard, road_condition, pothole, fog, ice, animal, other); NIP-40 expiration of at least 14 days; display lifetime by type (police 4 hours, cameras 30 days), extended by "still there" votes and cut by "no longer there". The independent Roadstr navigation app writes the same layout. Default relays: relay.damus.io, nos.lol, relay.primal.net, offchain.pub.
* **Fit with ExitAtlas:** a report maps cleanly to a Road Intelligence incident (point geometry, kind, reported time, expiry, community verification, no direction), so it could be one more provider with "community report, unverified" labels and the same expiry rules. Reading needs a WebSocket client (browser `WebSocket`, iOS `URLSessionWebSocketTask`).
* **Coverage, measured** (CI probe `tools/probes/roadbeacon_coverage.mjs` on branch `claude/google-nav-experiment`, 2026-10-29 04:01Z and again 04:05Z with the same totals, six relays, counts only): 367 reports worldwide from 52 authors, all from the last 30 days (relays drop events once they expire); 6 police reports worldwide, 147 speed cameras; newest 4 hours old, 3 in the last 24 hours. **United States: 2 reports (both hazards, from 1 author) and 0 police reports**, no votes on U.S. reports.
* **Freshness:** decided by the reporter's clock and votes; police reports show for 4 hours unless confirmed. With near zero U.S. traffic, nothing is fresh where ExitAtlas drives.
* **Abuse prevention:** weak by design. "Trust all model (v1): no reputation system. All users are trusted equally." Users may sign every report with a new throwaway key, so one person can post any number of reports and votes at no cost; a reputation system is listed as future work. Relay operators see the reporter's IP address.
* **Recommendation:** do not integrate now. Revisit if U.S. volume grows and a reputation or proof of work scheme exists; then add it as a separately switched provider labeled "Community report (Roadbeacon), unverified", never mixed with official sources, and only after the reporting decision in 13.5.

## 14.11 Effect on the police verdict (13.1)

The verdict stands for data ExitAtlas shows itself: there is still no authorized feed of police reports to display in ExitAtlas's own screens. The Google navigation mode is a different path: Google shows its own police reports inside its own navigation screen, under Google's terms, and ExitAtlas never receives them.
