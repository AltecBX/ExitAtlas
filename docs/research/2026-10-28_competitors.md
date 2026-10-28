# ExitAtlas competitor research: road trip and interstate exit apps (October 2026)

Research date: 2026-10-28. Prepared for the ExitAtlas product plan (web app at https://altecbx.github.io/ExitAtlas/web/, iOS app in progress).

## 0. Method, scope and caveats

* **Primary sources used:** US App Store product pages (description, "What's New" version history with exact dates, in-app purchase list, ratings, on-page reviews), the public App Store customer review feeds (JSON, sorted most recent), Google Play listings (description, rating, downloads, "Updated on" date, dated reviews), developer websites, developer help pages, Apple and Google developer documentation, and the FHWA MUTCD. Press articles are used only where no primary source exists, and are marked as such.
* **Review dates:** App Store dates come from the review feed or the page data (YYYY-MM-DD, UTC). Google Play dates come from the review timestamps on the listing. The App Store sometimes shows a review a day apart between the page and the feed (time zone); both dates refer to the same review.
* **Ratings and counts** are as displayed on 2026-10-28 and move daily.
* **Reddit could not be reached.** reddit.com returned HTTP 403 to the research proxy, and the web search tool refuses the reddit.com domain. No Reddit claims are made. Anything that might normally come from Reddit is marked UNVERIFIED. The Drive cites a Reddit post by Pit Stop's developer ([The Drive, 2026-09-12][drive-r66]); the post itself was not read.
* **Not tested hands-on.** No app was installed or driven. Design descriptions come from the official App Store screenshots and developer sites, described in words.
* **UNVERIFIED** marks anything that could not be confirmed from a primary source. "Not listed" means the store listing or developer site does not mention the feature; it does not prove the feature is absent.
* Existing internal research in the repo (`docs/01_competitive_research.md`, dated 2026-10-27) was read for context only and was not edited. Section 7 lists what this report adds to it.

Apps covered: the five requested (Pit Stop, iExit, Nexit, Roadtrippers, GasBuddy), plus Pike, NEXT EXIT, RoadSnap by the Next EXIT, USA Rest Stops, Trucker Path, TruckMap, Waze, Google Maps, Apple Maps, PlugShare, A Better Routeplanner (ABRP) and Upside. Short notes on Roadside America, Mile-1 and Exit Explorer. "Exit Now" was not found in the App Store search API for "interstate exit", "exit guide", "next exit" or "exit finder" ([iTunes Search API][itunes-api]); whether it exists elsewhere is UNVERIFIED.

---

## 1. App by app

### 1.1 Pit Stop: Road Trip Exit Guide (Jacob "Jake" Boyles)

**Status.** v1.0 2026-08-01, v1.1 2026-08-06, v1.2 2026-08-10, v1.3 2026-08-25, v1.4 2026-10-10 ([App Store][ps-as]). Rating 4.1 from 13 ratings ([App Store][ps-as]). Google Play listing updated Oct 9, 2026, "10+" downloads ([Google Play][ps-play]). Product Hunt lists a 2026 launch with 3 upvotes and no user comments ([Product Hunt][ps-ph]). The maker says it is built by one person ([site][ps-site]).

**Features (current).**
* Detects the interstate and direction by GPS, no route or destination: "No route to enter, no destination needed." Exits ahead are sorted by when you reach them ([site][ps-site]).
* Gas, food, stays and must-see sights at each exit, each with distance off the ramp ([App Store][ps-as]).
* Brand or craving search: "Search 'Chipotle' and see the next 5 exits that have one — with miles, minutes, and distance off the exit." Voice search reads the answer back ([App Store][ps-as]).
* "Worth the stop": castles, museums, zoos, national parks get a heart ([App Store][ps-as]).
* Offline: the whole exit database ships inside the app ([site][ps-site]). Since v1.3 the data "updates itself over wifi. Closed businesses disappear and new places show up without waiting for an app update" ([App Store, v1.3, 2026-08-25][ps-as]).
* Rest areas and turnpike service plazas "appear right in your exit list at their real mile markers — the blue cards, just like the signs", with a Rest Areas filter; call-ahead button on every place ([App Store, v1.2, 2026-08-10][ps-as]).
* Comfort badges for 24/7 travel centers, open-late spots and busy exits; community star ratings of gas stations for selection, restrooms and safety; tap to call ([site][ps-site]).
* v1.4 (2026-10-10): "Spoken heads-ups: the last gas for a long stretch, state lines, time zone changes, big rivers, mountain summits and must-see stops, called out a few miles before you get there"; "notifications plus a live strip on your lock screen and Dynamic Island"; road stories from Wikipedia; a road trip passport (states, interstates, state lines, must-sees); drive recap; choice of system voice ([App Store][ps-as]).
* Seven backseat games (Exit Bingo, Dinner Draft, Over/Under, License Plate, Mile Marker Showdown, 20th Car, Cow Collector). Passengers join at play.pit-stop-app.com with a 5-letter room code, no app or account; "Convoy mode" spans cars ([site][ps-site]).
* Beyond interstates: US 1, Highway 1 (Pacific Coast) and US 27 guides, with a vote for the next road ([site][ps-site]). A Route 66 version was reported by The Drive ([2026-09-12][drive-r66]).

**Platforms.** iPhone (iOS 16.4+), Mac with Apple silicon ("Not verified for macOS"), CarPlay ([App Store][ps-as]). Android on Google Play ([Google Play][ps-play]). CarPlay: "Apple-approved CarPlay driving app", exits on the car screen, one tap hands navigation to Apple Maps ([site][ps-site]); CarPlay tabs Exits, Food and Gas with voice search ([FAQ][ps-faq]); since v1.2 "rows of actual brand logos on your dash" ([App Store][ps-as]). Lock screen live strip and Dynamic Island since v1.4 ([App Store][ps-as]). Home screen widgets: not listed (UNVERIFIED). Android Auto: not mentioned ([FAQ][ps-faq]).

**Pricing.** $2.99 one time on the App Store ([App Store][ps-as]) and on Google Play ([Google Play][ps-play]). The website contradicts itself: "$2.99 once, no subscription" in the hero and "$2 once, no subscription" lower on the same page ([site][ps-site]). "No account, no ads, no data collection" ([Google Play][ps-play]); "Location never leaves your phone" ([FAQ][ps-faq]).

**Data sources.** OpenStreetMap (ODbL) ([site][ps-site], [FAQ][ps-faq]), "blending OpenStreetMap with Overture Maps" since v1.2 ([App Store][ps-as]; [blog, 2026-08-27][ps-blog-night]). Stated counts disagree across the developer's own pages: 19,675 exits, 1,529 rest areas and plazas, 700,000+ places ([site][ps-site]); "205,000+ places" ([FAQ][ps-faq]); "200,000+ places" ([Google Play][ps-play]); "20,000+ exits and 700,000+ places" ([App Store][ps-as]). Wikipedia for road stories ([App Store v1.4][ps-as]).

**Design patterns (from the official screenshots and site).**
* Header strip with an interstate shield, a direction chip ("NORTH"), and a progress line such as "Ohio mile 14.8 of 104" plus current speed ([App Store screenshots][ps-as]).
* Exit cards: a small green exit-number plaque ("EXIT 15") at the left, the exit name, "8.2 mi · now", a "NEXT" tag on the first card, then one line per category listing business names ([App Store screenshots][ps-as]).
* Food filter turns each exit into a blue board of square brand tiles in a grid, with distance and hours under each tile, "laid out like the signs on the roadside" ([App Store][ps-as], [site][ps-site]).
* A red "Worth the stop" banner with a heart sits above the list ([App Store screenshots][ps-as]).
* Filter chips: All, Gas, Food, Stays, Sights ([App Store screenshots][ps-as]).
* Empty state "Not on the Interstate yet" with an "Explore the demo drive" button ([App Store screenshots][ps-as]).
* CarPlay mock on the site: list rows "EXIT 16 / Sharon Road — Sharonville / 0.5 mi · now · Gas · Food · Stays" ([site][ps-site]).
* The website loads the Overpass typeface from Google Fonts (seen in the page source of [the site][ps-site]); Overpass is an open interpretation of Highway Gothic ([Fontsource][overpass]).

**Praise (App Store).** "Priced right and offline too." (2026-08-06/07, 5 stars, [feed][ps-rss]). "This app saves travelers so much time and aggravation when trying to find a place to eat or get gasoline." (2026-08-04, 5 stars, [feed][ps-rss]).

**Complaints (App Store).** Demo confusion: "it automatically loads Cincinnati area stops and there is no easy way to change locations" (2026-08-05, 1 star; the developer replied it was the demo drive and offered a refund, [App Store][ps-as]). Layout: "The 'Hi I'm Jake' screen is too big for my phone" (2026-08-29, 1 star, fixed per developer reply, [App Store][ps-as]). Pre-v1.2 request: "add in the ability to search for upcoming state highway rest areas" (2026-08-08, 5 stars, [feed][ps-rss]). Only 13 ratings, so complaint signal is thin.

**Relevance to ExitAtlas.** Pit Stop is the closest new rival and already voices state lines and time zone changes. It does not, per its listing, show miles or exits left in a state, crossing times, gas prices, a fuel range planner or vehicle data ([App Store][ps-as], [site][ps-site]).

---

### 1.2 iExit Interstate Exit Guide (Metrocket, LLC)

**Status.** iOS rating 4.8 from 37,669 ratings; v12.2 released 2026-10-20 ("Small update - improving the performance of iExit upon startup and while finding users on the interstate"); before that, v12.1.1 on 2025-05-17 ([App Store][ix-as]). Android: 3.9 stars, "1K reviews", "500K+" downloads, updated Jun 22, 2026, contains ads ([Google Play][ix-play]).

**Features.**
* Locates you on the interstate and shows what is ahead ([App Store][ix-as]); "Search the next 100 exits for businesses ... amenities ... rest stops, hotel deals" ([Google Play][ix-play]).
* Gas: "tell you which station is cheapest at each exit" for Unleaded, Mid Grade, Premium, Diesel ([App Store][ix-as]). Electric fuel type since 11.5 (2024-11-06), 20,000+ EV stations since 11.4 (2024-09-12), EV filters by connector, speed and network since 11.6 (2024-11-24), businesses within 0.3 mi of a charger since 11.7 (2025-02-04) ([App Store version history][ix-as]).
* Food with Yelp ratings and reviews; hotels within 3 miles of a ramp with same-day discounted rates, from Priceline Partner Network and Hotel Discount Finder (11.0, 2022-10-27; 11.2, 2023-12-06) ([App Store][ix-as]).
* Search for chains, amenities (for example WiFi) and rest areas ([App Store][ix-as]).
* CarPlay: 12.0.0 (2025-04-24) "We have only been approved for a CarPlay fueling app" so fuel only; 12.1.0 (2025-05-13) added food, rest areas, hotels and favorites search ([App Store version history][ix-as]).
* Limits stated by the developer: "only works in the United States on limited access highways"; needs GPS or internet ([App Store][ix-as]).

**Platforms.** iPhone and iPad (iOS 16+), Mac (Apple silicon), Apple Vision, CarPlay ([App Store][ix-as]); Android ([Google Play][ix-play]). Android Auto: not supported, per several 2026 Play reviews (below). Widgets and Live Activities: not listed ([App Store][ix-as]).

**Pricing.** Free with a bottom banner ad; "Bottom Banner Ad Removal $1.99" ([App Store][ix-as]). A TV segment describes "a one-time $2 upgrade" that removes ads ([WILX, 2025-12-22][ix-wilx], press).

**Data sources.** Yelp, Priceline Partner Network, Hotel Discount Finder (version notes, [App Store][ix-as]). The WILX segment says data is crowd-sourced with "more than 350,000 updates a month, according to iExit" ([WILX][ix-wilx], press, not verified with the developer). Gas price provider: UNVERIFIED (iexitapp.com blocked the research client with a Cloudflare challenge).

**Design patterns (official screenshots).**
* Saturated green brand color across the screenshots and header ([App Store screenshots][ix-as]).
* Header: back link, interstate shield with direction ("85 North"), search icon. Tabs across the top: All Exits, Fuel Prices, All Food, All Lodging, Custom or Rest Services ([App Store screenshots][ix-as]).
* Exit rows: a small green "EXIT 102" tab with a mini interstate shield, the cross street, distance in blue at the right ("16.9 mi"), and a grid of small colored square amenity icons (gas pump, fork and knife, bed, camping, pharmacy, shopping cart, and others) ([App Store screenshots][ix-as]).
* Fuel view: a summary bar with four price bands, Best, Good, Average, Worst, colored green through red; each exit shows the cheapest station with its logo, price, a savings tag versus the local average ("-54¢/gal"), side and distance ("Right (SE) 0.2 mi"), and "4 prices within 1 mile - Avg: $3.44" ([App Store screenshots][ix-as]).
* Weigh stations appear as their own rows; EV results show a small table of Connector, Speed and Network ([App Store screenshots][ix-as]).
* Food view: horizontal cards per exit with logo, "Left, 0.4 mi", and a Yelp star rating with review count; a "SPONSORED" listing card appears in the exit list ([App Store screenshots][ix-as]).
* Home: "Nearby Highways" as large shield tiles with distance ([App Store screenshots][ix-as]).
* A long-time reviewer describes a "rolling 'odometer'" countdown to the next exit that "deletes each exit as you pass it" (2017-07-02, [App Store][ix-as]).

**Praise.** "Having a directional list of rest areas is priceless. Works with CarPlay." (2026-10-04, 5 stars, [feed][ix-rss]). "giving me confidence that I can skip this next exit, knowing I can make it another 30 minutes and get a decent bathroom" (2026-02-22, 5 stars, [feed][ix-rss]). "Really helps driving strategies to run your tank out before reaching the cheaper gas elsewhere" (2026-09-26, 5 stars, [feed][ix-rss]). On Android: "almost exactly the same as the old book 'The Next Exit'" (2019-07-25, 5 stars, [Google Play][ix-play]).

**Complaints.**
* Price accuracy and no way to correct: "at times gas prices were way off from advertised on the app" (2025-12-27, 1 star); "It was not as posted ($2.67 vs. $2.49) Unable to update price like Gas Buddy" (2025-11-23, 3 stars) ([feed, later pages][ix-rss]).
* No sort or range filter: "I want to know the best priced stations in the next 100 miles" (2026-10-20, 5 stars); "If it had the ability to sort the list of gas stations by price or location" (2026-04-21, 3 stars) ([feed][ix-rss]). Android: the website "will find the top ten cheapest diesel stations within 25 miles. why the app can't do this is beyond me" (2026-06-30, 1 star, [Google Play][ix-play]).
* Stale data: "has not been updated to reflect updated exit numbers, at least in Massachusetts" (2025-09-25, 3 stars); "it appears severely out of date" (2025-03-26, 2 stars) ([feed][ix-rss]); "7 stations that are no longer either brand but are still listed as such" (2022-10-12, 3 stars, [Google Play][ix-play]).
* Highway lock: "the app kept bumping me off saying I was no longer on the I-10" (2026-06-12, 2 stars, [feed][ix-rss]).
* CarPlay stability: "in Carplay it only works once and then freezes up" (2026-03-06, 3 stars); "today it kept crashing when it tries to load data on the interstate" (2026-08-04, 4 stars) ([feed][ix-rss]).
* Ads: "pornographic ads that persist at bottom of app" (2026-09-07, 1 star, [feed][ix-rss]).
* Recent breakage: "When you start up, nothing appears on the highway screen" (2026-10-10, 1 star, [feed][ix-rss]).
* Filters: pet friendly hotels that were not (2026-07-29, 1 star); "Yelp instead of Google" (2026-06-02, 2 stars); warehouse club prices missing (2026-03-16, 4 stars) ([feed][ix-rss]).
* Android Auto: "without Android Auto support it is useless to me" (2026-07-31, 1 star); "it isn't compatible with Android Auto, and you have to operate your phone while driving" (2026-07-21, 4 stars) ([Google Play][ix-play]).

---

### 1.3 NEXIT (Interstate Data USA, Inc.)

**Status.** 4.5 from 187 ratings; v3.6.2 on 2026-05-02 ("Migrated to new discount provider"); no 2026 reviews in the review feed ([App Store][nx-as], [feed][nx-rss]).

**Features.** Repositioned from an exit guide to an AI route and deals app: "All navigation apps tell you where to drive, but only Nexit tells you where to stop"; AI route planning; "Travmatch" finds stops for different group members along the route; filters such as vegan and pet-friendly; Explore Mode for city use; deals along the route ([App Store][nx-as]). Version history: 3.0.0 redesign with AI search, deals and loyalty programs (2024-10-10), Nexit+ (3.3.1, 2025-04-16), discount search during navigation (3.4.0, 2025-10-07), Driving Mode (3.5.0, 2025-11-25), loyalty card management (3.6.0, 2026-02-23) ([App Store][nx-as]).

**Platforms.** iPhone and iPad (iOS 15.1+), Mac, Vision ([App Store][nx-as]). CarPlay: not listed; in 2021 the developer replied "CarPlay is currently being developed" ([App Store][nx-as]); current status UNVERIFIED. Android: not found on Google Play by the research client (UNVERIFIED).

**Pricing.** Free; "Nexit+" exists since 3.3.1 but no price is shown in the listing (UNVERIFIED) ([App Store][nx-as]).

**Data sources.** "our 3rd party data sources" (developer reply, 2021-11-25, [App Store][nx-as]); providers not named (UNVERIFIED).

**Design patterns.** Not reviewed from screenshots (low relevance after the pivot).

**Praise.** "The Travmatch feature is a game-changer" (2024-11-27, 5 stars, [App Store][nx-as]).

**Complaints.** "useless to me in the real world until it is CarPlay compatible ... found the data to be way out of date" (2021-11-13, 2 stars); "Please show vehicle speed and and speed limits ... no dark mode?" (2020-08-23, 1 star) ([App Store][nx-as]).

---

### 1.4 Roadtrippers - Trip Planner (Roadtrippers Inc.)

**Status.** iOS 4.6 from 61,555 ratings; v6.5.0 on 2026-10-26 ([App Store][rt-as]). Android 2.6 stars, 8.88K reviews, 1M+ downloads, updated Oct 12, 2026 ([Google Play][rt-play]).

**Features.** "Roadtrippers Autopilot" AI trip wizard using "over 38 million trips"; 150,000+ campground reviews (Campendium); overlays for public land, cell coverage and wildfire smoke; RV-friendly GPS navigation, offline maps, trip collaboration; CarPlay for navigation; "Designed for ... the USA and Canada only" ([App Store][rt-as]). Recent: refreshed navigation (6.0.0, 2026-03-12), Autopilot overhaul (5.29.0, 2026-02-04), CarPlay improvements (6.3.0, 2026-08-31), new Home tab with curated collections (6.4.0, 2026-09-22) ([App Store version history][rt-as]). A reviewer notes a trip fuel cost estimate that "was only a few dollars off" (2026-05-10, [App Store][rt-as]).

**Platforms.** iPhone, iPad, Vision; CarPlay ([App Store][rt-as]); Android ([Google Play][rt-play]). Android Auto, widgets and Live Activities: not listed.

**Pricing.** Basic $35.99/yr, Pro $49.99/yr, Premium $59.99/yr ([App Store][rt-as]; [support][rt-support]). Stops per trip 20/50/150 and saved trips 3/5/unlimited by tier ([plans page][rt-plans]); "Start with up to three stops" free ([App Store][rt-as]).

**Data sources.** Campendium reviews ([App Store][rt-as]); Yelp integration per a reviewer (2023-02-13, [Google Play][rt-play]).

**Design patterns.** Map-first planner with icons appearing along the route as you zoom (2024-09-24 review, [App Store][rt-as]). A recurring map-style complaint: the route line covers highway numbers ("the route line obscures the route numbers", 2026-09-14, [Google Play][rt-play]).

**Praise.** "Roadtrippers was intuitive in adding stops and easy to reorder and change stops as necessary." (2026-05-10, 5 stars, [App Store][rt-as]).

**Complaints.** Subscriptions dominate 2026 reviews: "Did Not Honor 7 Day Free Trial" (2026-09-24, 1 star); "Signing up is easy, canceling is not." (2026-10-02, 1 star); "This is a paid app. It should be in the description." (2026-09-01, 1 star) ([feed][rt-rss]); "I paid $39 to get nothing." (2026-04-30, 1 star, [Google Play][rt-play]). Exits: "No exit on map" (2026-09-01, 1 star, [feed][rt-rss]). Navigation: "as a Navigation app, Roadtrippers is severely lacking" (2025-11-11, 3 stars, [App Store][rt-as]). Staleness and offline: "Many places were out of biz ... There's no 'offline' mode" (2025-07-19, 2 stars, [Google Play][rt-play]; offline is a paid feature per [App Store][rt-as]).

---

### 1.5 GasBuddy: Find & Pay for Gas (GasBuddy Organization Inc)

**Status.** iOS 4.7 from 448,036 ratings; v702.8.26903 on 2026-10-08 ([App Store][gb-as]). Android 2.8 stars, 817K reviews, 10M+ downloads, updated Oct 7, 2026, contains ads ([Google Play][gb-play]).

**Features.** Driver-reported prices, "sort by price, location, or amenities like restrooms, restaurants"; Rewards points (receipts, games, deals); Flash Deals; Pay with GasBuddy+ ("at least 3¢/gal ... up to 33¢/gal with an activated Flash Deal"); fuel tracking; recall alerts; "map road trips to view gas prices along your route" ([App Store][gb-as], [Google Play][gb-play]). Recent: Daily Spin & Win moved to the home screen and new privacy onboarding (702.7, 2026-09-30); Flash Deals from the Find Gas tab (702.6, 2026-09-08) ([App Store][gb-as]).

**Platforms.** iPhone, iPad, Vision, Wallet ([App Store][gb-as]); Android ([Google Play][gb-play]). CarPlay and Android Auto: not available per BGR ("many apps don't support CarPlay, including perhaps the best-known app, GasBuddy", 2026-03-28, [BGR][bgr-carplay-gas], press); not listed in either store listing.

**Pricing.** Free with ads ([Google Play][gb-play]); Pay with GasBuddy+ card program ([App Store][gb-as]). A paid "premium" membership around $10/month is mentioned in a 2022 review ([App Store][gb-as]); current price UNVERIFIED.

**Data sources.** "We rely on GasBuddies to find and report gas prices" ([App Store][gb-as]).

**Design patterns.** Price-sorted station lists and map; Flash Deal banners on stations; rewards and games prominent on the home screen ([App Store][gb-as], [Google Play][gb-play]).

**Praise.** "Gas prices info great." (2026-07-23, 3 stars, [Google Play][gb-play]); "worth using to find out how much gas prices are as long as you're not looking at their deals" (2026-09-14, 1 star, [Google Play][gb-play]).

**Complaints.** Accuracy: "the prices were drastically different. Like $0.62/gal different." (2026-10-18, 3 stars); "a lot of stations don't have prices reported, and some aren't accurate" (2026-10-21, 1 star) ([feed][gb-rss]); "the info has literally been 50/50 on accuracy" (2026-08-30, 3 stars); "prices at both stations were 40¢ higher than listed" (2026-06-25, 1 star) ([Google Play][gb-play]). Detail: "you can no longer see the actual fuel octane level" (2026-10-19, 3 stars); "Needs to have a filter to select only stations that offer TopTier+ gas" (2026-10-13, 3 stars) ([feed][gb-rss]). Ads and gamification: "Your ads keep interrupting my music!!!" (2026-10-14, 2 stars, [feed][gb-rss]). Favorites removed: "The removal of favorite stations is horrible." (2026-08-19, 4 stars, [Google Play][gb-play]). In-car: "It would be much better if there was an Android Auto version" (2026-09-13, 3 stars, [Google Play][gb-play]).

---

### 1.6 Pike: Next Exit Guide (Thomas Johnell), additional exit app

**Status.** v1.0.0 2026-02-19; v1.2.0 2026-04-02 (parks and dog parks); 5.0 from 5 ratings; iOS 18+ ([App Store][pk-as]).

**Features.** Every upcoming exit's gas, restaurants, hotels, EV chargers, rest areas, parks and dog parks "complete with real brand logos"; "Turn direction: Know if it's a left or right off the exit"; "Detour estimates: See how far each stop is from the exit and how long the round trip takes"; list view across exits; open any stop in Apple Maps or Google Maps; no setup; "Take a test drive from the home screen"; "Built for the passenger seat"; continental US interstates ([App Store][pk-as]). Test drive on a nearby interstate and per-category settings (1.1.0, 2026-03-02) ([App Store][pk-as]).

**Platforms.** iPhone only on the site ([site][pk-site]). CarPlay app: not listed ([App Store][pk-as], [site][pk-site]).

**Pricing.** Free; in-app purchase "Pike Plus" $4.99 ([App Store][pk-as]); what Plus unlocks is UNVERIFIED.

**Data sources.** "Powered by OpenInterstate" with a link to its GitHub ([site][pk-site]). "No account. No tracking. No ads." ([site][pk-site]).

**Design patterns (official screenshots).** A map fills the screen; a bottom card has a green header "Exit 104 · 19 mi · 16 min"; below it, rows grouped by a category glyph (pump, fork and knife, bed, car, P) with white brand-logo tiles, each tile carrying a small round turn-arrow badge (orange for left, blue for right). List view groups stops by exit with "Turn left"/"Turn right" color chips and "950 ft from exit". A rest area appears as a green panel "24 mi · 20 min · REST AREA" with a building pictogram. Stop detail shows "Detour Estimate +1 min, +1.0 mi" and buttons for Apple Maps and Google Maps ([App Store screenshots][pk-as]).

**Praise.** "if you are already on a trip in apple/google maps and you find a place on Pike it's 1 click to add it as a stop in your maps app's ongoing trip without getting out of CarPlay mode" (2026-03-11, 5 stars, [feed][pk-rss]).

**Complaints.** None in the feed (3 reviews).

---

### 1.7 NEXT EXIT (The Global App Company / Car Jimmy LLC), additional exit app

**Status.** Rebuilt v2.0 on 2026-10-02; v2.2 on 2026-10-16; 4.3 from 12 ratings ([App Store][ne-as]).

**Features.** Pick interstate, direction and states; every exit in mile-marker order, state by state; service codes "G = gas, F = food, L = lodging, R = RV/campground, + = other"; "Rest areas and state lines marked along the way"; featured hotels with call, directions, website; opened listings saved for no-signal use; "Large, high-contrast text"; v2.2 "the exits just ahead of you flash yellow, updated every minute" ([App Store][ne-as]).

**Pricing.** 7-day free trial, "Next Exit" $1.49 (monthly per description), "Next Exit Lifetime" $24.99 ([App Store][ne-as]).

**Design patterns.** Green header; a row of tappable interstate shields to choose the route ("tap it again to reverse direction"); a row of state chips to select the states; a dense table with columns Exit, Exit Name, Srvs, Featured Hotels ([App Store screenshots][ne-as]).

**Reviews.** All eight on-page reviews are dated 2026-10-06 to 2026-10-18, within two weeks of the relaunch, and are short and generic ([App Store][ne-as]); treat as low signal (interpretation).

---

### 1.8 RoadSnap by the Next EXIT (the Next EXIT, inc.), additional exit app

**Status.** v3.0.3 on 2026-07-19; 4.7 from 9 ratings; in-app purchase "the Next EXIT" $9.99 ([App Store][rs-as]). The developer publishes the printed exit guides; a reviewer: "The Next Exit, publishers of physical copies of exit guides, nailed it" (2025-09-19, [App Store][rs-as]).

**Features.** v3.0.3: hotel booking and payment in app; "Stations now display avg. and user-reported gas prices as available"; social login; v3.0.1 (2025-11-21): new design, dashboard, search by service name, "browse services listed at any exit, on any interstate in the entire continental U.S.A." ([App Store][rs-as]).

**Design patterns.** Four large colored category tiles (Fuel red, Food green, Hotels blue, Rest Areas yellow); browse by state, then interstate, then a list of exits showing the exit number, crossroad and small round service icons, with rest areas listed by mile marker ("44 mm") and "no services" labels ([App Store screenshots][rs-as]).

**Praise.** "the app that has the up to date businesses" (2025-09-19, 5 stars, [App Store][rs-as]).

**Complaints.** "you can't view more than three exits ahead" (2025-09-19, 5 stars); "often it's on the opening screen where it's waiting for you to get on an interstate, even when I've been on the interstate for hours" (2025-11-14, 3 stars) ([App Store][rs-as]).

---

### 1.9 USA Rest Stops (Innovative Software Technology, LLC), additional rest area app

**Status.** 3.3 from 258 ratings; v5.2.0 on 2026-09-21; a major v5.0 rework in July 2026 ([App Store][ur-as]).

**Features.** Rest stops on interstates, US and state highways; welcome centers and turnpike service plazas; browse by state, interstate or map; facilities and hours; favorites; send to navigation apps; "number of car and truck parking (if available)"; check-in badges; "rest stops along a route to a city"; background GPS only for a requested rest stop notification ([App Store][ur-as]). v5.0.1 added queries like "I-75 in FL"; v5.1.0 brought back "browse by state", larger fonts and changed ad display ([App Store][ur-as]).

**Pricing.** Free with ads; "Remove Ads Upgrade" $1.99; "National Parks Upgrade" $1.99 ([App Store][ur-as]).

**Design patterns.** Map with numbered clusters; a bottom sheet with tabs Nearby, By State, Favorites; state list with state silhouettes and state slogans; interstate shields per state; rest area detail with star rating, "Parking Cars: — Trucks: 50", facility chips (Restrooms, Vending, Security), a "Popular Times" hourly bar chart, and Directions, Edit, Check In buttons ([App Store screenshots][ur-as]).

**Praise.** "It's helpful to see what kind of facilities, how far away, and how many truck/RV spots there are." (2026-09-30, 5 stars, [feed][ur-rss]).

**Complaints.** Ads after v5.0: "The ads are relentless." (2026-07-20, 1 star); "I have to watch an ad every time I try to get directions to the stop" (2026-07-20, 3 stars); forced sign-in (2026-08-02, 1 star) ([feed][ur-rss]). Status accuracy: "it shows a rest stop closed and when we came past it was open" (2026-07-13, 4 stars); no way to report a closure without checking in (2026-08-11, 1 star; developer says use Edit) ([feed][ur-rss]). Missing detail: "Doesn't indicate which rest stops are full service and which are truck parking only" (2026-10-13, 2 stars, [feed][ur-rss]). Legibility: "Light grey letters on white background is just plain stupid" (2026-06-20, 1 star, [feed][ur-rss]).

---

### 1.10 Trucker Path: Truck GPS & Fuel (Trucker Path Inc.), truck app

**Status.** iOS 4.8 from 156,043 ratings; v7.1.7 on 2026-10-10 ([App Store][tp-as]). Android 4.7 stars, 77.8K reviews, 5M+ downloads, updated Oct 20, 2026 ([Google Play][tp-play]).

**Features.** Truck stops, rest areas, Walmart lots, weigh stations "OPEN or CLOSED", truck parking "updated as FULL, SOME, EMPTY by thousands of truckers every hour", diesel prices and discounts (10-4 by WEX), truck-specific routing ([Google Play][tp-play], [App Store][tp-as]). v7.1.x notes: route editing with Via and Avoid, route comparison, live traffic cams and 511 alerts, traffic and weather hazard alerts, "Apple CarPlay during navigation" ([App Store][tp-as]).

**Pricing.** Free with memberships: Gold $9.99 and $14.99, monthly Diamond $29.99 ([App Store][tp-as]).

**Design patterns.** Parking availability shown on the map icon itself, so drivers do not need to open the stop: "you can tell without having to click on the truck stop if it has spaces available or if it's full" (2026-02-21, 1 star, [Google Play][tp-play]).

**Complaints.** Routing detours: "it unnecessarily takes me off the highway via an exit, routes me through side streets" (2026-10-22, 1 star, [feed][tp-rss]); offline: "when your device is offline the app will not generate routes WHATSOEVER" (2026-09-18, 1 star, [Google Play][tp-play]).

---

### 1.11 TruckMap - Truck GPS Routes (Tenstreet LLC), truck app

v8.0.20 on 2026-10-23, 4.7 from 80,136 ratings; truck routing, 600,000+ truck facilities, weigh stations and rest areas; freight marketplace ([App Store][tm-as]). Complaint: "I would give it 5 stars if it worked with CarPlay" (2026-09-21, 4 stars, [feed][tm-rss]).

---

### 1.12 Waze (Google)

**Status.** v5.26.0.0 on 2026-10-21; 4.8 from 3,197,400 ratings ([App Store][wz-as]).

**Features.** Live traffic, crowd-reported hazards, police and camera alerts, speed limit changes and a speedometer, lane guidance, tolls, "Find gas / fuel stations & prices and EV charging stations along your route", CarPlay ([App Store][wz-as]); Android Auto ([Google Play][wz-play]). Gas prices: "Gas prices are updated by users like you" and "may not always reflect the current price"; updating prices "is currently not supported on Android Auto, Android Automotive (AAOS), and CarPlay" ([Waze Help][wz-gas]).

**Pricing.** Free; reviewers mention ads ("Hate the ads", 2026-10-26, [feed][wz-rss]).

**Complaints relevant to ExitAtlas.** "it no longer shows you the ACTUAL EXIT NUMBER like it used to" (2026-01-14, rated 5 stars, [App Store][wz-as]); "CarPlay Display Unreadable: Mixes up the day and night modes" (2026-10-25, 1 star); automatic reroutes (2026-10-25, 1 star) ([feed][wz-rss]).

---

### 1.13 Google Maps (Google)

**Status.** v26.43.1 on 2026-10-23; 4.7 from 7,428,978 ratings ([App Store][gm-as]).

**Search along route.** During navigation, "Add Stop" offers Gas stations, Restaurants, Grocery stores, Coffee shops or search, and on CarPlay shows "gas prices and detour times" ([Google Maps Help][gm-help]). "Explore along your route" pins top-rated restaurants and points of interest (2024-11-13, [Google blog][gm-blog]). March 2026: "Ask Maps" (Gemini) suggests stops along multi-stop trips, and "Immersive Navigation" voice guidance tells drivers which exit to take, rolling out to CarPlay and Android Auto over the following months ([TechCrunch, 2026-03-12][gm-tc], press).

**Complaints relevant to ExitAtlas.** "Google Maps still has not updated ... the new speed limit here in Iowa" (2026-10-27, 2 stars); "I'm less sure of the exit number an hour away" (2026-10-25, 1 star); adding a gas station is harder since "replacing the microphone icon with the stupid Gemini logo" (2026-10-26, 1 star); CarPlay "doesn't show ETA, distance to next exist anymore" (2026-10-26, 1 star) ([feed][gm-rss]).

---

### 1.14 Apple Maps (Apple)

Standalone App Store listing: 2.2 from 64,315 ratings ([App Store][am-as]). Features listed: multi-stop routing up to 15 stops, lane guidance, speed limits and speed and red-light camera alerts, incident reports, offline maps with turn-by-turn directions, natural-language search ("pet-friendly restaurant with free wifi"), Visited Places, and on CarPlay favorites, incident reports and ETA sharing ([App Store][am-as]). iOS 27 CarPlay adds "Improved GPS accuracy and navigation heading" ([MacRumors, 2026-06-08][mr-ios27], press). Claims that iOS 27 adds Apple Maps natural-language navigation requests and route sharing to the car's built-in navigation appeared only in a search summary of secondary coverage: UNVERIFIED.

---

### 1.15 PlugShare (PlugShare LLC), EV

v7.38.0 on 2026-08-31; 4.7 from 143,722 ratings; ad-free subscription $1.49/month or $14.99/year ([App Store][psh-as]). Crowd-sourced reviews and photos, connector and speed filters, Pay with PlugShare, Android Auto ([Google Play][psh-play]); CarPlay map (v7.38.0 fixed an empty CarPlay map, [App Store][psh-as]). Complaints: "Doesn't show price" (2026-10-24, 1 star, [feed][psh-rss]); "bad interface on Android auto" (2026-04-26, 3 stars, [Google Play][psh-play]); "missing about 75% of EV stations" (2026-07-30, 1 star, [App Store][psh-as]).

### 1.16 A Better Routeplanner, ABRP (Rivian Automotive LLC), EV

v7.1.13 on 2026-10-22; 4.7 from 6,671 ratings; $4.99/month or $49.99/year ([App Store][abrp-as]). Charging Live Activity on the lock screen (7.1.0, 2026-05-13); "On iOS 27, CarPlay now shows ABRP in Map Panels"; speed and battery overlays on CarPlay; "Charger power and stall counts now only count the connectors your car can actually use"; widgets and a driving Live Activity mentioned in fixes (7.1.8, 2026-09-30) ([App Store version history][abrp-as]). Android Auto live data ([Google Play][abrp-play]). Complaints: "Speed limit has been stuck on 70mph for months" (2026-10-01, 1 star); "take you 5 miles off the highway for a 40 kW charger, passing by a 200 kW supercharger" (2026-10-08, 2 stars) ([feed][abrp-rss]); "often wrong about the speed limit" (2026-08-18, 3 stars, [Google Play][abrp-play]).

### 1.17 Upside (Upside Services Inc), fuel cash back

v26.29.0 on 2026-10-21; 4.8 from 689,131 ratings ([App Store][up-as]); Android 4.6, 456K reviews, 10M+ ([Google Play][up-play]). Claim an offer, pay with your card, earn cash back; 30,000+ gas locations ([Google Play][up-play]). Complaints: "nearly all fuel cash back offers have been reduced to 1¢" (2026-09-15, 2 stars, [Google Play][up-play]); "Says 'unable to access deals. Try again later.'" (2026-10-26, 2 stars, [feed][up-rss]).

### 1.18 Short notes

* **Roadside America** (This Exit LLC): $3.99 with one region, more regions by in-app purchase (All Access $7.99); quirky attractions along a route; v3.2.1 on 2026-10-12 ([App Store][ra-as]). Accessibility complaint: "The buttons are not labeled on this app, the map is not accessible" (2024-08-04, 1 star, [App Store][ra-as]).
* **Mile-1** (OnStarboard LLC): milepost locator for sharing your location with responders, offline, Siri, "CarPlay app and CarPlay widgets"; 4.7 from 1,333 ratings; v6.6 on 2026-10-21 ([App Store][m1-as]).
* **Exit Explorer** (Emad AbuAljazer): exits near you and businesses at each; 5.0 from 3 ratings; v1.1.3 on 2026-10-07 ([App Store][ee-as]).

---

## 2. Platform background that shapes the plan

* **CarPlay app categories.** Besides navigation, CarPlay allows "EV charging, fueling, parking, public safety, quick food ordering, voice-based conversational apps, and driving task apps" ([Apple CarPlay for developers][apple-carplay]). iExit first got only a fueling approval ([App Store v12.0.0][ix-as]); Pit Stop calls itself a "driving app" ([site][ps-site]).
* **Live Activities and widgets in CarPlay (iOS 26+).** "When a supported Live Activity begins on iPhone, it automatically shows up in CarPlay Dashboard"; CarPlay uses the small activity size class, falling back to the Dynamic Island compact views; "Live Activities in CarPlay are non-interactive"; widgets need only the `systemSmall` family ([WWDC25 session 216][apple-wwdc216]). "Widgets appear to the left of CarPlay Dashboard" ([Apple CarPlay for developers][apple-carplay]).
* **Android Auto.** The car app category for this kind of app is POI (`androidx.car.app.category.POI`), with `PlaceListMapTemplate` for a list of places beside a map ([Android developers][android-poi]). Several competitors' users ask for Android Auto (iExit, GasBuddy, sections 1.2 and 1.5).

---

## 3. Deliverable 1: features by app

Legend: Yes; Partial; No (stated by the developer, a primary source or a cited user report); Not listed (not in the listing or site, which does not prove absence); UNVERIFIED; n/a. Each cell is backed by the app's section above. The ExitAtlas column is from the brief and the repo README; "Not in brief" means the brief does not mention it.

### 3a. Exit and rest area apps

| Feature | Pit Stop | iExit | Pike | NEXIT | NEXT EXIT | RoadSnap | USA Rest Stops | ExitAtlas today |
|---|---|---|---|---|---|---|---|---|
| Exits ahead with no destination | Yes | Yes | Yes | Partial ("predicts where you're going") | Partial (nearby exits flash) | Yes | n/a (rest stops only) | Yes (discovery mode) |
| Route entry / trip planning | No (by design) | Partial (search around another city) | No (by design) | Yes (AI) | Pick route, direction and states | Not listed | Rest stops along a route | Yes |
| Services per exit | Yes | Yes | Yes | Yes | Letter codes | Yes | n/a | Yes (OSM) |
| Brand / craving search | Yes (next 5, voice) | Yes (next 100 exits) | Not listed | Yes | Not listed | Yes (by service name) | State / highway search | Yes (search along route) |
| Gas prices | Not listed | Yes (per exit, 4 grades) | Not listed | Partial (2020 review) | Not listed | Yes (avg. and user-reported) | n/a | Yes (driver's own Google key) |
| Rest areas inline | Yes (since v1.2) | Yes | Yes | Not listed | Yes (marked) | Yes (by mile marker) | Yes (core) | Not in brief |
| Rest area parking counts / popular times | Not listed | Not listed | Not listed | Not listed | Not listed | Not listed | Yes | Not in brief |
| EV chargers | Not listed | Yes (connector, speed, network) | Yes | Not listed | Not listed | Not listed | Not listed | Yes (Superchargers or all DCFC, AFDC) |
| Hotel rates / booking | Not listed | Yes | Not listed | Yes (prices, deals) | Featured hotels | Yes (booking) | Not listed | Not in brief |
| Turn side / detour estimate | Distance off ramp | Side and distance | Turn side and round-trip detour | UNVERIFIED | Not listed | Not listed | n/a | Detour, routed where available (README) |
| Miles / exits left in state, crossing time | Not listed (voices state lines) | Not listed | Not listed | Not listed | State lines marked only | Not listed | Not listed | Yes (core) |
| Voice announcements | Yes (state lines, time zones, last gas) | Not listed | Not listed | Not listed | Not listed | Not listed | Notification for a chosen stop | Yes |
| Fuel range planner / vehicle MPG | Not listed | Not listed | Not listed | Not listed | Not listed | Not listed | Not listed | Yes |
| Offline | Yes (bundled) | Not listed | Not listed | Not listed | Opened listings cached | Not listed | Not listed | Cached after first load (web), bundled (iOS) |
| CarPlay | Yes (driving app) | Yes | Not listed (handoff to Maps works in CarPlay) | Not listed | Not listed | Not listed | Not listed | In progress (iOS) |
| Android app | Yes | Yes | Not listed (iPhone only on site) | UNVERIFIED | Not listed | UNVERIFIED | UNVERIFIED | Web works on Android |
| Android Auto | Not listed | No (user reports) | Not listed | Not listed | Not listed | Not listed | Not listed | No |
| Live Activity / Dynamic Island | Yes (v1.4) | Not listed | Not listed | Not listed | Not listed | Not listed | Not listed | Planned (repo docs) |
| Home screen widgets | Not listed | Not listed | Not listed | Not listed | Not listed | Not listed | Not listed | Not in brief |
| Games / family features | Yes (7 games) | Not listed | Not listed | Travmatch group search | Not listed | Not listed | Check-in badges | Not in brief |
| Price | $2.99 once | Free, ads, $1.99 ad removal | Free, Plus $4.99 | Free, Nexit+ (price UNVERIFIED) | 7-day trial, $1.49/mo or $24.99 | IAP $9.99 | Free, ads, $1.99 | Free (web) |
| Data | OSM + Overture | Yelp, Priceline, Hotel Discount Finder; crowd per press | OpenInterstate | Unnamed 3rd party | UNVERIFIED | Next EXIT guide publisher | Users plus developer | OSM, EPA, DOE AFDC, Google Places |

### 3b. Broader road trip, fuel and EV apps

| Feature | Roadtrippers | GasBuddy | Trucker Path | Waze | Google Maps | Apple Maps | PlugShare | ABRP | Upside |
|---|---|---|---|---|---|---|---|---|---|
| Exit-by-exit list | Not listed (review: "No exit on map") | Not listed | Not listed | Not listed (review: exit numbers hidden) | Not listed | Not listed | Not listed | Not listed | Not listed |
| Stops along route | Yes | Yes (prices along route) | Yes | Yes (gas, EV) | Yes (categories, detour, price) | Yes (multi-stop, up to 15) | Trip planner | Yes (charging) | Not listed |
| Gas prices | Fuel cost estimate | Yes (crowd) | Diesel prices | Yes (crowd) | Yes | Not listed | n/a ("Doesn't show price" review) | n/a | Prices at participating stations |
| Offline | Paid tiers | Not listed | Offline maps; routing fails offline per review | Not listed | Offline maps | Yes | Not listed | Not listed | Not listed |
| CarPlay | Yes | No (BGR) | Yes (navigation) | Yes | Yes | Yes | Yes | Yes (Map Panels on iOS 27) | Not listed |
| Android Auto | Not listed | No (BGR) | UNVERIFIED | Yes | Yes (TechCrunch rollout) | n/a | Yes | Yes | Not listed |
| Live Activity / widgets | Not listed | Not listed | Not listed | Not listed | UNVERIFIED | UNVERIFIED | Not listed | Yes (Live Activity, widgets) | Not listed |
| Speed limit / speedometer | Not listed | Not listed | Not listed | Yes | Limits shown (accuracy complaints) | Yes | Not listed | Speed overlay (accuracy complaints) | Not listed |
| Price | $35.99 to $59.99/yr | Free, ads, card program | $9.99 to $29.99 memberships | Free (reviewers mention ads) | Free | Free | Free, ad-free $1.49/mo | $4.99/mo, $49.99/yr | Free |

---

## 4. Deliverable 2: top 15 features or patterns to match or beat

Ordered by expected impact for an interstate companion. "Why it matters" combines evidence (cited) with interpretation (labeled).

1. **Zero-setup, instant highway lock.** Who: Pit Stop ("No route to enter", [site][ps-site]), iExit ([App Store][ix-as]), Pike ("works the moment you open it", [App Store][pk-as]), RoadSnap ([App Store][rs-as]). Why: losing the lock is a top frustration ("kept bumping me off saying I was no longer on the I-10", 2026-06-12, [feed][ix-rss]; RoadSnap stuck "waiting for you to get on an interstate", 2025-11-14, [App Store][rs-as]). Beat it by showing lock confidence and a one-tap "I'm on I-xx eastbound" override (interpretation).

2. **A real CarPlay app, not just a handoff.** Who: Pit Stop (driving app, logo rows, [App Store][ps-as]), iExit (fueling, then food, rest areas, hotels, [App Store][ix-as]), Roadtrippers, Waze, Google Maps, PlugShare, ABRP, Trucker Path (sections 1.4, 1.10, 1.12 to 1.16). Why: reviewers delete or downgrade apps that need the phone while driving (Nexit 2021-11-13, [App Store][nx-as]; TruckMap 2026-09-21, [feed][tm-rss]); CarPlay instability costs ratings (iExit 2026-03-06, [feed][ix-rss]). The category and entitlement matter ([Apple][apple-carplay]).

3. **Live Activity that doubles as the CarPlay Dashboard card.** Who: Pit Stop (lock screen strip and Dynamic Island, [App Store v1.4][ps-as]), ABRP (Live Activity, widgets, [App Store][abrp-as]). Why: on iOS 26+ a Live Activity "automatically shows up in CarPlay Dashboard" and needs only the small size class ([WWDC25 216][apple-wwdc216]). ExitAtlas's state line countdown (next state, miles and exits left, local crossing time) fits a glanceable non-interactive card exactly (interpretation). Mile-1 shows CarPlay widgets are already used for highway position ([App Store][m1-as]).

4. **Spoken heads-ups for gaps, state lines and time zones.** Who: Pit Stop v1.4 ("the last gas for a long stretch, state lines, time zone changes", [App Store][ps-as]); Google's Immersive Navigation tells drivers which exit to take ([TechCrunch][gm-tc]). Why: ExitAtlas already speaks state lines, exits and fuel stops (README); adding a "last gas for N miles" call matches the MUTCD "NEXT SERVICES XX MILES" plaque concept, used where services are 10+ miles away ([MUTCD 2I][mutcd-2i]). Pit Stop's own data shows 1,156 exits with nothing nearby ([blog][ps-blog-night]).

5. **Offline by default, with visible data age.** Who: Pit Stop (bundled, auto-updates on Wi-Fi, [App Store v1.3][ps-as]), NEXT EXIT (cached listings, [App Store][ne-as]), Mile-1 (works without data, [App Store][m1-as]). Why: rural dead zones are the use case ("Priced right and offline too", [feed][ps-rss]); Roadtrippers and Trucker Path draw offline complaints ([Google Play][rt-play], [Google Play][tp-play]).

6. **Brand or craving search across the next N exits, with voice.** Who: Pit Stop (next 5, voice reads back, [App Store][ps-as]), iExit (next 100 exits, [Google Play][ix-play]). Why: the most concrete "where do I stop" question; ExitAtlas already has search along the route (README), so voice input and spoken answers are the gap (interpretation).

7. **Gas prices you can sort and trust, tied to range.** Who: iExit (cheapest per exit, Best to Worst bands, [App Store][ix-as]), GasBuddy, Waze, Google Maps (prices and detour in CarPlay, [help][gm-help]), RoadSnap. Why: users explicitly ask for "the best priced stations in the next 100 miles" ([feed][ix-rss], 2026-10-20) and the website-only "top ten cheapest diesel stations within 25 miles" ([Google Play][ix-play], 2026-06-30). ExitAtlas's miles-to-empty planner plus favorite brands can answer "cheapest reachable station before reserve", which no listing above claims (interpretation). Show source and age on every price, since accuracy is the top GasBuddy complaint ([feed][gb-rss]).

8. **Rest areas inline at mile markers, with amenities, parking and open status.** Who: Pit Stop v1.2 ("blue cards, just like the signs", [App Store][ps-as]), iExit ([feed][ix-rss], 2026-10-04 praise), Pike, RoadSnap (by mile marker), USA Rest Stops (parking counts, facilities, popular times, [App Store][ur-as]). Why: it was Pit Stop's "Most requested feature" ([App Store v1.2][ps-as]); gaps remain on full-service versus truck-only and closures ([feed][ur-rss]).

9. **Turn side and detour cost per stop.** Who: Pike ("Turn left/right", "+1 min +1.0 mi", [App Store][pk-as]), iExit ("Right (SE) 0.2 mi", screenshots, [App Store][ix-as]), Pit Stop (distance off ramp), Google Maps (detour times, [help][gm-help]). Why: decides whether a stop is "right at the exit or three miles into town" ([App Store][ps-as]).

10. **One-tap handoff that adds a stop to the active navigation.** Who: Pike (add to ongoing Apple or Google Maps trip, praised 2026-03-11, [feed][pk-rss]), Pit Stop (Apple Maps, [site][ps-site]). Why: iExit users report a broken Apple Maps start point and ask for Waze (2026-10-20, 2026-02-24, [feed][ix-rss]). ExitAtlas does its own routing on the web, so on iOS the handoff should not break the user's current navigation (interpretation).

11. **EV filters that only count compatible stalls.** Who: ABRP ("only count the connectors your car can actually use", [App Store][abrp-as]), iExit (connector, speed, network filters, [App Store][ix-as]), PlugShare. Why: chargers you cannot use look like good stops (ABRP note); NACS no longer means Tesla only (PlugShare review 2026-08-05, [App Store][psh-as]). ExitAtlas already filters Superchargers versus all DCFC from AFDC (brief).

12. **Hours and "open now / 24 hours / open late" badges.** Who: Pit Stop comfort badges ([site][ps-site]), USA Rest Stops hours and popular times ([App Store][ur-as]). Why: Pit Stop's own count finds 1 in 7 interstate exits has 4 or fewer places within a mile of the ramp ([blog][ps-blog-night]), so knowing what is open matters most at sparse exits and at night (interpretation); the MUTCD has a "24 HR" plaque for general services ([MUTCD 2I][mutcd-2i]).

13. **A correction loop and visible freshness.** Who: Pit Stop (closed businesses removed on Wi-Fi updates, [App Store v1.3][ps-as]), USA Rest Stops (Edit, mark closed, [App Store][ur-as]), GasBuddy and Waze (user price updates, [Waze help][wz-gas]). Why: iExit's oldest and newest complaints are stale data with no fix path (sections 1.2). ExitAtlas uses OSM, so a "report a problem" link that opens the OSM note or edit flow is a natural fit (interpretation).

14. **Must-see highlights and short stories.** Who: Pit Stop hearts and Wikipedia stories ([App Store][ps-as]), Google "Explore along your route" ([blog][gm-blog]), Roadside America ([App Store][ra-as]), Roadtrippers ([App Store][rt-as]). Why: turns the state dashboard into a trip narrative (for example a "Welcome to Kansas" card with one fact), a cheap differentiator if sourced from open data (interpretation).

15. **A demo or test drive for first run.** Who: Pit Stop ("Explore the demo drive", [App Store screenshots][ps-as]), Pike ("Take a test drive from the home screen", [App Store][pk-as]). Why: exit apps look empty off the highway; Pit Stop's demo also caused a 1-star review because it was not clearly labeled (2026-08-05, [App Store][ps-as]). ExitAtlas's web version can open with a clearly labeled sample route (interpretation).

Honorable mentions: trip passport and drive recap (Pit Stop v1.4, [App Store][ps-as]); hotel rates within a few miles of the ramp (iExit, [App Store][ix-as]); group or passenger features (Pit Stop games, Nexit Travmatch); favorites that survive updates (GasBuddy backlash, [Google Play][gb-play]); parking-availability-on-the-pin pattern (Trucker Path, [Google Play][tp-play]).

---

## 5. Deliverable 3: reported limitations and gaps ExitAtlas could fill

| Gap | Evidence | Opportunity for ExitAtlas (interpretation) |
|---|---|---|
| **Stale or wrong businesses and exit numbers** | iExit: Massachusetts exit renumbering not reflected (2025-09-25), "severely out of date" (2025-03-26) ([feed][ix-rss]); brands changed years ago (2022-10-12, [Google Play][ix-play]); Roadtrippers "Many places were out of biz" (2025-07-19, [Google Play][rt-play]); Nexit "data to be way out of date" (2021-11-13, [App Store][nx-as]) | Show data build date per state; refresh from OSM regularly; one-tap "report" that feeds OSM notes |
| **Gas prices wrong, missing or uneditable** | GasBuddy "$0.62/gal different" (2026-10-18), "a lot of stations don't have prices reported" (2026-10-21) ([feed][gb-rss]); iExit "Unable to update price" (2025-11-23, [feed][ix-rss]); Waze prices "may not always reflect the current price" ([help][wz-gas]) | Label source and age on each price; never rank by a price older than a threshold without saying so |
| **No price sort within distance or range** | iExit "best priced stations in the next 100 miles" (2026-10-20), sort by price (2026-04-21) ([feed][ix-rss]) | Fuel planner already uses miles to empty; add "cheapest reachable" ranking |
| **Missing or wrong rest area details** | Pit Stop lacked rest areas until v1.2 (review 2026-08-08, [feed][ps-rss]); USA Rest Stops open/closed errors (2026-07-13) and no full-service vs truck-only flag (2026-10-13) ([feed][ur-rss]) | Rest area rows with amenity tags from OSM, truck-only flag, closure reports |
| **Ads that are intrusive or inappropriate** | iExit "pornographic ads" (2026-09-07, [feed][ix-rss]); USA Rest Stops "The ads are relentless" (2026-07-20, [feed][ur-rss]); GasBuddy ads interrupting music (2026-10-14, [feed][gb-rss]); Waze "Hate the ads" (2026-10-26, [feed][wz-rss]) | No ads; Pit Stop already markets "no ads" ([Google Play][ps-play]) |
| **Subscriptions, trials and cancellation traps** | Roadtrippers trial not honored (2026-09-24), hard to cancel (2026-10-02) ([feed][rt-rss]); ABRP premium not recognized (2026-10-26, [feed][abrp-rss]); NEXT EXIT moved to subscription ([App Store][ne-as]) | Keep core free or one-time; Pit Stop's "$2.99 once, no subscription" is the visible benchmark ([site][ps-site]) |
| **Exit numbers missing in navigation apps** | Waze "no longer shows you the ACTUAL EXIT NUMBER" (2026-01-14, [App Store][wz-as]); Google Maps "less sure of the exit number an hour away" (2026-10-25), CarPlay lost "distance to next exist" (2026-10-26) ([feed][gm-rss]) | ExitAtlas's exit-first view and Live Activity can sit beside Apple or Google navigation |
| **Speed limit errors** | Google Maps Iowa 60 mph not updated (2026-10-27, [feed][gm-rss]); ABRP "stuck on 70mph for months" (2026-10-01, [feed][abrp-rss]) | ExitAtlas uses OSM limits: show "limit from OpenStreetMap", hide when stale or missing, allow a report |
| **Highway lock loss and blank screens** | iExit I-10 lock loss (2026-06-12), blank highway screen (2026-10-10) ([feed][ix-rss]); RoadSnap waiting screen (2025-11-14, [App Store][rs-as]) | Show lock status and a manual override |
| **CarPlay and Android Auto quality** | iExit CarPlay freezes (2026-03-06, [feed][ix-rss]); PlugShare empty CarPlay map fixed (v7.38.0, [App Store][psh-as]); Waze CarPlay unreadable (2026-10-25, [feed][wz-rss]); iExit and GasBuddy lack Android Auto ([Google Play][ix-play], [Google Play][gb-play]) | Template-based CarPlay with few states; test day/night contrast; Android Auto is a later option (POI category, [Android][android-poi]) |
| **Interstate-only coverage, turnpikes, US routes** | iExit only "limited access highways" ([App Store][ix-as]); 2023 review on missing US 93 ([App Store][ix-as]); Pit Stop adds US 1, CA-1, US 27 ([site][ps-site]) and turnpike plazas ([App Store v1.2][ps-as]) | ExitAtlas README says turnpikes and US routes without an interstate number show no exits: a known gap to close |
| **State-aware trip progress** | No listing reviewed shows miles or exits left in a state or crossing time; Pit Stop only voices state lines and time zone changes ([App Store v1.4][ps-as]); NEXT EXIT marks state lines in a table ([App Store][ne-as]) | ExitAtlas's core; protect it and surface it on Live Activity and CarPlay |
| **Filters that mislead** | iExit pet-friendly hotels wrong (2026-07-29, [feed][ix-rss]); ABRP routes to slow chargers (2026-10-08, [feed][abrp-rss]) | Only show filters the data supports; say where a tag came from |
| **Legibility and accessibility** | USA Rest Stops contrast (2026-06-20, [feed][ur-rss]); Roadside America unlabeled buttons (2024-08-04, [App Store][ra-as]); NEXT EXIT sells "Large, high-contrast text" ([App Store][ne-as]) | Large type, VoiceOver labels, night palette |
| **Privacy and account friction** | GasBuddy reviewer refuses ID scan to see prices (2026-10-19, [feed][gb-rss]); USA Rest Stops forced sign-in (2026-08-02, [feed][ur-rss]); Pit Stop "Location never leaves your phone" ([FAQ][ps-faq]) | ExitAtlas keeps keys on the phone (README); say so in the listing |
| **Data counts that contradict each other** | Pit Stop lists 700,000+, 205,000+ and 200,000+ places on different pages ([site][ps-site], [FAQ][ps-faq], [Google Play][ps-play]) | Publish one dated data summary per release |

---

## 6. Deliverable 4: design notes for an original ExitAtlas look

### 6.1 What is generic highway signage (shared public vocabulary)

* **Color meanings (MUTCD 1A.12):** "Green—indicated movements permitted, direction guidance"; "Blue—road user services guidance, tourist information, and evacuation route"; "Brown—recreational and cultural interest area guidance"; "Yellow—warning"; "Orange—temporary traffic control" ([MUTCD 2009, Part 1A][mutcd-1a]).
* **Guide signs:** "guide signs on streets and highways shall have a white message and border on a green background" ([MUTCD 2D][mutcd-2d]).
* **General service signs** (including REST AREA): "white letters, symbols, arrows, and borders on a blue background"; a "NEXT SERVICES XX MILES" plaque may be used when the next services are 10 miles or more away; a "24 HR" plaque exists ([MUTCD 2I][mutcd-2i]).
* **Specific service (logo) signs:** "blue background, a white border, and white legends of upper-case letters"; categories "gas, food, lodging, camping, attractions, and 24-hour pharmacies"; "Each logo shall be placed on a separate logo sign panel"; order in the direction of travel ends with "food, and gas services, in that order" ([MUTCD 2J][mutcd-2j]).
* **Lettering:** the FHWA "Highway Gothic" alphabets; Overpass is an open interpretation under the SIL Open Font License 1.1 ([Fontsource][overpass]). Note: Pit Stop's website already uses Overpass ([site source][ps-site]), so using it would look closer to Pit Stop (interpretation).
* **Interstate shield:** reported as a registered trademark of AASHTO (Registration 835,635, 1967) and excluded from the MUTCD's public-domain statement, per secondary sources ([Texas MUTCD text as quoted][tx-mutcd]; [San Diego Reader, 2006][sdr-shield], not retrieved, 403). Primary confirmation (USPTO or AASHTO) is UNVERIFIED. Many apps draw it (iExit, Pit Stop, NEXT EXIT, USA Rest Stops screenshots), but that does not settle the question; get legal advice before shipping a shield replica.
* **Business logos** are the businesses' trademarks; Pit Stop states "Pit Stop is not affiliated with the brands shown; logos identify businesses near exits" ([Google Play][ps-play]). Whether ExitAtlas can show logos is a legal question, not answered here.

### 6.2 What is app-specific (do not copy)

* Pit Stop: the filter that turns an exit into a blue grid of brand tiles, the red "Worth the stop" heart banner, comfort badges, the CarPlay rows of brand logos, the "Ohio mile 14.8 of 104" header line, games ([App Store][ps-as], [site][ps-site]).
* iExit: the saturated green brand, the small green exit tab with a mini shield plus a grid of colored amenity squares, the Best/Good/Average/Worst price band bar, the horizontal Yelp-starred food cards ([App Store screenshots][ix-as]).
* Pike: map with a bottom card whose header reads "Exit · mi · min", logo tiles with orange or blue turn-arrow badges, the green "REST AREA" panel with a building pictogram, the "Detour Estimate" block ([App Store screenshots][pk-as]).
* NEXT EXIT: shield row plus state chip row plus spreadsheet table with G/F/L codes ([App Store screenshots][ne-as]).
* RoadSnap: four big colored category tiles ([App Store screenshots][rs-as]).
* USA Rest Stops: state silhouettes with slogans, the "Popular Times" bar chart in rest area detail ([App Store screenshots][ur-as]).

### 6.3 Direction for an original ExitAtlas look (interpretation, not sourced)

1. **Lead with what only ExitAtlas has.** Make the home view a "state ledger": a horizontal ribbon of the route split into states, each segment proportional to its miles, with the current position, miles and exits left in this state, and the crossing time in that state's local time. No competitor reviewed shows this (section 5), so it can carry the brand.
2. **Exit cards in ExitAtlas's own voice.** Use a neutral card with the exit number set in your own typeface (or Overpass only if you accept the Pit Stop resemblance), the distance and time on the right, and category rows with small glyphs. Avoid a green tab plus shield badge (iExit), a green header card on a map (Pike) and blue logo-board grids (Pit Stop, Pike).
3. **Use MUTCD meaning, not MUTCD look.** Keep the color semantics people already read (green for route and exits, blue for services and rest areas, brown for attractions, yellow for warnings such as low fuel), but apply them as accents (a left rule, a chip, an icon tint) rather than as full sign panels.
4. **Business names without logos by default.** Show brand names as plain text with a category glyph; highlight favorite brands with a star or bold weight. Treat logo display as a separate, legally reviewed decision (section 6.1).
5. **Shields.** Prefer a generic route badge (for example a rounded rectangle with "I-70") over a drawn Interstate shield until the trademark question is answered (section 6.1).
6. **Rest areas and gaps as first-class rows.** Rest areas appear in order between exits at their mile marker, with amenity chips and a truck-only flag; long gaps get a row like "Next gas 47 mi" that echoes the NEXT SERVICES plaque idea without copying its look.
7. **Fuel reach as a visual.** Draw the reserve point on the exit list ("you reach reserve after Exit 182"), mark reachable gas exits, and pin price source and age next to each price.
8. **Glanceable surfaces first.** Design the Live Activity small view and CarPlay list templates early, with one number each (miles to state line, next exit, miles to reserve), since CarPlay Live Activities are non-interactive ([WWDC25 216][apple-wwdc216]).
9. **Night and accessibility.** Large type, strong contrast, VoiceOver labels, and a tested dark palette, given contrast complaints at USA Rest Stops and Waze CarPlay (section 5).

---

## 7. What this adds to the repo's 2026-10-27 research (for the caller)

* Pit Stop blends OpenStreetMap with Overture Maps since v1.2, auto-updates data over Wi-Fi since v1.3, ships on Google Play at $2.99 (10+ downloads), and its own pages disagree on place counts and on price ($2.99 vs $2) (section 1.1).
* iExit on Android: 3.9 stars, 500K+ downloads, no Android Auto, with 2026 reviews asking for it (section 1.2).
* USA Rest Stops' July 2026 v5.0 rework drew heavy ad and sign-in complaints, and it has a parking count and "Popular Times" pattern (section 1.9).
* RoadSnap by the Next EXIT (the printed guide's publisher) is active again, with user-reported gas prices and hotel booking (section 1.8).
* iOS 26 shows Live Activities automatically in CarPlay Dashboard (primary Apple source), which makes a state line Live Activity a CarPlay feature at little extra cost (section 2).
* Waze and Google Maps users complain in 2026 about missing exit numbers and wrong speed limits (sections 1.12, 1.13).

---

## Sources

[ps-site]: https://www.pit-stop-app.com/
[ps-faq]: https://www.pit-stop-app.com/faq
[ps-blog-night]: https://www.pit-stop-app.com/blog/interstate-at-night
[ps-as]: https://apps.apple.com/us/app/pit-stop-road-trip-exit-guide/id6795296025
[ps-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=6795296025/sortby=mostrecent/json
[ps-play]: https://play.google.com/store/apps/details?id=com.jakeboyles.pitstop
[ps-ph]: https://www.producthunt.com/products/pit-stop-good-stops-great-trips
[drive-r66]: https://www.thedrive.com/news/one-dude-mapped-route-66-in-its-entirety-and-you-can-scroll-through-all-2199-miles
[ix-as]: https://apps.apple.com/us/app/iexit-interstate-exit-guide/id401746066
[ix-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=401746066/sortby=mostrecent/json
[ix-play]: https://play.google.com/store/apps/details?id=com.metrocket.iexitapp
[ix-wilx]: https://www.wilx.com/2025/12/22/what-tech-iexit-app/
[itunes-api]: https://itunes.apple.com/search?term=interstate+exit&entity=software&country=us
[nx-as]: https://apps.apple.com/us/app/nexit/id1466222160
[nx-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=1466222160/sortby=mostrecent/json
[rt-as]: https://apps.apple.com/us/app/roadtrippers-trip-planner/id944060491
[rt-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=944060491/sortby=mostrecent/json
[rt-play]: https://play.google.com/store/apps/details?id=com.roadtrippers
[rt-plans]: https://roadtrippers.com/membership-plans/
[rt-support]: https://support.roadtrippers.com/hc/en-us/articles/360000831566
[gb-as]: https://apps.apple.com/us/app/gasbuddy-find-pay-for-gas/id406719683
[gb-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=406719683/sortby=mostrecent/json
[gb-play]: https://play.google.com/store/apps/details?id=gbis.gbandroid
[bgr-carplay-gas]: https://www.bgr.com/2130118/how-to-use-apple-carplay-save-money-gas/
[pk-as]: https://apps.apple.com/us/app/pike-next-exit-guide/id6759123383
[pk-site]: https://thepike.app
[pk-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=6759123383/sortby=mostrecent/json
[ne-as]: https://apps.apple.com/us/app/next-exit/id939674590
[rs-as]: https://apps.apple.com/us/app/id336836298
[ur-as]: https://apps.apple.com/us/app/id528988698
[ur-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=528988698/sortby=mostrecent/json
[tp-as]: https://apps.apple.com/us/app/id782746890
[tp-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=782746890/sortby=mostrecent/json
[tp-play]: https://play.google.com/store/apps/details?id=com.sixdays.truckerpath
[tm-as]: https://apps.apple.com/us/app/id1198422047
[tm-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=1198422047/sortby=mostrecent/json
[wz-as]: https://apps.apple.com/us/app/id323229106
[wz-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=323229106/sortby=mostrecent/json
[wz-play]: https://play.google.com/store/apps/details?id=com.waze
[wz-gas]: https://support.google.com/waze/answer/13739802
[gm-as]: https://apps.apple.com/us/app/id585027354
[gm-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=585027354/sortby=mostrecent/json
[gm-help]: https://support.google.com/maps/answer/9432062
[gm-blog]: https://blog.google/products/maps/explore-along-route-tip/
[gm-tc]: https://techcrunch.com/2026/03/12/google-maps-is-getting-an-ai-ask-maps-feature-and-upgraded-immersive-navigation/
[am-as]: https://apps.apple.com/us/app/id915056765
[psh-as]: https://apps.apple.com/us/app/id421788217
[psh-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=421788217/sortby=mostrecent/json
[psh-play]: https://play.google.com/store/apps/details?id=com.xatori.Plugshare
[abrp-as]: https://apps.apple.com/us/app/id1490860521
[abrp-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=1490860521/sortby=mostrecent/json
[abrp-play]: https://play.google.com/store/apps/details?id=com.iternio.abrpapp
[up-as]: https://apps.apple.com/us/app/id1099997174
[up-rss]: https://itunes.apple.com/us/rss/customerreviews/page=1/id=1099997174/sortby=mostrecent/json
[up-play]: https://play.google.com/store/apps/details?id=com.upside.consumer.android
[ra-as]: https://apps.apple.com/us/app/id347393479
[m1-as]: https://apps.apple.com/us/app/id1562022453
[ee-as]: https://apps.apple.com/us/app/id6738075792
[apple-wwdc216]: https://developer.apple.com/videos/play/wwdc2025/216/
[apple-carplay]: https://developer.apple.com/carplay/
[mr-ios27]: https://www.macrumors.com/2026/06/08/new-apple-carplay-features-ios-27/
[android-poi]: https://developer.android.com/training/cars/apps/poi
[mutcd-1a]: https://mutcd.fhwa.dot.gov/htm/2009/part1/part1a.htm
[mutcd-2d]: https://mutcd.fhwa.dot.gov/htm/2009/part2/part2d.htm
[mutcd-2i]: https://mutcd.fhwa.dot.gov/htm/2009/part2/part2i.htm
[mutcd-2j]: https://mutcd.fhwa.dot.gov/htm/2009/part2/part2j.htm
[overpass]: https://fontsource.org/fonts/overpass/about
[sdr-shield]: https://www.sandiegoreader.com/news/2006/jan/19/clear-violation/
[tx-mutcd]: https://c.enwp.org/wiki/Template:PD-MUTCD-TX

Plain list of the same sources (reference links above do not render as a visible list in every viewer):

* Pit Stop: https://www.pit-stop-app.com/ , https://www.pit-stop-app.com/faq , https://www.pit-stop-app.com/blog/interstate-at-night , https://apps.apple.com/us/app/pit-stop-road-trip-exit-guide/id6795296025 , https://itunes.apple.com/us/rss/customerreviews/page=1/id=6795296025/sortby=mostrecent/json , https://play.google.com/store/apps/details?id=com.jakeboyles.pitstop , https://www.producthunt.com/products/pit-stop-good-stops-great-trips , https://www.thedrive.com/news/one-dude-mapped-route-66-in-its-entirety-and-you-can-scroll-through-all-2199-miles
* iExit: https://apps.apple.com/us/app/iexit-interstate-exit-guide/id401746066 , https://itunes.apple.com/us/rss/customerreviews/page=1/id=401746066/sortby=mostrecent/json (pages 1 to 10 read) , https://play.google.com/store/apps/details?id=com.metrocket.iexitapp , https://www.wilx.com/2025/12/22/what-tech-iexit-app/
* NEXIT: https://apps.apple.com/us/app/nexit/id1466222160
* Roadtrippers: https://apps.apple.com/us/app/roadtrippers-trip-planner/id944060491 , https://play.google.com/store/apps/details?id=com.roadtrippers , https://roadtrippers.com/membership-plans/ , https://support.roadtrippers.com/hc/en-us/articles/360000831566
* GasBuddy: https://apps.apple.com/us/app/gasbuddy-find-pay-for-gas/id406719683 , https://play.google.com/store/apps/details?id=gbis.gbandroid , https://www.bgr.com/2130118/how-to-use-apple-carplay-save-money-gas/
* Pike: https://apps.apple.com/us/app/pike-next-exit-guide/id6759123383 , https://thepike.app
* NEXT EXIT: https://apps.apple.com/us/app/next-exit/id939674590 ; RoadSnap: https://apps.apple.com/us/app/id336836298 ; USA Rest Stops: https://apps.apple.com/us/app/id528988698
* Trucker Path: https://apps.apple.com/us/app/id782746890 , https://play.google.com/store/apps/details?id=com.sixdays.truckerpath ; TruckMap: https://apps.apple.com/us/app/id1198422047
* Waze: https://apps.apple.com/us/app/id323229106 , https://play.google.com/store/apps/details?id=com.waze , https://support.google.com/waze/answer/13739802
* Google Maps: https://apps.apple.com/us/app/id585027354 , https://support.google.com/maps/answer/9432062 , https://blog.google/products/maps/explore-along-route-tip/ , https://techcrunch.com/2026/03/12/google-maps-is-getting-an-ai-ask-maps-feature-and-upgraded-immersive-navigation/
* Apple Maps: https://apps.apple.com/us/app/id915056765 ; iOS 27 CarPlay: https://www.macrumors.com/2026/06/08/new-apple-carplay-features-ios-27/
* PlugShare: https://apps.apple.com/us/app/id421788217 , https://play.google.com/store/apps/details?id=com.xatori.Plugshare ; ABRP: https://apps.apple.com/us/app/id1490860521 , https://play.google.com/store/apps/details?id=com.iternio.abrpapp ; Upside: https://apps.apple.com/us/app/id1099997174 , https://play.google.com/store/apps/details?id=com.upside.consumer.android
* Roadside America: https://apps.apple.com/us/app/id347393479 ; Mile-1: https://apps.apple.com/us/app/id1562022453 ; Exit Explorer: https://apps.apple.com/us/app/id6738075792
* Platforms: https://developer.apple.com/videos/play/wwdc2025/216/ , https://developer.apple.com/carplay/ , https://developer.android.com/training/cars/apps/poi
* Signage and type: https://mutcd.fhwa.dot.gov/htm/2009/part1/part1a.htm , https://mutcd.fhwa.dot.gov/htm/2009/part2/part2d.htm , https://mutcd.fhwa.dot.gov/htm/2009/part2/part2i.htm , https://mutcd.fhwa.dot.gov/htm/2009/part2/part2j.htm , https://fontsource.org/fonts/overpass/about , https://www.sandiegoreader.com/news/2006/jan/19/clear-violation/ (secondary, not retrieved) , https://c.enwp.org/wiki/Template:PD-MUTCD-TX (secondary)
* App Store review feeds for every app above follow the pattern https://itunes.apple.com/us/rss/customerreviews/page=N/id=APP_ID/sortby=mostrecent/json
