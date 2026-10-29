import XCTest

/// Launches the bundled simulated demo trip frozen near the Florida/Georgia line and captures
/// the main screens in light and dark mode. Screenshots are attached to the test result and
/// exported by CI as an artifact.
final class ScreenshotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testScreensLight() { capture(dark: false) }

    func testScreensDark() { capture(dark: true) }

    /// A road alert: one SIMULATED crash 6 miles ahead (-demoAlert, labeled in the app as a simulated test alert)
    /// takes the Drive focus card and shows in Road Ahead with the alert sources' status.
    func testRoadAlert() {
        for dark in [false, true] {
            let app = XCUIApplication()
            app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-overnight", "auto", "-demoAlert"] + (dark ? ["-forceDark"] : [])
            app.launch()
            XCTAssertTrue(app.staticTexts["NEXT STATE"].waitForExistence(timeout: 90), "Drive dashboard did not appear")
            let card = app.descendants(matching: .any)["alertCard"].firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 20), "No road alert card")
            app.swipeUp()
            sleep(2)
            snap("1f Road alert", dark)
            app.tabBars.buttons["Ahead"].tap()
            XCTAssertTrue(app.navigationBars["Road Ahead"].waitForExistence(timeout: 10))
            let status = app.descendants(matching: .any)["alertStatus"].firstMatch
            if status.waitForExistence(timeout: 10) { status.tap() }
            sleep(2)
            snap("2b Road Ahead alert", dark)
            app.terminate()
        }
    }

    /// Overnight Drive Mode on: before a long stretch where no stop is listed open at its arrival time, the
    /// last one that is takes the focus card (mile 400 on the demo route, as on the web).
    func testOvernightLastOpenStop() {
        let app = XCUIApplication()
        app.launchArguments = ["-demoTrip", "400", "-demoVehicle", "-overnight", "on"]
        app.launch()
        XCTAssertTrue(app.staticTexts["NEXT STATE"].waitForExistence(timeout: 90), "Drive dashboard did not appear")
        let card = app.descendants(matching: .any)["lastOpenCard"].firstMatch
        let found = card.waitForExistence(timeout: 20)
        app.swipeUp()
        sleep(2)
        snap("1e Overnight last open stop", false)
        XCTAssertTrue(found, "No last open stop card at mile 400 with Overnight Drive Mode on")
    }

    private func capture(dark: Bool) {
        let app = XCUIApplication()
        app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-demoRange", "180", "-overnight", "auto"] + (dark ? ["-forceDark"] : [])
        app.launch()

        XCTAssertTrue(app.staticTexts["NEXT STATE"].waitForExistence(timeout: 90), "Drive dashboard did not appear")
        sleep(2)
        snap("1 Drive", dark)
        app.swipeUp()
        sleep(1)
        snap("1b Drive lower", dark)

        // The fuel card when fuel is the focus, otherwise the fuel item in the Then strip.
        // The demo has a range, so one of them must be there.
        var fuel = app.buttons["fuelCard"].firstMatch
        if !fuel.waitForExistence(timeout: 3) { fuel = app.buttons["fuelChip"].firstMatch }
        XCTAssertTrue(fuel.waitForExistence(timeout: 5), "No fuel card or fuel chip on the Drive screen")
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
    /// of the Settings sheet was reported hittable but the tap did not open it. Short slow drags that hold at
    /// the end move the list a fixed distance; a swipe flings it and can carry the row past the top. The
    /// drag runs down the left side, away from the switches.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, drags: Int = 8) -> Bool {
        func clear() -> Bool { element.exists && element.isHittable && element.frame.maxY < app.frame.maxY - 150 }
        for _ in 0..<drags where !clear() {
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.72))
            let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.42))
            from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
            sleep(1)
        }
        return element.exists && element.isHittable
    }

    private func snap(_ name: String, _ dark: Bool) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(name) \(dark ? "dark" : "light")"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
