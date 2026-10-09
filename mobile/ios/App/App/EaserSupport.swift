import SwiftUI
import UIKit
import Security
import CoreLocation

// Brand: sky blue #00BFFF, dark #0099CC (CLAUDE.md, Brand & Design-System seat).
// Text on a sky-blue button is ink, never white: white on #00BFFF fails contrast.
enum Brand {
    static let sky = Color(red: 0, green: 191.0 / 255.0, blue: 1)
    static let skyDark = Color(red: 0, green: 153.0 / 255.0, blue: 204.0 / 255.0)
    static let ink = Color(red: 13.0 / 255.0, green: 17.0 / 255.0, blue: 23.0 / 255.0)
    static let surface = Color(uiColor: .secondarySystemBackground)
    static let attention = Color(red: 0.85, green: 0.47, blue: 0.02)
}

enum Site {
    static let base = URL(string: "https://www.assembleatease.com")!
    static func page(_ path: String) -> URL { URL(string: base.absoluteString + path)! }
    static let supportPhone = "+19792325139"
    static let supportPhoneDisplay = "(979) 232-5139"
    static let supportEmail = "service@assembleatease.com"
}

enum Format {
    private static let currency: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.locale = Locale(identifier: "en_US")
        return f
    }()

    static func money(cents: Double?) -> String {
        guard let cents else { return "$0.00" }
        return currency.string(from: NSNumber(value: cents / 100.0)) ?? "$0.00"
    }

    private static let dayIn: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let dayOut: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "EEE, MMM d"
        return f
    }()

    /// "2026-10-12" becomes "Mon, Oct 12". Anything else is shown as the server wrote it.
    static func day(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        if let date = dayIn.date(from: String(raw.prefix(10))) { return dayOut.string(from: date) }
        return raw
    }

    static func timestamp(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        return dayIn.date(from: String(raw.prefix(10)))
    }

    static func relative(_ raw: String?) -> String? {
        guard let date = timestamp(raw) else { return nil }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }

    /// Time left on an offer, in the words an Easer uses.
    static func timeLeft(until raw: String?, now: Date = Date()) -> String? {
        guard let end = timestamp(raw) else { return nil }
        let seconds = Int(end.timeIntervalSince(now))
        if seconds <= 0 { return "Offer expired" }
        let minutes = max(1, seconds / 60)
        if minutes < 60 { return "Respond within \(minutes) min" }
        return "Respond within \(minutes / 60) hr \(minutes % 60) min"
    }
}

/// The signed-in session lives in the Keychain, never in plain app storage.
enum SessionVault {
    private static let service = "com.assembleatease.easer.session"
    private static let account = "current"
    private static let installedKey = "easer.installed.v1"

    /// The Keychain survives deleting the app. A fresh install starts signed out.
    static func clearIfFreshInstall() {
        if !UserDefaults.standard.bool(forKey: installedKey) {
            delete()
            UserDefaults.standard.set(true, forKey: installedKey)
        }
    }

    static func load() -> EaserSession? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(EaserSession.self, from: data)
    }

    static func save(_ session: EaserSession?) {
        delete()
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Location is read once, only when the Easer taps "I've arrived". Check-in
/// still works without it: the server accepts an arrival with no position.
@MainActor
final class OneTimeLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?

    func current(timeoutSeconds: Double = 8) async -> CLLocation? {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        return await withCheckedContinuation { (continuation: CheckedContinuation<CLLocation?, Never>) in
            self.continuation = continuation
            switch manager.authorizationStatus {
            case .notDetermined:
                // Time spent reading the prompt does not count against the fix.
                manager.requestWhenInUseAuthorization()
                giveUp(after: 45)
            case .authorizedWhenInUse, .authorizedAlways:
                manager.requestLocation()
                giveUp(after: timeoutSeconds)
            default:
                finish(nil)
            }
        }
    }

    private func giveUp(after seconds: Double) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            self.finish(nil)
        }
    }

    private func finish(_ location: CLLocation?) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(returning: location)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            switch status {
            case .authorizedWhenInUse, .authorizedAlways:
                if self.continuation != nil {
                    self.manager.requestLocation()
                    self.giveUp(after: 8)
                }
            case .denied, .restricted:
                self.finish(nil)
            default:
                break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let location = locations.last
        Task { @MainActor in self.finish(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}

/// Mirrors api/_upload-limits.js: longest edge 1600 px, and never more than
/// MAX_UPLOAD_BYTES of image data. scripts/test-easer-native-app.mjs holds the two equal.
enum PhotoPrep {
    static let maxEdgePixels: CGFloat = 1600
    static let maxUploadBytes = 3181977
    private static let qualities: [CGFloat] = [0.82, 0.7, 0.55, 0.4]

    static func jpeg(from image: UIImage) -> Data? {
        let size = image.size
        let longest = max(size.width, size.height)
        let scale = longest > maxEdgePixels ? maxEdgePixels / longest : 1
        let target = CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        for quality in qualities {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= maxUploadBytes { return data }
        }
        return nil
    }
}

/// Mirrors assembler/profile.html: longest edge 384 px, JPEG, at most 350,000
/// characters as a data: URL (quality 0.8, then 0.62).
enum ProfilePhotoPrep {
    static let maxEdgePixels: CGFloat = 384
    static let maxDataURLLength = 350000

    static func dataURL(from image: UIImage) -> String? {
        let size = image.size
        let longest = max(size.width, size.height)
        let scale = longest > maxEdgePixels ? maxEdgePixels / longest : 1
        let target = CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        for quality in [CGFloat(0.8), CGFloat(0.62)] {
            if let data = resized.jpegData(compressionQuality: quality) {
                let url = "data:image/jpeg;base64," + data.base64EncodedString()
                if url.count <= maxDataURLLength { return url }
            }
        }
        return nil
    }

    /// The stored value as an image, when it is an inline data: URL.
    static func image(from value: String?) -> UIImage? {
        guard let value, value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ",") else { return nil }
        guard let data = Data(base64Encoded: String(value[value.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

/// The AssembleAtEase logo: the real AAE monogram (images/logo.jpg), never a stand-in.
struct BrandLogo: View {
    var size: CGFloat = 64
    var body: some View {
        Image("AAELogo")
            .resizable()
            .scaledToFill()
            .frame(width: size, height: size)
            .clipShape(Circle())
            .accessibilityLabel("AssembleAtEase")
    }
}

/// The Easer's profile photo, or their initials when there is none.
struct Avatar: View {
    let photo: String?
    let name: String?
    var size: CGFloat = 40

    var body: some View {
        Group {
            if let image = ProfilePhotoPrep.image(from: photo) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if let photo, photo.hasPrefix("https://"), let url = URL(string: photo) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() } else { initials }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel("Profile photo")
    }

    private var initials: some View {
        let letters = (name ?? "").split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined().uppercased()
        return ZStack {
            Circle().fill(Brand.sky.opacity(0.2))
            Text(letters.isEmpty ? "E" : letters)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(Brand.skyDark)
        }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var enabled = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background((enabled ? Brand.sky : Color.gray.opacity(0.35)).opacity(configuration.isPressed ? 0.8 : 1),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(Brand.ink)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(Brand.surface.opacity(configuration.isPressed ? 0.7 : 1),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(.primary)
    }
}
