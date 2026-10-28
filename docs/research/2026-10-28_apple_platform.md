# ExitAtlas: Apple platform capabilities research (as of 2026-10-28)

Scope: iOS road-trip companion (SwiftUI, Core Location background updates, MapKit routing, not turn-by-turn navigation). Sources are Apple developer documentation (read through the docs JSON behind developer.apple.com/documentation), WWDC session transcripts, the App Review Guidelines, and the CarPlay Developer Guide PDF. Anything that could not be confirmed against an Apple primary source is marked **UNVERIFIED**.

## 0. Version context

- **iOS 27 is the current release.** It was announced at WWDC26 (June 2026). Secondary coverage says the public release was **September 14, 2026** ([MacRumors](https://macrumors.com/2026/09/09/apple-announces-ios-27-release-date/)). Apple's own docs back this up: the CarPlay Developer Guide is dated **2026-10-13** and documents iOS 27 features and **Xcode 27** with no beta label.
- **iOS 26.4 (spring 2026)** added three things relevant here: the CarPlay voice-based conversational category, a template depth of 3 for driving task apps, and the voice control template for driving task apps.
- **App Review Guidelines:** the page footer says "Last Updated: October 16, 2026" ([guidelines](https://developer.apple.com/app-store/review/guidelines/)).
- **CarPlay Developer Guide:** [PDF](https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf). HTTP Last-Modified is Tue, 13 Oct 2026 and the file is 25,157,306 bytes; the copy I read matched both.

---

## 1. Live Activities (ActivityKit)

### 1.1 Hard limits (verified)
| Item | Value | Source |
|---|---|---|
| Payload size | "Static and dynamic data for a Live Activity, including data for ActivityKit updates and ActivityKit push notifications, can't exceed a combined size of **4 KB**." The `ActivityAuthorizationError.attributesTooLarge` error reads "exceeded the maximum size of 4KB". | [Displaying live data](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities), [ActivityAuthorizationError](https://developer.apple.com/documentation/activitykit/activityauthorizationerror) |
| Active duration | "A Live Activity can be active for up to **eight hours**". After that the system ends it and removes it from the Dynamic Island. | same |
| Lock Screen after end | Stays "for up to **four additional hours** … a Live Activity remains on the Lock Screen for a maximum of **12 hours**." | same |
| Ended-activity dismissal | `.default` keeps it for up to 4 h. `.immediate` removes it at once. `.after(date)` takes a date within the 4 h window. HIG: "In most cases, 15 to 30 minutes is adequate." In CarPlay and the Dynamic Island an ended activity is removed immediately. | same; [HIG Live Activities](https://developer.apple.com/design/human-interface-guidelines/live-activities) |
| Stale date | Optional `ActivityContent.staleDate`. When it passes, `activityState` becomes `.stale` and `context.isStale` becomes true, so the UI can show "data may be outdated". You can advance it with each update, and set it in a push payload as `stale-date`. | [staleDate](https://developer.apple.com/documentation/activitykit/activitycontent/staledate), [push article](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications) |
| Sandbox | "unlike a widget, a Live Activity **can't access the network or receive location updates**". All data has to come from the app (ActivityKit) or from APNs. | Displaying live data |
| Images | Assets must be no larger than the presentation size, or "the system might fail to start the Live Activity". | same |
| Count | No fixed number is documented: "the exact number may depend on a variety of factors". There are separate errors for `targetMaximumExceeded` (per app) and `globalMaximumExceeded` (per device). | same; ActivityAuthorizationError |
| Lock Screen height | "The system may truncate a Live Activity if its height exceeds **160 points**." | same |

### 1.2 Starting a Live Activity
- You start one with `Activity.request(...)` **while the app is in the foreground**. Starting from the background throws `ActivityAuthorizationError.visibility` ("The app tried to start the Live Activity while it was in the background"). The exceptions are:
  - A `LiveActivityIntent` (iOS 17+): Siri, Shortcuts, a Control Center control, or a widget or Live Activity button.
  - **Push-to-start** (iOS 17.2+, `pushToStartTokenUpdates`). This needs a server.
  - Sources: [request](https://developer.apple.com/documentation/activitykit/activity/request(attributes:content:pushtype:)), [visibility](https://developer.apple.com/documentation/activitykit/activityauthorizationerror/visibility), [LiveActivityIntent](https://developer.apple.com/documentation/appintents/liveactivityintent), [pushToStartTokenUpdates](https://developer.apple.com/documentation/activitykit/activity/pushtostarttokenupdates)
- **Implication for long drive days.** A drive day over 8 hours needs a new Live Activity, and a backgrounded app with location updates **cannot** start one itself. The options are:
  1. The user opens the app.
  2. The user runs an App Shortcut or control backed by a `LiveActivityIntent`.
  3. Push-to-start from a server.
  - Plan an "end and offer restart" flow. Set `staleDate` well before the 8 h cap.

### 1.3 Local updates vs push: do we need APNs and a server?
- **Local updates are documented as allowed in the background.** The `update(_:)` docs say: "Use this function to update the Live Activity while your app is in the foreground or while it's in the background — for example, by using BackgroundTasks." WWDC23 *Meet ActivityKit* says Live Activities "can provide real-time updates from background app runtime or remotely using Push Notifications." Sources: [update(_:)](https://developer.apple.com/documentation/activitykit/activity/update(_:)), [WWDC23 10184](https://developer.apple.com/videos/play/wwdc2023/10184/)
- **Conflicting Apple forum guidance.** A Frameworks Engineer wrote: "The only supported way is by using push notifications, unless as you've observed, your app is in the foreground" ([forum 776031](https://developer.apple.com/forums/thread/776031)). That thread involved an app woken by silent pushes, not one held running by continuous location.
  - My reading: an app that background location keeps running can call `activity.update` locally. Updates stop whenever the app is suspended, for example during an automatic stationary pause at a rest stop, or after termination. This is **UNVERIFIED as officially supported**; test it on device.
- **No documented budget for local updates.** Apple publishes no rate limit for `activity.update` from a running app (**UNVERIFIED** whether a hidden throttle exists). The HIG says "Update a Live Activity only when new content is available." A sensible client-side cap is one update per meaningful change, for example when the next exit changes or the distance crosses a 0.1 to 0.5 mi bucket, and roughly every 15 to 30 s at most. That cap is my recommendation, not an Apple number.
- **Push budget (documented).** "The system allows for a certain budget of ActivityKit push notifications per hour."
  - `apns-priority: 10` (the default) counts against the budget. Exceeding it "may throttle" pushes.
  - `apns-priority: 5` "doesn't count toward the budget". WWDC23 10185 says low priority has "no limit on how many updates you can send" but is delivered opportunistically.
  - For higher high-priority volume, set `NSSupportsLiveActivitiesFrequentUpdates = YES`. Users can turn this off; check `ActivityAuthorizationInfo().frequentPushesEnabled`.
  - The hourly number is not published (**UNVERIFIED**).
  - Sources: [push article](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications), [WWDC23 10185](https://developer.apple.com/videos/play/wwdc2023/10185/), [NSSupportsLiveActivitiesFrequentUpdates](https://developer.apple.com/documentation/bundleresources/information-property-list/nssupportsliveactivitiesfrequentupdates)
- **Push mechanics.**
  - Headers: `apns-push-type: liveactivity`, `apns-topic: <bundleID>.push-type.liveactivity`.
  - Payload: `aps.event` set to `update`, `end` or `start`, plus `content-state`, `timestamp`, and optionally `stale-date`, `dismissal-date`, `relevance-score` and `alert`.
  - Broadcast channels (iOS 18) are meant for one-to-many events and cannot start a Live Activity.
- **Answer.** APNs and a server are **not required** for an MVP that updates locally while location keeps the app running. A server is required to:
  1. Update while the app is suspended or killed.
  2. Restart after the 8 h cap without user action (push-to-start).
  3. Use WidgetKit push.
- **Note.** WWDC23 *Discover streamlined location updates* says a Live Activity can enable background location for a When-In-Use app. A developer report says location stopped about 10 s after backgrounding even with a Live Activity visible, and that holding `CLBackgroundActivitySession` fixed it ([forum 788647](https://developer.apple.com/forums/thread/788647), no Apple reply). **Hold a `CLBackgroundActivitySession` explicitly; don't rely on the Live Activity alone.**

### 1.4 Presentations (iPhone)
- **You must support all of them:** Lock Screen, compact (leading + trailing), minimal, and expanded ([docs](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)).
- **Expanded regions:** `.leading`, `.trailing`, `.center` (below the camera) and `.bottom`. Use `priority:` and `belowIfTooWide`.
- **Reduced width:** read `isDynamicIslandLimitedInWidth` and "fit inside a circle that's **28 points** in diameter". The docs say iPhone 18 Pro shows two Live Activities side by side at reduced width. In **iOS 27 the Dynamic Island shows Live Activities in landscape too**, where compact views cannot grow in width ([WWDC26 223 "Live Activities essentials"](https://developer.apple.com/videos/play/wwdc2026/223/)).
- **Minimal:** used when several activities are running. Up to three appear (one attached, others detached). The HIG says to show updated information, not just a logo.
- **HIG specs (pt):**

  | Screen | Compact (each side) | Minimal | Expanded | Lock Screen | Limited width |
  |---|---|---|---|---|---|
  | 430×932 | 62.33×36.67 | 36.67–45×36.67 | 408×84–160 | 408×84–160 | 28×28 |
  | 393×852 | 52.33×36.67 | 36.67–45×36.67 | 371×84–160 | 371×84–160 | 28×28 |

  The standard Lock Screen margin is 14 pt. Custom animations run for at most 2 s, and the system ignores animation modifiers. StandBy scales the Lock Screen view to 2x.
- **Other:**
  - Buttons and toggles must use App Intents.
  - Alerting updates go through `update(_:alertConfiguration:)`. Use them sparingly.
  - A `relevanceScore` picks which of your activities wins the Dynamic Island.
  - Live Activities also appear in the **Mac menu bar** (macOS Tahoe).

### 1.5 CarPlay (iOS 26+): no CarPlay entitlement needed
- From the CarPlay Developer Guide (Oct 2026):
  - "Live Activities are shown in CarPlay Dashboard, or as a notification. **Your app does not need to be a CarPlay app** to support Live Activities in CarPlay. Live Activities are supported with iOS 26 in CarPlay and CarPlay Ultra."
  - "To enable your Live Activity in CarPlay, support the small activity family. This is the same size used for Live Activities in the Apple Watch Smart Stack": `.supplementalActivityFamilies([.small])`.
  - "If you don't support the small activity family, CarPlay will show the compact leading and compact trailing views from your Dynamic Island configuration instead."
- **Non-interactive.** "Buttons and toggles on Live Activities don't perform actions in CarPlay" ([docs](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities); HIG).
- **Alerts.** If the Dashboard isn't visible, CarPlay shows important alerts "as a notification at the bottom of the display" ([WWDC25 216](https://developer.apple.com/videos/play/wwdc2025/216/)).
- **Layout.** In the view, read `@Environment(\.activityFamily)` and return a dedicated small layout when it is `.small`. Otherwise CarPlay renders your Lock Screen view, which may be cramped ([WWDC25 278](https://developer.apple.com/videos/play/wwdc2025/278/), [WWDC26 223](https://developer.apple.com/videos/play/wwdc2026/223/)). `ActivityFamily` and `supplementalActivityFamilies(_:)` are iOS 18.0+ ([ActivityFamily](https://developer.apple.com/documentation/widgetkit/activityfamily), [supplementalActivityFamilies](https://developer.apple.com/documentation/swiftui/widgetconfiguration/supplementalactivityfamilies(_:)), [custom views](https://developer.apple.com/documentation/activitykit/creating-custom-views-for-live-activities)).
- **HIG CarPlay sizes (pt):** **240×78, 240×100, 170×78**. Test at the Smart Display Zoom configurations: Widescreen 1920×720, Portrait 900×1200, Standard 800×480 ([HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities)). The HIG also says: "If people are likely to start or observe your Live Activity while driving, prefer displaying timely content rather than buttons and toggles."
- **UNVERIFIED:** whether tapping the Live Activity in CarPlay can open a non-CarPlay app. For widgets, the guide says a widget "can only launch your app in CarPlay if your app is also a CarPlay app".
- **Settings.** Users can turn Live Activities off, or silence alerts with a Focus mode (WWDC25 216).

### 1.6 Apple Watch Smart Stack
- Live Activities started on iPhone appear at the top of the Smart Stack. By default the watch combines the compact leading and trailing views. A custom `.small` layout serves both the watch and CarPlay. Buttons are interactive on the watch but disabled in CarPlay, so the HIG advises against buttons in the small layout if it will be seen while driving.
- Tapping opens the watchOS app if one exists. Otherwise it opens a full-screen view with a button to open the app on iPhone.
- Smart Stack sizes (pt):

  | Watch | 40mm | 41mm | 42mm | 44mm | 45mm | 46mm | 49mm Ultra 3/4 | 49mm Ultra 1/2 |
  |---|---|---|---|---|---|---|---|---|
  | Size | 152×69.5 | 165×72.5 | 176×72.5 | 173×76.5 | 184×80.5 | 194×80.5 | 198×81.5 | 191×81.5 |

  Source: [HIG](https://developer.apple.com/design/human-interface-guidelines/live-activities).

### 1.7 Recommended ExitAtlas Live Activity design (navigation-like content)
- **ContentState** stays small, well under 4 KB:
  - next exit (number, short name, 2–4 service icon flags) and distance
  - next state line (state code) and distance
  - ETA as a `Date`
  - last-updated date
  - Static attributes hold the trip id and destination name.
- **ETA:** use `Text(eta, style: .relative/.timer)` or `Text(timerInterval:)` so it ticks without updates ([Displaying dynamic dates](https://developer.apple.com/documentation/widgetkit/displaying-dynamic-dates)). Distances can't tick by themselves and need updates.
- **Compact:** leading is an exit glyph with the number; trailing is "2.4 mi". Minimal shows the distance. Expanded shows the next exit with services, a state-line row, and ETA. The `.small` layout (CarPlay and Watch) is large type with the next exit and distance, plus a state line. No buttons.
- **Freshness:** set `staleDate` to now + a few minutes on every update so a suspended app shows "stale" rather than wrong data.
- **Alerts:** keep them for rare, important events only (for example "last fuel for 60 mi"), using an alert configuration.

---

## 2. CarPlay

### 2.1 Categories, entitlements and minimum iOS (CarPlay Developer Guide, 2026-10-13)
| Category | Entitlement key | Min iOS |
|---|---|---|
| Audio | com.apple.developer.carplay-audio | 14 |
| Communication | com.apple.developer.carplay-communication | 14 |
| **Driving task** | **com.apple.developer.carplay-driving-task** | 16 |
| EV charging | com.apple.developer.carplay-charging | 14 |
| **Fueling** | **com.apple.developer.carplay-fueling** | 16 |
| Navigation | com.apple.developer.carplay-maps | 12 |
| Parking | com.apple.developer.carplay-parking | 14 |
| Public safety | com.apple.developer.carplay-public-safety | 14 |
| Quick food ordering | com.apple.developer.carplay-quick-ordering | 14 |
| **Video (new 2026)** | com.apple.developer.carplay-video | **27** |
| **Voice-based conversational (new 2026)** | com.apple.developer.carplay-voice-based-conversation | **26.4** |

- "Multiple categories cannot be combined in a single app, with the exception of EV charging and fueling apps." Audio and video apps also appear on Apple HomeView.
- A developer reports holding both driving-task and voice-based-conversation entitlements ([forum 823974](https://developer.apple.com/forums/thread/823974)). That contradicts the guide; treat it as **UNVERIFIED/anecdotal**.

### 2.2 Templates per category and depth limits (guide)
| Template | Audio/Video | Comm. | Driving task + Voice conv. | EV/Fueling/Parking | QFO | Public safety | Navigation |
|---|---|---|---|---|---|---|---|
| Action sheet | ●(iOS17) | ● | ● | ● | ● | ● | ● |
| Alert, Grid, List, Tab bar | ● | ● | ● | ● | ● | ● | ● |
| Voice control | ●(27) | ●(27) | ●(**26.4**) | ●(27) | ●(27) | ●(27) | ● |
| Contact | | ● | | | | ● | ● |
| Information | | ● | ● | ● | ● | ● | ● |
| Map | | | | | | | ● only |
| Now playing | ● | ●(17) | | | | ● | |
| Point of interest | | | ● | ● | ● | ● | |
| Search | ●(27) | | | ●(**27**) | | ●(27) | ● |

- **Depth (root included):**
  - Audio, communication, EV charging, parking, public safety and navigation: **5**.
  - **Fueling** and voice-based conversational: **3**.
  - **Driving task** and quick food ordering: **2** on iOS 26.3 and earlier, **3** on iOS 26.4 and later.
  - Using a template your category doesn't support throws an exception at runtime.
- **Other limits:**
  - Grid: up to 8 buttons.
  - POI template: "up to 12 locations". Do not refresh POIs more than once every 60 s (driving task rule).
  - Information template: up to 3 actions ([CPInformationTemplate](https://developer.apple.com/documentation/carplay/cpinformationtemplate)).
  - Tab bar: up to 5 tabs (4 for audio). Read the maximum at runtime.
  - Lists: "Some cars dynamically limit lists to **12** list items". Use `CPListTemplate.maximumItemCount` ([doc](https://developer.apple.com/documentation/carplay/cplisttemplate/maximumitemcount)) and `CPSessionConfiguration.limitedUserInterfaces`.
  - The keyboard is often unavailable while driving. Search must never be the primary path.
- **iOS 27 additions** ([WWDC26 212 "Rev up your CarPlay app"](https://developer.apple.com/videos/play/wwdc2026/212/)):
  - List thumbnails with overlays and details headers.
  - A Now Playing MiniPlayer.
  - The voice control template for all categories, also as an overlay, with up to 2 action buttons.
  - Navigation map panels and Route sharing (Route sharing needs 26.4+).
  - The video category, playable only when parked.
  - Search for fueling, EV charging and parking.

### 2.3 Requesting the entitlement and eligibility
- **Process.** Go to [developer.apple.com/carplay](https://developer.apple.com/carplay/), then "Request CarPlay app entitlement" ([contact/carplay](https://developer.apple.com/contact/carplay/), sign-in required). You agree to the **CarPlay Entitlement Addendum**. "Apple will review your request. If your app meets the criteria for the CarPlay app category, Apple will assign a CarPlay app entitlement to your Apple Developer account."
- **Setup after approval.** Enable the capability on the App ID, create a new provisioning profile, turn off automatic signing, and add `Entitlements.plist` ([Requesting CarPlay Entitlements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)).
- **Visibility.** "You cannot selectively show or hide CarPlay for certain people. Only publish your app with CarPlay support when you are ready for everyone to see it."
- **Rules for all CarPlay apps:**
  1. Designed primarily for the category's feature.
  2. Never tell people to pick up the iPhone.
  3. Every flow works without touching the iPhone.
  4. Every flow is meaningful while driving; no unrelated settings or maintenance screens.
  5. No games or social networking.
  6. Never show message, text or email content.
  7. Use templates for their intended purpose.
- **Timing.** Apple publishes no SLA. Forum reports range from about 4 weeks to months or no response ([759267](https://developer.apple.com/forums/thread/759267), [848946](https://developer.apple.com/forums/thread/848946), [736111](https://developer.apple.com/forums/thread/736111)). **UNVERIFIED/anecdotal.** The criteria themselves aren't public.

### 2.4 Which category fits ExitAtlas (exits, rest areas, gas, food, state-line progress; no turn-by-turn)?
- **Navigation:** not eligible. "Navigation apps must provide turn-by-turn directions with upcoming maneuvers."
- **Driving task:** best conceptual fit.
  - Guide: "enable convenient access to services that are essential to the driving experience."
  - WWDC22 named examples include "apps that provide **driving or road status and information**". The demo was a road status app built on `CPPointOfInterestTemplate` ([WWDC22 10016](https://developer.apple.com/videos/play/wwdc2022/10016/)).
  - Frame ExitAtlas as "road status ahead": next exits and services, rest-area status, distance to the next state line.
  - Templates: list, grid, information, POI, tab bar, alert, action sheet, and voice control (26.4+). No map template, no search template. Depth 3 on iOS 26.4+.
  - Notifications are allowed (iOS 18.4+).
- **Fueling** (plus EV charging, which can be combined): a fallback with precedent.
  - Rules: "can't just be a list of fueling stations"; "When showing locations on a map, do not expose locations other than fueling stations". In CarPlay that means **fuel only**, with no food or rest areas.
  - Depth 3. Search and voice control on iOS 27.
  - **Precedent:** iExit's App Store release notes (v12.0.0, 2025-04-24): "We have only been approved for a CarPlay fueling app … it will only display the best exits ahead for gas, diesel, or electric charging stations." v12.1.0 (2025-05-13) then says "We have updated our CarPlay app to support finding food, rest areas, hotels" ([iExit App Store](https://apps.apple.com/us/app/id401746066)). Which entitlement iExit holds now is **UNVERIFIED**.
- **Quick food ordering and parking:** not applicable. QFO must be a quick-service-restaurant ordering app.
- **Recommendation.**
  - Apply for **Driving task**, describing road status and trip-progress tasks rather than a POI finder.
  - Keep gas and food as filters on "next exits", not as a store finder.
  - If refused, apply for **Fueling (+EV charging)** with a fuel-only CarPlay UI.
  - Ship the CarPlay **Live Activity and widget** first; neither needs an entitlement.

### 2.5 What the driving task category forbids (guide, verbatim points)
1. "Tasks must actually help with the drive, not just be tasks that are done while driving."
2. Templates only: "Other kinds of CarPlay UI (for example, custom maps, real-time video) are not possible."
3. No CarPlay UI for unrelated tasks such as account setup or detailed settings.
4. "Do not periodically refresh data items in the CarPlay UI more than **once every 10 seconds** (for example, no real-time engine data)."
5. "Do not periodically refresh points of interest in the POI template more than **once every 60 seconds**."
6. "**Do not create POI (point of interest) apps that are focused on finding locations on a map.** Driving tasks apps … are not intended to be location finders (for example, store finders)." This is the main risk for "Find the next Wawa" in CarPlay.
7. "Use cases outside of the vehicle environment are not permitted."
- Also from the guide:
  - Recording isn't supported in CarPlay, except for navigation and voice-based conversational apps, and only together with the voice control template.
  - The app must work while the iPhone is **locked**. Files with `NSFileProtectionComplete` or `CompleteUnlessOpen`, and WhenUnlocked keychain items, are unavailable.
  - The guide lists voice control as available to driving task apps from 26.4 but excludes them from the recording exception. **UNVERIFIED** whether a driving-task app may capture the microphone; ask Apple in the entitlement request.

### 2.6 Testing
- **CarPlay Simulator.** It is a Mac app that connects to a USB-attached iPhone "just like a car". "Starting with Xcode 27, CarPlay Simulator is included in **Device Hub**." It is also available standalone in **Additional Tools for Xcode** (Hardware folder), and video developers are told to use the standalone app (guide; WWDC26 212). It tests widgets, Live Activities and CarPlay apps across screen sizes, scales, light/dark and Smart Display Zoom.
- **Without an entitlement you can test:**
  - Widgets and Live Activities in CarPlay Simulator on a real iPhone, since the app need not be a CarPlay app ([WWDC25 216](https://developer.apple.com/videos/play/wwdc2025/216/)).
  - A CarPlay app's template UI only in the **Xcode iOS Simulator** (I/O > External Displays > CarPlay). Apple's docs say "Xcode and Simulator require a Provisioning Profile that supports CarPlay". Third-party docs (for example the [HERE SDK](https://docs.here.com/here-sdk/docs/ios-carplay)) report the iOS Simulator works with just the entitlement key in `Entitlements.plist` before approval. **UNVERIFIED by Apple.**
  - Installing a CarPlay app on a device, TestFlight and App Store all require the granted entitlement in the profile.

### 2.7 CarPlay widgets (iOS 26): available to non-entitled apps
- Guide: "Your app does not need to be a CarPlay app to support widgets." Widgets appear to the left of the CarPlay Dashboard and are interactive on touchscreen cars. Support `.supportedFamilies([.systemSmall])`. Users choose widgets under Settings > General > CarPlay > [vehicle].
- CarPlay renders widgets in StandBy style: systemSmall, full color, background removed ([WWDC25 278](https://developer.apple.com/videos/play/wwdc2025/278/)).
- Mark CarPlay as disfavored with `.disfavoredLocations([.carPlay], for: [.systemSmall])` if the widget:
  - is a game or needs heavy interaction (more than 6 taps or refreshes),
  - relies on data protection class A or B, or
  - exists mainly to launch a non-CarPlay app.
  - Source: [disfavoredLocations](https://developer.apple.com/documentation/swiftui/widgetconfiguration/disfavoredlocations(_:for:)).
- A widget can launch the app in CarPlay only if the app is a CarPlay app.

---

## 3. Voice

### 3.1 App Intents / App Shortcuts (Siri, Shortcuts, Spotlight, Action button)
- **Limits:**
  - "Each app can include up to **10 App Shortcuts**" ([HIG App Shortcuts](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts); also [WWDC22 10170](https://developer.apple.com/videos/play/wwdc2022/10170/)).
  - "Each phrase must include the applicationName placeholder. **Phrases can include up to one intent parameter**" ([WWDC25 244](https://developer.apple.com/videos/play/wwdc2025/244/)). App name synonyms are allowed.
  - Phrase parameters must have predefined values, either an **AppEnum** (static) or an **AppEntity** (dynamic, refreshed with `updateAppShortcutParameters()`). "Parameters are not meant for open-ended values … it's not possible to gather an arbitrary string from the user in the initial utterance" ([WWDC22 10170](https://developer.apple.com/videos/play/wwdc2022/10170/), [WWDC23 10102](https://developer.apple.com/videos/play/wwdc2023/10102/), [updateAppShortcutParameters](https://developer.apple.com/documentation/appintents/appshortcutsprovider/updateappshortcutparameters())).
  - A total phrase or utterance cap, often quoted as 1,000, is **UNVERIFIED**.
- **Design for ExitAtlas:**
  - `DistanceToStateIntent(state: USStateEnum)` with phrases like "How far to \(\.$state) in \(.applicationName)" and "\(.applicationName) how far until \(\.$state)". Plain "How far until Georgia?" with no app name will **not** match an App Shortcut.
  - `NextBrandIntent(brand: BrandEntity)`, for example "Find the next \(\.$brand) with \(.applicationName)", with brand entities (Wawa, Buc-ee's…) registered dynamically. Add phrase variants without the parameter; Siri then prompts for it.
- **Locked iPhone.** `authenticationPolicy` defaults to `.alwaysAllowed`, "which allows the intent to run without authentication, including when the device is locked" ([doc](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy)).
  - Keep these intents background (don't foreground the app; the WWDC25 `supportedModes` default doesn't foreground).
  - Read data that is accessible while locked (no `NSFileProtectionComplete`).
- **In CarPlay.** Siri can run intents, but the response is spoken only. Apple's sample notes that showing a snippet "may be inappropriate (such as when the intent runs through CarPlay)". Provide `IntentDialog(full:supporting:)` so the full spoken dialog carries everything ([Accelerating app interactions with App Intents](https://developer.apple.com/documentation/appintents/acceleratingappinteractionswithappintents)). **UNVERIFIED:** an exhaustive list of CarPlay restrictions on App Shortcuts; there's no dedicated Apple page.
- **iOS 26 / 27 changes:**
  - iOS 26 added interactive snippets ([WWDC25 275](https://developer.apple.com/videos/play/wwdc2025/275/)).
  - In the "27 releases", Siri (Apple Intelligence, "Siri AI") can access app **entities**, run intents, and understand on-screen context. This works through **App Schemas** grouped into domains ([WWDC26 240](https://developer.apple.com/videos/play/wwdc2026/240/), [343](https://developer.apple.com/videos/play/wwdc2026/343/), [344](https://developer.apple.com/videos/play/wwdc2026/344/), [345](https://developer.apple.com/videos/play/wwdc2026/345/); [Apple Intelligence and Siri AI](https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai); [App schema domains](https://developer.apple.com/documentation/appintents/app-schema-domains)).
  - There is a new **Maps domain** (iOS 27): startNavigation, updateNavigationWaypoints, stopNavigation, shareETA, stopShareETA, reportIncident, plus place, navigationSession and operatingHours entities ([Maps domain](https://developer.apple.com/documentation/appintents/app-schema-domain-maps)). It is designed for navigation apps, so a non-navigation app should not claim startNavigation. The `place` entity schema might help Siri understand POIs (**UNVERIFIED** fit).
  - Custom questions like "distance to the next state line" aren't covered by any schema. My inference is that App Shortcut phrases remain the reliable path (**UNVERIFIED** how well Siri AI handles non-schema intents).
  - Third-party claims that SiriKit was formally deprecated in iOS 27 are **UNVERIFIED** and irrelevant here, because ExitAtlas should use App Intents anyway.

### 3.2 In-app speech recognition
- **SpeechAnalyzer** (iOS 26+) with **SpeechTranscriber**.
  - It uses a new on-device model "good for long-form and distant audio" with low latency.
  - Model assets download through `AssetInventory`; they are shared system-wide and don't add to app size.
  - Check `SpeechTranscriber.isAvailable` and `supportedLocales`. Fall back to **DictationTranscriber**, the same model as on-device SFSpeechRecognizer, which supports older devices. `AnalysisContext.contextualStrings` can bias recognition toward place and brand names.
  - Sources: [SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer), [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber), [DictationTranscriber](https://developer.apple.com/documentation/speech/dictationtranscriber), [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory), [WWDC25 277](https://developer.apple.com/videos/play/wwdc2025/277/)
- **SFSpeechRecognizer:** set `requiresOnDeviceRecognition = true`. It is honored only if `supportsOnDeviceRecognition`; otherwise audio goes to Apple servers ([doc](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition)).
- **Permissions:**
  - `NSSpeechRecognitionUsageDescription` plus `requestAuthorization` are required for SFSpeechRecognizer, even on-device. Apple says that process "only applies to … SFSpeechRecognizer. SpeechAnalyzer transcriber modules don't send audio data … to Apple's servers" ([Asking permission](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition)).
  - Microphone permission (`NSMicrophoneUsageDescription`) is still needed for capture.
- **CarPlay constraints.** Recording is generally not supported in CarPlay (§2.5), and the iPhone UI shouldn't be used while driving. In-app speech is mainly useful on the phone (passenger, or while parked). For hands-free use while driving, prefer Siri plus App Shortcuts.

### 3.3 Driver-distraction rules (what applies)
- **App Review 1.4.5:** "Apps should not urge customers to … use their devices in a way that risks physical harm to themselves or others."
- **App Review 1.4.4:** never "encourage drunk driving or other reckless behavior such as excessive speed."
- **CarPlay Guidelines:** never instruct people to pick up the iPhone; all flows must work without the iPhone; refresh limits; no message content. For voice-based conversational apps: "don't show text or imagery in response to queries". Only hold the audio session while voice is in use.
- **HIG CarPlay:** "Never lock people out of CarPlay because the connected iPhone requires input"; "Make sure your app works without requiring people to unlock iPhone" ([HIG CarPlay](https://developer.apple.com/design/human-interface-guidelines/carplay)).
- **Audio:** activate the audio session only when about to speak. For spoken prompts use `.playback` + `.voicePrompt` + `[.duckOthers, .interruptSpokenAudioAndMixWithOthers]`, as the guide prescribes for navigation apps.

---

## 4. Background location and battery

### 4.1 Recommended APIs (iOS 17 → 27)
- **`CLLocationUpdate.liveUpdates(.automotiveNavigation)`** (iOS 17+). An async sequence; each update carries `location` and `isStationary`, plus diagnostics such as `authorizationDenied` and `insufficientlyInUse` ([liveUpdates](https://developer.apple.com/documentation/corelocation/cllocationupdate/liveupdates(_:)), [LiveConfiguration](https://developer.apple.com/documentation/corelocation/cllocationupdate/liveconfiguration)).
  - Configurations: default, automotiveNavigation, otherNavigation, fitness, airborne, and maritime (iOS 27).
  - **Automatic pause and resume.** When stationary long enough, updates pause and "later, when the device becomes non-stationary, updates will **automatically resume** without any user interaction" ([WWDC23 10180](https://developer.apple.com/videos/play/wwdc2023/10180/)). This suits rest stops.
- **Contrast with legacy `CLLocationManager`.** `pausesLocationUpdatesAutomatically` (default true) with When-In-Use authorization "ends access to location changes until the app launches again" ([doc](https://developer.apple.com/documentation/corelocation/cllocationmanager/pauseslocationupdatesautomatically)). If you use the manager, set `activityType = .automotiveNavigation` and think carefully about pausing. `.automotiveNavigation` "might cause the system to pause location updates when the vehicle doesn't move for an extended period of time" ([doc](https://developer.apple.com/documentation/corelocation/clactivitytype/automotivenavigation)).
- **`CLBackgroundActivitySession`** (iOS 17+): lets a **When-In-Use** app keep receiving updates in the background, shown with the blue background-location indicator.
  - Requirements: `UIBackgroundModes` must contain `location`. You must hold a strong reference (deallocation invalidates it). Start it in the foreground; you can rejoin an existing session from the background.
  - Sources: [doc](https://developer.apple.com/documentation/corelocation/clbackgroundactivitysession-3mzv3), [Handling location updates in the background](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background), WWDC23 10180.
- **`CLServiceSession`** (iOS 18+): declares authorization goals (`.whenInUse` or `.always`, optionally with a `fullAccuracyPurposeKey`). Core Location re-asks after lapses.
  - Iterating `liveUpdates` creates **implicit** sessions, unless `NSLocationRequireExplicitServiceSession` is set.
  - "Starting this year, **Always authorization will only be effective when you hold one** of these, and you can only start holding one when your app is in the foreground" ([WWDC24 10212](https://developer.apple.com/videos/play/wwdc2024/10212/), [CLServiceSession](https://developer.apple.com/documentation/corelocation/clservicesession-pt7n)).
  - If the app is terminated, recreate sessions and restart updates immediately on background relaunch.
- **Recommendation:** When-In-Use plus `CLBackgroundActivitySession` plus `liveUpdates(.automotiveNavigation)`, started from an explicit "Start trip" action in the foreground. Avoid asking for Always.

### 4.2 Battery
- Apple publishes **no numbers** for battery drain from continuous automotive location (**UNVERIFIED** any specific % per hour).
- Apple's guidance is qualitative: "improper or unnecessary use of location can prevent the device from sleeping, keep location hardware powered up, drain the user's battery". It recommends:
  - stopping updates when not needed,
  - reducing `desiredAccuracy` and using `distanceFilter` where possible,
  - auto-pause plus an activity type, and
  - significant-change updates only as a last resort.
  - Source: [Energy Efficiency Guide (archived)](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/LocationBestPractices.html).
- `liveUpdates` doesn't expose accuracy or distance filters; the configuration picks power behavior.
- Mitigations:
  - end the trip session automatically on arrival,
  - throttle UI, Live Activity and widget work rather than location,
  - phones are usually charging on CarPlay or USB.
- Measure with the Xcode energy gauge, Instruments, or MetricKit (location activity metrics).
- App Review **2.4.2**: "Apps should not rapidly drain battery".

### 4.3 Privacy strings and App Review
- **`NSLocationWhenInUseUsageDescription`** is required. **`NSLocationAlwaysAndWhenInUseUsageDescription`** is needed only if you request Always ([When-In-Use](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationwheninuseusagedescription), [Always](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationalwaysandwheninuseusagedescription)).
- Setting `allowsBackgroundLocationUpdates = true` without `UIBackgroundModes` containing `location` "is a fatal error" ([doc](https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates)).
- **5.1.1(ii):** "Ensure your purpose strings clearly and completely describe your use of the data."
- **5.1.1(iv):** "if a user declines to share Location, offer the ability to manually enter an address". Support a manual or route-only mode.
- **5.1.1(i):** a privacy policy is required, both in the app and in App Store Connect. Apple's docs also say to encrypt stored or transmitted location ([Configuring location services](https://developer.apple.com/documentation/corelocation/configuring-your-app-to-use-location-services)).
- **5.1.5:** "Use Location Services in your app only when it is directly relevant … explain the purpose in your app."
- **2.5.4:** "Multitasking apps may only use background services for their intended purposes: … location …"
- An example purpose string: "ExitAtlas uses your location during an active trip, including when the app is in the background, to show upcoming exits, services and your distance to the next state line. Location is not used when no trip is active."

---

## 5. Widgets (Home Screen / Lock Screen) for trip progress
- **Families:**
  - Home Screen: systemSmall, systemMedium, systemLarge. systemSmall also covers StandBy, **CarPlay** and HomeView.
  - Lock Screen: accessoryCircular, accessoryRectangular, accessoryInline.
  - Source: [HIG Widgets](https://developer.apple.com/design/human-interface-guidelines/widgets).
- **Refresh budget** ([Keeping a widget up to date](https://developer.apple.com/documentation/widgetkit/keeping-a-widget-up-to-date)):
  - "For a widget the user frequently views, a daily budget typically includes from **40 to 70 refreshes**. This rate roughly translates to widget reloads every **15 to 60 minutes**". The budget is per widget instance over a 24 h window tuned to usage.
  - Timeline entries should be "at least about **5 minutes** apart".
  - **Not counted** against the budget: app in the foreground; "**active audio or navigation session**"; Now Playing app; App Intent interactions; animations; locale or accessibility changes.
  - **UNVERIFIED** whether an app with background location (`automotiveNavigation` + `CLBackgroundActivitySession`) counts as a "navigation session"; Apple doesn't define it.
  - WWDC26 adds: "frequent reloads while your app is in the foreground might be throttled" ([WWDC26 277](https://developer.apple.com/videos/play/wwdc2026/277/)).
- **WidgetKit push** (iOS 26+, `WidgetPushHandler`, `apns-push-type: widgets`): "the system budgets WidgetKit push notifications and delivers them opportunistically". This needs a server ([doc](https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications), [WidgetPushHandler](https://developer.apple.com/documentation/widgetkit/widgetpushhandler)).
- **Location in widgets.** Set `NSWidgetWantsLocation`. Location is available only for a short "in use" window after the widget is visible ([doc](https://developer.apple.com/documentation/widgetkit/accessing-location-information-in-widgets)). Simpler: the app writes trip state to an App Group container (not class A/B protection) and calls `WidgetCenter.reloadTimelines` when something significant changes.
- **No-reload tricks.** `Text(date, style: .timer/.relative)`, `Text(timerInterval:)`, and `ProgressView(timerInterval:)` animate time-based progress for free ([Displaying dynamic dates](https://developer.apple.com/documentation/widgetkit/displaying-dynamic-dates)). Distance-based progress needs reloads.
- **Conclusion.** Widgets suit coarse trip summaries (miles today, states crossed, next planned stop); expect 15–60 min freshness. Use the Live Activity for live next-exit and state-line distance.

---

## 6. App Store review risks (guideline citations)
| Risk | Guideline / rule | Mitigation |
|---|---|---|
| Encouraging phone use while driving | 1.4.5 (physical harm); 1.4.4 (reckless behavior, speed) | Glanceable Live Activity, CarPlay widget and Siri. Show a passenger-or-parked notice for detailed screens. No interaction prompts while moving. |
| Background location without visible need | 2.5.4; 5.1.5; 2.4.2 (battery) | Location only during an explicit trip. Visible indicator via CLBackgroundActivitySession. Stop on arrival. Explain in review notes with a demo video. |
| Weak purpose strings or requiring location | 5.1.1(ii)(iii)(iv); 5.1.1(i) privacy policy | Specific purpose strings. Manual or route-only fallback. Privacy policy and App Privacy labels (location). |
| Requesting Always unnecessarily | 5.1.1(iii) data minimization; WWDC24 (Always needs CLServiceSession) | Use When-In-Use plus a background activity session. |
| Siri phrase hygiene | 2.5.11 (intents relevant to the app; phrases about your app; no ads between request and fulfillment) | Narrow, app-specific phrases. Respond directly. |
| Widgets or Live Activity content unrelated or showing ads | 2.5.16; 2.5.18 (no ads in extensions or widgets); HIG: no ads in Live Activities | Trip data only. |
| CarPlay UI | CarPlay Entitlement Addendum and CarPlay Guidelines (the requesting-entitlements doc says CarPlay apps are "subject to an additional set of App Store Review guidelines") | Follow §2.5. Lock-screen-safe data. 12-item lists. No "pick up iPhone" messages. |
| Push used for marketing | 4.5.4 | Live Activity and widget pushes for trip data only. |
| Metadata implying CarPlay before an entitlement | 2.3 (accurate metadata) **(inference)** | Market "Live Activities and widgets in CarPlay" accurately. |

**UNVERIFIED:** commonly reported rejection wording for "location in UIBackgroundModes but no feature requiring persistent location" (2.5.4) and for insufficient purpose strings (5.1.1). These come from developer anecdotes, not Apple docs.

---

## 7. Bottom-line recommendations
1. **Live Activity first.**
   - Implement Lock Screen, Dynamic Island and a `.small` family layout. That one layout gives CarPlay Dashboard and Apple Watch with no entitlement.
   - Update locally from the location loop, throttled to meaningful changes. Advance `staleDate`.
   - Handle the 8 h cap with an in-app or App Shortcut restart (`LiveActivityIntent`).
   - A push server is optional later, for suspended-app updates and push-to-start.
2. **Widgets:** a systemSmall widget (Home Screen and CarPlay) and accessoryRectangular (Lock Screen) for a trip summary.
3. **Location:** `liveUpdates(.automotiveNavigation)` + `CLBackgroundActivitySession` + When-In-Use (`CLServiceSession` on iOS 18+).
4. **Siri:** App Shortcuts such as "How far to {State} in ExitAtlas" and "Next {Brand} with ExitAtlas" (AppEnum and AppEntity). Spoken `IntentDialog(full:)` for CarPlay and locked use. No foregrounding.
5. **CarPlay app:** request Driving task (road-status framing), with Fueling + EV as the fallback. Prototype in the Xcode Simulator. Expect weeks or more for review.

## Consolidated UNVERIFIED items
- An official rate limit or budget for local `Activity.update` calls from a background-running app, and whether Apple formally supports local background updates. The docs and WWDC say yes; a forum Frameworks Engineer said push only.
- The exact hourly push budget for priority-10 ActivityKit pushes.
- Whether tapping a Live Activity in CarPlay can open a non-CarPlay app.
- Whether the Xcode iOS Simulator runs CarPlay templates without an Apple-granted entitlement (third-party docs say yes; Apple says a CarPlay provisioning profile is required).
- Typical CarPlay entitlement turnaround (anecdotal: weeks to months), and which entitlement iExit currently holds.
- Whether a driving-task app may record audio with the voice control template (the guide is ambiguous).
- Exhaustive CarPlay behavior for App Shortcuts; a total App Shortcut phrase cap (about 1,000?); how iOS 27 Siri AI handles non-schema intents and entities.
- What counts as a "navigation session" for the WidgetKit budget exemption.
- Battery drain numbers.
- The iOS 27 public release date (secondary sources: 2026-09-14).
