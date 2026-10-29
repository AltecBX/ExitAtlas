import XCTest

/// Launches the bundled simulated demo trip frozen near the Florida/Georgia line and captures
/// the main screens in light and dark mode. Screenshots are attached to the test result and
/// exported by CI as an artifact.
final class ScreenshotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        // A test that failed while sideways leaves the simulator sideways; every test starts upright.
        XCUIDevice.shared.orientation = .portrait
    }

    func testScreensLight() { capture(dark: false) }

    func testScreensDark() { capture(dark: true) }

    /// A road alert: one SIMULATED crash 6 miles ahead (-demoAlert, labeled in the app as a simulated test alert)
    /// takes the Drive focus card and shows in Road Ahead with the alert sources' status.
    func testRoadAlert() {
        for dark in [false, true] {
            let app = XCUIApplication()
            app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-overnight", "auto", "-demoAlert", "-drive", "map"] + (dark ? ["-forceDark"] : [])
            app.launch()
            XCTAssertTrue(drive(app), "Drive screen did not appear")
            let card = app.descendants(matching: .any)["alertCard"].firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 20), "No road alert card")
            sleep(5)
            snap("1f Road alert navigation", dark)
            app.buttons["focusViewButton"].firstMatch.tap()
            XCTAssertTrue(app.descendants(matching: .any)["focusDrive"].firstMatch.waitForExistence(timeout: 10), "Focus view did not appear")
            sleep(2)
            snap("1f Road alert focus", dark)
            // The alert's detail sheet, from the Drive card.
            app.buttons["alertCard"].firstMatch.tap()
            XCTAssertTrue(app.descendants(matching: .any)["alertDetail"].firstMatch.waitForExistence(timeout: 10), "No alert detail")
            sleep(1)
            snap("1m Alert detail", dark)
            app.buttons["Done"].firstMatch.tap()
            sleep(1)
            app.tabBars.buttons["Ahead"].tap()
            XCTAssertTrue(app.navigationBars["Road Ahead"].waitForExistence(timeout: 10))
            let status = app.descendants(matching: .any)["alertStatus"].firstMatch
            if status.waitForExistence(timeout: 10) { status.tap() }
            sleep(2)
            snap("2b Road Ahead alert", dark)
            // A filter never hides the urgent alert without saying so.
            app.buttons["filter-fuel"].firstMatch.tap()
            sleep(1)
            XCTAssertTrue(app.buttons["alertRow"].firstMatch.waitForExistence(timeout: 5), "The Fuel filter hid the urgent alert")
            XCTAssertTrue(app.buttons["filterNote"].firstMatch.exists, "The Fuel filter does not say the urgent alert stays in view")
            snap("2f Road Ahead fuel filter", dark)
            app.buttons["filter-alerts"].firstMatch.tap()
            sleep(1)
            snap("2g Road Ahead alerts", dark)
            app.terminate()
        }
    }

    /// The weather pill in the top bar and its sheet, from the National Weather Service for the demo's
    /// position. These are real network answers: when the service cannot be reached from CI the pill never
    /// appears (nothing is shown rather than a guess), and the test is skipped rather than failed.
    func testWeather() throws {
        for dark in [false, true] {
            let app = XCUIApplication()
            app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-overnight", "auto", "-drive", "focus"] + (dark ? ["-forceDark"] : [])
            app.launch()
            XCTAssertTrue(drive(app), "Drive screen did not appear")
            let pill = app.buttons["weatherPill"].firstMatch
            guard pill.waitForExistence(timeout: 45) else {
                app.terminate()
                throw XCTSkip("The National Weather Service did not answer from CI")
            }
            snap("1g Weather pill", dark)
            pill.tap()
            XCTAssertTrue(app.descendants(matching: .any)["weatherCard"].firstMatch.waitForExistence(timeout: 10), "No weather card")
            sleep(1)
            snap("1h Weather", dark)
            app.terminate()
        }
    }

    /// Overnight Drive Mode on: before a long stretch where no stop is listed open at its arrival time, the
    /// last one that is takes the focus card. Which stretch qualifies depends on the time of day (stores open and
    /// close), so the demo starts at the mile for the current New York time: mile 1035 from 5:35 AM to 10:30 PM,
    /// mile 599 from 9:40 PM to 6:05 AM, switching at 10 PM and 5:50 AM (both engines check these windows in
    /// Fixtures/smartstop/route_expectations.json). Live road alerts are off so none can take the card.
    func testOvernightLastOpenStop() {
        var newYork = Calendar(identifier: .gregorian)
        newYork.timeZone = TimeZone(identifier: "America/New_York")!
        let c = newYork.dateComponents([.hour, .minute], from: Date())
        let minute = (c.hour ?? 12) * 60 + (c.minute ?? 0)
        let mile = minute >= 22 * 60 || minute < 5 * 60 + 50 ? "599" : "1035"
        let app = XCUIApplication()
        app.launchArguments = ["-demoTrip", mile, "-demoVehicle", "-overnight", "on", "-alertsOff", "-drive", "focus"]
        app.launch()
        XCTAssertTrue(drive(app), "Drive screen did not appear")
        let card = app.descendants(matching: .any)["lastOpenCard"].firstMatch
        let found = card.waitForExistence(timeout: 20)
        sleep(2)
        snap("1e Overnight last open stop", false)
        XCTAssertTrue(found, "No last open stop card at mile \(mile) with Overnight Drive Mode on (New York time \(minute / 60):\(String(format: "%02d", minute % 60)))")
    }

    /// A maneuver within 10 miles (the exit from I-295 onto I-95 near Jacksonville, from the route's own steps)
    /// takes the guidance banner in both presentations.
    func testManeuver() {
        let app = XCUIApplication()
        app.launchArguments = ["-demoTrip", "346", "-demoVehicle", "-overnight", "auto", "-alertsOff", "-drive", "map", "-forceDark"]
        app.launch()
        XCTAssertTrue(drive(app), "Drive screen did not appear")
        sleep(5)
        snap("1j Maneuver navigation", true)
        app.buttons["focusViewButton"].firstMatch.tap()
        sleep(2)
        snap("1j Maneuver focus", true)
    }

    /// Traffic with a SIMULATED reading (-demoTraffic, labeled "Simulated traffic" in the app; Apple is never asked
    /// during a simulated drive): the arrival label on the journey panel, the traffic button on the map, the basis
    /// on the Trip tab and the Traffic settings. Real traffic needs a drive on a device (docs/16).
    func testTraffic() {
        for dark in [false, true] {
            let app = XCUIApplication()
            app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-overnight", "auto", "-alertsOff", "-drive", "map", "-demoTraffic"]
                + (dark ? ["-forceDark"] : [])
            app.launch()
            XCTAssertTrue(drive(app), "Drive screen did not appear")
            let strip = app.descendants(matching: .any)["tripStrip"].firstMatch
            XCTAssertTrue(strip.waitForExistence(timeout: 20), "No trip strip")
            let traffic = NSPredicate(format: "label CONTAINS[c] 'with traffic'")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: traffic, object: strip)], timeout: 30), .completed,
                           "The arrival never said it includes traffic: \(strip.label)")
            sleep(3)
            snap("1n Traffic navigation", dark)
            let button = app.buttons["trafficButton"].firstMatch
            XCTAssertTrue(button.exists, "No traffic button on the map")
            button.tap()
            sleep(2)
            snap("1o Traffic layer off", dark)
            button.tap()
            app.tabBars.buttons["Trip"].tap()
            let basis = app.descendants(matching: .any)["trafficBasis"].firstMatch
            XCTAssertTrue(basis.waitForExistence(timeout: 10), "No arrival basis on the Trip tab")
            XCTAssertTrue(basis.label.contains("Simulated traffic"), "The basis does not name the simulated source: \(basis.label)")
            sleep(1)
            snap("4g Trip traffic basis", dark)
            app.buttons["settingsButton"].firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
            let toggle = app.switches["trafficOnMapToggle"].firstMatch
            for _ in 0..<10 where !(toggle.exists && toggle.isHittable) { app.swipeUp() }
            XCTAssertTrue(toggle.exists, "No traffic settings")
            sleep(1)
            snap("6f Traffic settings", dark)
            app.terminate()
        }
    }

    /// Waits for either Drive presentation.
    private func drive(_ app: XCUIApplication) -> Bool {
        app.descendants(matching: .any)["journeyPanel"].firstMatch.waitForExistence(timeout: 90)
    }

    private func capture(dark: Bool) {
        let app = XCUIApplication()
        app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-demoRange", "180", "-overnight", "auto", "-drive", "map"] + (dark ? ["-forceDark"] : [])
        app.launch()

        // Navigation View first (the map loads its tiles), then the Focus View, both without scrolling.
        XCTAssertTrue(drive(app), "Drive screen did not appear")
        XCTAssertTrue(app.descendants(matching: .any)["navigationDrive"].firstMatch.waitForExistence(timeout: 10), "Navigation view did not appear")
        sleep(6)
        snap("1 Drive navigation", dark)
        assertOnScreen(["guidanceBanner", "speedChip", "journeyPanel"], app: app, "Navigation view")
        app.buttons["focusViewButton"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["focusDrive"].firstMatch.waitForExistence(timeout: 10), "Focus view did not appear")
        sleep(2)
        snap("1a Drive focus", dark)
        assertOnScreen(["journeyPanel", "nextExitRow", "fuelButton", "restroomButton"], app: app, "Focus view")

        // Sideways: both presentations.
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(3)
        snap("1k Drive focus landscape", dark)
        app.buttons["navigationViewButton"].firstMatch.tap()
        sleep(5)
        snap("1l Drive navigation landscape", dark)
        XCUIDevice.shared.orientation = .portrait
        sleep(3)

        // The one tap restroom stop.
        let restroom = app.buttons["restroomButton"].firstMatch
        XCTAssertTrue(restroom.waitForExistence(timeout: 5), "No restroom button on the Drive screen")
        restroom.tap()
        XCTAssertTrue(app.navigationBars["Restroom stop"].waitForExistence(timeout: 10), "Restroom stop sheet did not open")
        sleep(2)
        snap("1i Restroom stop", dark)
        app.buttons["Done"].firstMatch.tap()
        sleep(1)

        // The fuel button on the Drive screen opens the fuel stop sheet.
        let fuel = app.buttons["fuelButton"].firstMatch
        XCTAssertTrue(fuel.waitForExistence(timeout: 5), "No fuel button on the Drive screen")
        fuel.tap()
        XCTAssertTrue(app.navigationBars["Fuel Stop"].waitForExistence(timeout: 10), "Fuel stop sheet did not open")
        sleep(2)
        snap("1c Fuel stop", dark)
        app.swipeUp()
        sleep(1)
        snap("1d Fuel stop alternatives", dark)
        app.buttons["Done"].firstMatch.tap()
        sleep(1)

        app.tabBars.buttons["Ahead"].tap()
        XCTAssertTrue(app.navigationBars["Road Ahead"].waitForExistence(timeout: 10))
        sleep(1)
        snap("2 Road Ahead", dark)
        let why = app.descendants(matching: .any)["whyThisStop"].firstMatch
        if why.waitForExistence(timeout: 5) {
            why.tap()
            sleep(1)
            snap("2c Best stop reasons", dark)
            why.tap()
            sleep(1)
        }
        app.buttons["filter-states"].firstMatch.tap()
        sleep(1)
        XCTAssertTrue(app.descendants(matching: .any)["currentStateRow"].firstMatch.waitForExistence(timeout: 5), "States does not start with the current state")
        snap("2d Road Ahead states", dark)
        app.buttons["filter-rest"].firstMatch.tap()
        sleep(1)
        snap("2e Road Ahead rest", dark)
        app.buttons["filter-all"].firstMatch.tap()
        sleep(1)

        let row = app.buttons["exitRow"].firstMatch
        if row.waitForExistence(timeout: 5) {
            row.tap()
            sleep(3)
            snap("3 Exit detail", dark)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        let rest = app.buttons["restAreaRow"].firstMatch
        if rest.waitForExistence(timeout: 5), rest.isHittable {
            rest.tap()
            sleep(2)
            snap("3b Rest area", dark)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        app.tabBars.buttons["Trip"].tap()
        sleep(5)
        snap("4 Trip overview", dark)
        app.swipeUp()
        sleep(1)
        snap("5 Itinerary", dark)
        // Discover ahead and the trip buttons sit below the itinerary.
        let discover = app.buttons["discoverRow"].firstMatch
        if reveal(discover, in: app) {
            snap("4c Discover ahead", dark)
            discover.tap()
            sleep(2)
            snap("4d Discover place", dark)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }
        let planStop = app.buttons["Plan a stop ahead"].firstMatch
        if reveal(planStop, in: app) {
            planStop.tap()
            sleep(3)
            snap("4b Plan a stop", dark)
            app.buttons["Done"].firstMatch.tap()
            sleep(1)
        }
        // The plate game was removed: it must not be reachable from the trip screen.
        XCTAssertFalse(app.buttons["License plate game"].exists)
        let card = app.buttons["Share trip card"].firstMatch
        if reveal(card, in: app), card.isEnabled {
            card.tap()
            if app.navigationBars["Trip card"].waitForExistence(timeout: 5) {
                sleep(2)
                snap("4f Trip card", dark)
                app.buttons["Done"].firstMatch.tap()
                sleep(1)
            }
        }

        // Settings open from the person button in the navigation bar.
        app.buttons["settingsButton"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        sleep(2)
        snap("6 Settings", dark)

        // Pages pushed inside the Settings sheet, in list order from the top. Back is tapped only on the
        // page's own navigation bar, so a missed tap can never hit Done and close the sheet.
        push(app.buttons["Live Activity preview"].firstMatch, title: "Live Activity", name: "7 Live Activity", app: app, dark: dark)
        // Fuel stop preferences: favorite brands in order and what a stop must have.
        push(app.buttons["fuelStopsLink"].firstMatch, title: "Fuel Stops", name: "6d Fuel stops", app: app, dark: dark)
        // Travel statistics replace the Road Trip Passport (no achievements).
        push(app.buttons["travelsLink"].firstMatch, title: "Your Travels", name: "6b Your travels", app: app, dark: dark) {
            XCTAssertFalse(app.staticTexts["Next up"].exists)
        }

        // Where the profile is kept, export and import.
        XCTAssertTrue(reveal(app.buttons["Export profile"].firstMatch, in: app), "Profile section not found")
        snap("6e Profile", dark)

        push(app.buttons["Data sources and licenses"].firstMatch, title: "Data Sources", name: "6c Data sources", app: app, dark: dark)
    }

    /// Opens a page pushed from Settings, captures it and goes back. Fails when the link or the page is missing.
    private func push(_ link: XCUIElement, title: String, name: String, app: XCUIApplication, dark: Bool, check: () -> Void = {}) {
        XCTAssertTrue(reveal(link, in: app), "\(name): link not found")
        link.tap()
        let bar = app.navigationBars[title]
        XCTAssertTrue(bar.waitForExistence(timeout: 10), "\(name): page did not open")
        sleep(2)
        check()
        snap(name, dark)
        bar.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10), "\(name): did not return to Settings")
        sleep(1)
    }

    /// Scrolls up until the element can be tapped, clear of the bottom edge: a row sitting at the very bottom
    /// of the Settings sheet was reported hittable but the tap did not open it. While the element is off
    /// screen, swipes (fast, far); once it is on screen, a short slow drag that holds at the end, since a
    /// swipe would fling it past the top. The drag runs down the left side, away from the switches.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, steps: Int = 12) -> Bool {
        func clear() -> Bool { element.exists && element.isHittable && element.frame.maxY < app.frame.maxY - 150 }
        for _ in 0..<steps where !clear() {
            if element.exists && element.isHittable {
                let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.72))
                let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.42))
                from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
            } else {
                app.swipeUp()
            }
            sleep(1)
        }
        return element.exists && element.isHittable
    }

    /// Everything named is on screen: below the top of the window and above the tab bar, without scrolling.
    private func assertOnScreen(_ ids: [String], app: XCUIApplication, _ screen: String) {
        let bottom = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : app.frame.maxY
        for id in ids {
            let e = app.descendants(matching: .any)[id].firstMatch
            XCTAssertTrue(e.waitForExistence(timeout: 5), "\(screen): \(id) missing")
            XCTAssertTrue(e.frame.minY >= app.frame.minY && e.frame.maxY <= bottom + 1,
                          "\(screen): \(id) not fully on screen (\(e.frame.minY) to \(e.frame.maxY), tab bar at \(bottom))")
        }
    }

    private func snap(_ name: String, _ dark: Bool) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(name) \(dark ? "dark" : "light")"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
