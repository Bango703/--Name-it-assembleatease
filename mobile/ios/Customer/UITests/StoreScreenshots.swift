import XCTest

/// App Store screenshots of the real app, taken on the 6.9-inch simulator by the
/// customer-screenshots workflow in codemagic.yaml, once in English and once in
/// Spanish. Browses as a guest, so no account and no live data change: the
/// booking stops at the arrival window, before sign-in. Each PNG is written to the
/// Mac running the simulator (SIMULATOR_HOST_HOME/aae-screens/<lang>);
/// scripts/app-store-frames.py then lays out each frame from store-captions.json.
/// Every name saved here has a frame there (scripts/test-customer-native-app.mjs
/// checks both ways).
final class StoreScreenshots: XCTestCase {
    private var app: XCUIApplication!
    private var language = "en"

    /// The app's own words for what this test taps, in Spanish
    /// (mobile/ios/Localization/es.json; scripts/test-ios-spanish.mjs keeps them equal).
    /// Service and item names come from the server and stay English.
    private static let spanish: [String: String] = [
        "What do you need help with?": "¿Con qué necesitas ayuda?",
        "Add": "Agregar",
        "Close": "Cerrar",
        "View order": "Ver pedido",
        "Your order": "Tu pedido",
        "Done": "Listo",
        "Continue": "Continuar",
        "Home": "Inicio",
        "Room-ready bundles": "Paquetes para cada cuarto",
    ]

    private func t(_ english: String) -> String {
        language == "es" ? (Self.spanish[english] ?? english) : english
    }

    override func setUp() {
        continueAfterFailure = true
    }

    func testCaptureEnglish() {
        capture(language: "en")
    }

    func testCaptureSpanish() {
        capture(language: "es")
    }

    private func capture(language: String) {
        self.language = language
        app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "es" ? "es_US" : "en_US"]
        app.launch()

        // Home with the services and their photos loaded.
        XCTAssertTrue(app.staticTexts["Furniture Assembly"].waitForExistence(timeout: 30), "catalog loaded")
        sleep(3)
        save("01-home")

        // Search the way a customer types it, and add the first result.
        let searchEntry = app.staticTexts[t("What do you need help with?")].firstMatch
        if searchEntry.waitForExistence(timeout: 10) {
            searchEntry.tap()
            let field = app.textFields[t("What do you need help with?")].firstMatch
            if field.waitForExistence(timeout: 10) {
                field.typeText("mount tv")
                sleep(2)
                save("02-search")
                let add = app.buttons.matching(identifier: t("Add")).firstMatch
                if add.waitForExistence(timeout: 5) { add.tap() }
                sleep(1)
            }
            let close = app.buttons[t("Close")].firstMatch
            if close.waitForExistence(timeout: 5) { close.tap() }
            sleep(2)
        }

        // A service list, then two items into the order.
        let tile = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Furniture Assembly'")).firstMatch
        if tile.waitForExistence(timeout: 10) { tile.tap() } else { app.staticTexts["Furniture Assembly"].firstMatch.tap() }
        sleep(3)
        save("03-furniture-list")
        let adds = app.buttons.matching(identifier: t("Add"))
        if adds.firstMatch.waitForExistence(timeout: 10) {
            adds.element(boundBy: 0).tap()
            sleep(1)
            if adds.count > 0 { adds.element(boundBy: 0).tap() }
        }
        sleep(1)

        // The order with its prices, opened to full height so nothing is greyed behind it.
        let viewOrder = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", t("View order"))).firstMatch
        if viewOrder.waitForExistence(timeout: 10) {
            viewOrder.tap()
            sleep(2)
            let title = app.navigationBars[t("Your order")].firstMatch
            if title.waitForExistence(timeout: 5) { title.swipeUp() }
            sleep(2)
            save("04-order")
            let done = app.buttons[t("Done")].firstMatch
            if done.waitForExistence(timeout: 5) { done.tap() }
            sleep(2)
        }

        // The day and an arrival window. Stops here, before sign-in.
        let next = app.buttons[t("Continue")].firstMatch
        if next.waitForExistence(timeout: 10) {
            next.tap()
            sleep(3)
            let window = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'AM' OR label CONTAINS[c] 'PM'")).firstMatch
            if window.waitForExistence(timeout: 10) { window.tap() }
            sleep(1)
            save("05-when")
        }

        // Back to Home and down to the room-ready bundles.
        let home = app.buttons[t("Home")].firstMatch
        if home.waitForExistence(timeout: 5) { home.tap() }
        sleep(2)
        let back = app.navigationBars.buttons.element(boundBy: 0)
        var steps = 0
        while !app.staticTexts[t("Room-ready bundles")].exists && back.exists && steps < 4 {
            back.tap()
            sleep(1)
            steps += 1
        }
        let bundles = app.staticTexts[t("Room-ready bundles")].firstMatch
        var swipes = 0
        while !(bundles.exists && bundles.isHittable) && swipes < 4 {
            app.swipeUp()
            sleep(1)
            swipes += 1
        }
        sleep(2)
        save("06-bundles")
        app.terminate()
    }

    private func save(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "\(language)-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let host = ProcessInfo.processInfo.environment["SIMULATOR_HOST_HOME"] else { return }
        let dir = URL(fileURLWithPath: host).appendingPathComponent("aae-screens").appendingPathComponent(language)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? png.write(to: dir.appendingPathComponent(name + ".png"))
    }
}
