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

    private func capture(dark: Bool) {
        let app = XCUIApplication()
        app.launchArguments = ["-demoTrip", "370", "-demoVehicle", "-demoRange", "180"] + (dark ? ["-forceDark"] : [])
        app.launch()

        XCTAssertTrue(app.staticTexts["NEXT STATE"].waitForExistence(timeout: 90), "Drive dashboard did not appear")
        sleep(2)
        snap("1 Drive", dark)
        app.swipeUp()
        sleep(1)
        snap("1b Drive lower", dark)

        let fuel = app.buttons["fuelCard"].firstMatch
        if fuel.waitForExistence(timeout: 5) {
            fuel.tap()
            sleep(2)
            snap("1c Fuel stop", dark)
            app.buttons["Done"].firstMatch.tap()
            sleep(1)
        }

        app.tabBars.buttons["Exits"].tap()
        XCTAssertTrue(app.navigationBars["Exits Ahead"].waitForExistence(timeout: 10))
        sleep(1)
        snap("2 Exits", dark)

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
        let plates = app.buttons["License plate game"].firstMatch
        if reveal(plates, in: app) {
            plates.tap()
            sleep(1)
            for code in ["GA", "FL", "NY", "TX"] { app.buttons[code].firstMatch.tap() }
            snap("4e License plates", dark)
            app.buttons["Start over"].firstMatch.tap()
            app.buttons["Done"].firstMatch.tap()
            sleep(1)
        }
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

        app.tabBars.buttons["Settings"].tap()
        sleep(2)
        snap("6 Settings", dark)

        // Fuel stop preferences: favorite brands in order and what a stop must have.
        let fuelStops = app.buttons["fuelStopsLink"].firstMatch
        if reveal(fuelStops, in: app) {
            fuelStops.tap()
            sleep(2)
            snap("6d Fuel stops", dark)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        // The Live Activity views drawn in the app with the demo trip (the Lock Screen itself cannot be captured here).
        let preview = app.buttons["Live Activity preview"].firstMatch
        for _ in 0..<4 where !(preview.exists && preview.isHittable) {
            app.swipeUp()
            sleep(1)
        }
        if preview.exists, preview.isHittable {
            preview.tap()
            sleep(2)
            snap("7 Live Activity", dark)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        let passport = app.buttons["passportLink"].firstMatch
        if reveal(passport, in: app) {
            passport.tap()
            sleep(2)
            snap("6b Passport", dark)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        // Where the profile is kept, export and import.
        let export = app.buttons["Export profile"].firstMatch
        if reveal(export, in: app) {
            snap("6e Profile", dark)
        }

        let sources = app.buttons["Data sources and licenses"].firstMatch
        if reveal(sources, in: app) {
            sources.tap()
            sleep(2)
            snap("6c Data sources", dark)
        }
    }

    /// Scrolls up until the element can be tapped.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 5) -> Bool {
        for _ in 0..<swipes where !(element.exists && element.isHittable) {
            app.swipeUp()
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
