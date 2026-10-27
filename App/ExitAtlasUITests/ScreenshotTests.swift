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
        app.launchArguments = ["-demoTrip", "370"] + (dark ? ["-forceDark"] : [])
        app.launch()

        XCTAssertTrue(app.staticTexts["NEXT STATE"].waitForExistence(timeout: 90), "Drive dashboard did not appear")
        sleep(2)
        snap("1 Drive", dark)

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
        }

        app.tabBars.buttons["Trip"].tap()
        sleep(5)
        snap("4 Trip overview", dark)
        app.swipeUp()
        sleep(1)
        snap("5 Itinerary", dark)
    }

    private func snap(_ name: String, _ dark: Bool) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "\(name) \(dark ? "dark" : "light")"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
