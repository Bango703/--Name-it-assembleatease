import XCTest

/// App Store screenshots of the real app, taken on the 6.9-inch simulator by the
/// customer-screenshots workflow in codemagic.yaml. Browses as a guest, so no
/// account and no live data change: the booking stops at the arrival window,
/// before sign-in. Each PNG is written to the Mac running the simulator
/// (SIMULATOR_HOST_HOME/aae-screens); scripts/app-store-frames.py then puts the
/// headline from store-captions.json above each one. Every name saved here has a
/// headline there (scripts/test-customer-native-app.mjs checks both ways).
final class StoreScreenshots: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
    }

    func testCaptureStoreScreenshots() {
        // Home with the services and their photos loaded.
        XCTAssertTrue(app.staticTexts["Furniture Assembly"].waitForExistence(timeout: 30), "catalog loaded")
        sleep(3)
        save("01-home")

        // Search the way a customer types it, and add the first result.
        let searchEntry = app.staticTexts["What do you need help with?"].firstMatch
        if searchEntry.waitForExistence(timeout: 10) {
            searchEntry.tap()
            let field = app.textFields["What do you need help with?"].firstMatch
            if field.waitForExistence(timeout: 10) {
                field.typeText("mount tv")
                sleep(2)
                save("02-search")
                let add = app.buttons.matching(identifier: "Add").firstMatch
                if add.waitForExistence(timeout: 5) { add.tap() }
                sleep(1)
            }
            let close = app.buttons["Close"].firstMatch
            if close.waitForExistence(timeout: 5) { close.tap() }
            sleep(2)
        }

        // A service list, then two items into the order.
        let tile = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Furniture Assembly'")).firstMatch
        if tile.waitForExistence(timeout: 10) { tile.tap() } else { app.staticTexts["Furniture Assembly"].firstMatch.tap() }
        sleep(3)
        save("03-furniture-list")
        let adds = app.buttons.matching(identifier: "Add")
        if adds.firstMatch.waitForExistence(timeout: 10) {
            adds.element(boundBy: 0).tap()
            sleep(1)
            if adds.count > 0 { adds.element(boundBy: 0).tap() }
        }
        sleep(1)

        // The order with its prices, opened to full height so nothing is greyed behind it.
        let viewOrder = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'View order'")).firstMatch
        if viewOrder.waitForExistence(timeout: 10) {
            viewOrder.tap()
            sleep(2)
            let title = app.navigationBars["Your order"].firstMatch
            if title.waitForExistence(timeout: 5) { title.swipeUp() }
            sleep(2)
            save("04-order")
            let done = app.buttons["Done"].firstMatch
            if done.waitForExistence(timeout: 5) { done.tap() }
            sleep(2)
        }

        // The day and an arrival window. Stops here, before sign-in.
        let next = app.buttons["Continue"].firstMatch
        if next.waitForExistence(timeout: 10) {
            next.tap()
            sleep(3)
            let window = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'AM' OR label CONTAINS[c] 'PM'")).firstMatch
            if window.waitForExistence(timeout: 10) { window.tap() }
            sleep(1)
            save("05-when")
        }

        // Back to Home and down to the room-ready bundles.
        let home = app.buttons["Home"].firstMatch
        if home.waitForExistence(timeout: 5) { home.tap() }
        sleep(2)
        let back = app.navigationBars.buttons.element(boundBy: 0)
        var steps = 0
        while !app.staticTexts["Room-ready bundles"].exists && back.exists && steps < 4 {
            back.tap()
            sleep(1)
            steps += 1
        }
        let bundles = app.staticTexts["Room-ready bundles"].firstMatch
        var swipes = 0
        while !(bundles.exists && bundles.isHittable) && swipes < 4 {
            app.swipeUp()
            sleep(1)
            swipes += 1
        }
        sleep(2)
        save("06-bundles")
    }

    private func save(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let host = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] else { return }
        let dir = URL(fileURLWithPath: host).appendingPathComponent("aae-screens")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? png.write(to: dir.appendingPathComponent(name + ".png"))
    }
}
