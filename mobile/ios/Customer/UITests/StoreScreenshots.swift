import XCTest

/// App Store screenshots of the real app, taken on the 6.9-inch simulator by the
/// customer-screenshots workflow in codemagic.yaml. Browses as a guest, so no
/// account and no live data change. Each PNG is written to the Mac running the
/// simulator (SIMULATOR_HOST_HOME/aae-screens) for Codemagic to collect.
final class StoreScreenshots: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
    }

    func testCaptureStoreScreenshots() {
        // Home with the services loaded.
        XCTAssertTrue(app.staticTexts["Furniture Assembly"].waitForExistence(timeout: 30), "catalog loaded")
        sleep(3)
        save("01-home")


        // A service list.
        let tile = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Furniture Assembly'")).firstMatch
        if tile.waitForExistence(timeout: 10) { tile.tap() } else { app.staticTexts["Furniture Assembly"].firstMatch.tap() }
        sleep(3)
        save("02-furniture-list")

        // Add two items and open the order.
        let adds = app.buttons.matching(identifier: "Add")
        if adds.firstMatch.waitForExistence(timeout: 10) {
            adds.element(boundBy: 0).tap()
            sleep(1)
            if adds.count > 0 { adds.element(boundBy: 0).tap() }
        }
        sleep(1)
        let viewOrder = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'View order'")).firstMatch
        if viewOrder.waitForExistence(timeout: 10) {
            viewOrder.tap()
            sleep(2)
            save("03-order")
        }
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
