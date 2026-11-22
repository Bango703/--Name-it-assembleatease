import XCTest

/// App Store screenshots of the real Easer app, taken on the 6.9-inch simulator by
/// the easer-screenshots workflow in codemagic.yaml, in English and in Spanish.
/// Signs in to the App Review demo Easer (EASER_DEMO_EMAIL / EASER_DEMO_PASSWORD,
/// passed by the workflow; never written in this repo). The demo account works only
/// test bookings, so nothing here touches a real job. Each PNG goes to
/// SIMULATOR_HOST_HOME/aae-screens/<lang>; scripts/app-store-frames.py lays out
/// each frame from store-captions.json beside this file.
final class EaserStoreScreenshots: XCTestCase {
    private var app: XCUIApplication!
    private var language = "en"

    /// The app's own words for what this test taps, in Spanish
    /// (mobile/ios/Localization/es.json; scripts/test-ios-spanish.mjs keeps them equal).
    private static let spanish: [String: String] = [
        "Email": "Correo electrónico",
        "Password": "Contraseña",
        "Sign in": "Iniciar sesión",
        "Today": "Hoy",
        "Jobs": "Trabajos",
        "Upcoming": "Próximos",
        "Past": "Anteriores",
        "Earnings": "Ganancias",
        "Account": "Cuenta",
        "Work preferences": "Preferencias de trabajo",
        "Refer a pro": "Recomienda a un profesional",
    ]

    private func t(_ english: String) -> String {
        language == "es" ? (Self.spanish[english] ?? english) : english
    }

    override func setUp() {
        continueAfterFailure = true
        // The notification question can appear on first launch; answer it so it never covers a screen.
        addUIInterruptionMonitor(withDescription: "System alert") { alert in
            for label in ["Allow", "Permitir", "Don’t Allow", "No permitir", "OK"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
    }

    func testCaptureEnglish() throws {
        try capture(language: "en")
    }

    func testCaptureSpanish() throws {
        try capture(language: "es")
    }

    private func capture(language: String) throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["EASER_DEMO_EMAIL"], !email.isEmpty,
              let password = env["EASER_DEMO_PASSWORD"], !password.isEmpty else {
            throw XCTSkip("EASER_DEMO_EMAIL and EASER_DEMO_PASSWORD are not set.")
        }
        self.language = language
        app = XCUIApplication()
        app.launchArguments += ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "es" ? "es_US" : "en_US"]
        app.launch()

        let today = app.tabBars.buttons[t("Today")].firstMatch
        if !today.waitForExistence(timeout: 8) {
            let emailField = app.textFields[t("Email")].firstMatch
            XCTAssertTrue(emailField.waitForExistence(timeout: 20), "sign-in screen")
            emailField.tap()
            emailField.typeText(email)
            let passwordField = app.secureTextFields[t("Password")].firstMatch
            passwordField.tap()
            passwordField.typeText(password)
            app.buttons[t("Sign in")].firstMatch.tap()
        }
        XCTAssertTrue(today.waitForExistence(timeout: 30), "signed in")
        app.tap()
        sleep(4)
        save("01-today")

        // Jobs, then the first job's detail.
        app.tabBars.buttons[t("Jobs")].firstMatch.tap()
        sleep(3)
        for segment in ["Upcoming", "Past"] {
            let button = app.segmentedControls.buttons[t(segment)].firstMatch
            if button.exists { button.tap() }
            sleep(2)
            if app.collectionViews.cells.count > 1 { break }
        }
        save("02-jobs")
        let rows = app.collectionViews.cells
        if rows.count > 1 {
            rows.element(boundBy: 1).tap()
            sleep(3)
            save("03-job")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }

        app.tabBars.buttons[t("Earnings")].firstMatch.tap()
        sleep(3)
        save("04-earnings")

        app.tabBars.buttons[t("Account")].firstMatch.tap()
        sleep(2)
        let preferences = app.buttons[t("Work preferences")].firstMatch
        if preferences.waitForExistence(timeout: 5) {
            preferences.tap()
            sleep(3)
            save("05-job-area")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            sleep(1)
        }
        let refer = app.buttons[t("Refer a pro")].firstMatch
        if refer.waitForExistence(timeout: 5) {
            refer.tap()
            sleep(3)
            save("06-refer")
        }
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
