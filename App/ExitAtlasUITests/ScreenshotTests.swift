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
