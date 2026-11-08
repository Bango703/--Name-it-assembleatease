import SwiftUI
import UIKit
import Security
import SafariServices
import MapKit

// Shared by both iPhone apps: AssembleAtEase (customers, mobile/ios/Customer)
// and Easer (mobile/ios/App). One brand, one session store, one way of opening
// links and formatting money and dates, so the two apps never drift apart.
// scripts/test-ios-shared.mjs checks that both apps compile this folder.

// Brand: sky blue #00BFFF, dark #0099CC (CLAUDE.md, Brand & Design-System seat).
// Text on a sky-blue button is ink, never white: white on #00BFFF fails contrast.
enum Brand {
    static let sky = Color(red: 0, green: 191.0 / 255.0, blue: 1)
    static let skyDark = Color(red: 0, green: 153.0 / 255.0, blue: 204.0 / 255.0)
    static let ink = Color(red: 13.0 / 255.0, green: 17.0 / 255.0, blue: 23.0 / 255.0)
    /// Fields, pills and placeholders inside a card: a step lighter than the card in dark mode.
    static let surface = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor.tertiarySystemBackground : UIColor.secondarySystemBackground })
    /// A card on a grouped page: white in light mode, raised grey in dark mode,
    /// so a card never disappears into a black page.
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    static let attention = Color(red: 0.85, green: 0.47, blue: 0.02)
}

/// Web pages (agreements, Stripe identity check, Stripe payout setup) open in a
/// sheet over the app, never in the Safari app, so an Easer never leaves the app
/// mid-setup and lands back where they started. Calls, email and Settings links
/// keep their system behaviour.
/// The last good answer to each read, kept on this device for the signed-in
/// Easer. The app opens on it at once and replaces it the moment the server
/// answers (stale-while-revalidate), so nothing pops in or flips on launch.
/// Cleared on sign-out; stored with iOS data protection.
struct SnapshotCache {
    let userID: String

    private var directory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("easer-snapshot-" + userID, isDirectory: true)
    }

    func save(_ data: Data, as key: String) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: directory.appendingPathComponent(key + ".json"),
                        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func load(_ key: String) -> Data? {
        try? Data(contentsOf: directory.appendingPathComponent(key + ".json"))
    }

    func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}

@MainActor
enum InAppBrowser {
    static func action(onClose: @escaping () -> Void) -> OpenURLAction {
        OpenURLAction { url in
            guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
                return .systemAction
            }
            present(url, onClose: onClose, attempt: 0)
            return .handled
        }
    }

    /// Our own pages opened in the sheet carry `aae_app=1`, so the website runs
    /// them with no optional analytics, ads or CRM cookies and no cookie banner
    /// (App Review, 2026-10-28, Guideline 5.1.2: tracking would need ATT).
    static func tagged(_ url: URL) -> URL {
        guard let host = url.host?.lowercased(), host == "assembleatease.com" || host.hasSuffix(".assembleatease.com"),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var items = parts.queryItems ?? []
        if !items.contains(where: { $0.name == "aae_app" }) { items.append(URLQueryItem(name: "aae_app", value: "1")) }
        parts.queryItems = items
        return parts.url ?? url
    }

    private static func present(_ url: URL, onClose: @escaping () -> Void, attempt: Int) {
        guard let root = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
            .first?.rootViewController else {
            UIApplication.shared.open(url)
            return
        }
        var top = root
        var settling = false
        while let next = top.presentedViewController {
            if next.isBeingDismissed { settling = true; break }
            top = next
        }
        // A sheet that is still closing (signing, then straight to the ID check)
        // cannot present yet; wait for it rather than drop the link.
        if settling || top.isBeingPresented {
            if attempt < 10 {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    present(url, onClose: onClose, attempt: attempt + 1)
                }
            } else {
                UIApplication.shared.open(url)
            }
            return
        }
        let browser = SFSafariViewController(url: tagged(url))
        browser.preferredControlTintColor = UIColor(Brand.skyDark)
        browser.dismissButtonStyle = .done
        let closer = Closer(onClose: onClose)
        browser.delegate = closer
        objc_setAssociatedObject(browser, &Closer.key, closer, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        top.present(browser, animated: true)
    }

    private final class Closer: NSObject, SFSafariViewControllerDelegate {
        static var key: UInt8 = 0
        let onClose: () -> Void
        init(onClose: @escaping () -> Void) { self.onClose = onClose }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onClose() }
    }
}

enum Site {
    static let base = URL(string: "https://www.assembleatease.com")!
    static func page(_ path: String) -> URL { URL(string: base.absoluteString + path)! }
    static let supportPhone = "+19792325139"
    static let supportPhoneDisplay = "979-232-5139"
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

    private static let clockOut: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "h:mm a"
        return f
    }()

    /// "2026-10-10T21:00:00Z" becomes "4:00 PM" (Central).
    static func clock(_ raw: String?) -> String? {
        guard let date = timestamp(raw) else { return nil }
        return clockOut.string(from: date)
    }

    /// The ten digits of a U.S. number, without a leading 1.
    static func phoneDigits(_ raw: String) -> String {
        let digits = raw.filter(\.isNumber)
        return digits.count == 11 && digits.hasPrefix("1") ? String(digits.dropFirst()) : digits
    }

    /// "+15125550142" shown as "512-555-0142". Anything else as written.
    static func phone(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        let d = phoneDigits(raw)
        guard d.count == 10 else { return raw }
        return "\(d.prefix(3))-\(d.dropFirst(3).prefix(3))-\(d.suffix(4))"
    }

    /// A number as it is typed: digits only, dashes added as it grows (512-555-0142).
    static func typingPhone(_ raw: String) -> String {
        let d = String(phoneDigits(raw).prefix(10))
        if d.count <= 3 { return d }
        if d.count <= 6 { return "\(d.prefix(3))-\(d.dropFirst(3))" }
        return "\(d.prefix(3))-\(d.dropFirst(3).prefix(3))-\(d.dropFirst(6))"
    }

    /// The stored form, +1XXXXXXXXXX, or nil when it is not a U.S. number.
    static func e164(_ raw: String) -> String? {
        let d = phoneDigits(raw)
        return d.count == 10 ? "+1" + d : nil
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
    /// Per app: com.assembleatease.easer.session in the Easer app (unchanged),
    /// com.assembleatease.customer.session in the customer app.
    private static var service: String { (Bundle.main.bundleIdentifier ?? "com.assembleatease") + ".session" }
    private static let account = "current"
    /// Settings are per app; the name is kept so the Easer app keeps its sessions.
    private static let installedKey = "easer.installed.v1"

    /// The Keychain survives deleting the app. A fresh install starts signed out.
    static func clearIfFreshInstall() {
        if !UserDefaults.standard.bool(forKey: installedKey) {
            delete()
            UserDefaults.standard.set(true, forKey: installedKey)
        }
    }

    static func load() -> AppSession? {
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
        return try? JSONDecoder().decode(AppSession.self, from: data)
    }

    static func save(_ session: AppSession?) {
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
            .frame(maxWidth: .infinity, minHeight: 56)
            .background((enabled ? Brand.sky : Color.gray.opacity(0.35)).opacity(configuration.isPressed ? 0.8 : 1),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(Brand.ink)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(Brand.surface.opacity(configuration.isPressed ? 0.7 : 1),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .foregroundStyle(.primary)
    }
}

// MARK: - Chat (both apps)

// One chat for the customer app and the Easer app, built from what DoorDash,
// Uber and TaskRabbit settled on: day dividers and a time under every message,
// messages from the same side grouped, "Seen" under the last message the other
// side has opened (the server stamps read_at when they open the conversation),
// one-tap quick replies, and a composer that sends on return.

/// A message as the chat draws it, whichever app it came from.
struct ChatLine: Identifiable, Equatable {
    let id: String
    let text: String
    let fromMe: Bool
    let author: String
    let sentAt: Date?
    let readAt: Date?
}

enum ChatFormat {
    private static let time: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "h:mm a"
        return f
    }()

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "EEEE, MMM d"
        return f
    }()

    static func clock(_ date: Date) -> String { time.string(from: date) }

    static func dayLabel(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return day.string(from: date)
    }
}

/// The conversation, newest at the bottom.
struct ChatTranscript: View {
    let lines: [ChatLine]
    let emptyText: String

    /// "Seen" goes under the newest message of mine the other side has opened.
    private var seenID: String? {
        lines.last(where: { $0.fromMe && $0.readAt != nil })?.id
    }

    private func startsDay(_ index: Int) -> Bool {
        guard let sent = lines[index].sentAt else { return false }
        guard index > 0, let before = lines[index - 1].sentAt else { return true }
        return !Calendar.current.isDate(before, inSameDayAs: sent)
    }

    private func startsGroup(_ index: Int) -> Bool {
        index == 0 || lines[index - 1].fromMe != lines[index].fromMe || startsDay(index)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 6) {
                    if lines.isEmpty {
                        Text(emptyText)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.top, 48)
                            .padding(.horizontal, 24)
                    }
                    ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                        if startsDay(index), let sent = line.sentAt {
                            Text(ChatFormat.dayLabel(sent))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Brand.surface, in: Capsule())
                                .padding(.vertical, 8)
                        }
                        ChatBubble(line: line, showAuthor: startsGroup(index), seen: line.id == seenID)
                            .id(line.id)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear { if let last = lines.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            .onChange(of: lines.count) { _, _ in
                if let last = lines.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
}

struct ChatBubble: View {
    let line: ChatLine
    let showAuthor: Bool
    let seen: Bool

    var body: some View {
        HStack(alignment: .bottom) {
            if line.fromMe { Spacer(minLength: 48) }
            VStack(alignment: line.fromMe ? .trailing : .leading, spacing: 3) {
                if showAuthor && !line.fromMe {
                    Text(line.author).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                Text(line.text)
                    .font(.body)
                    .foregroundStyle(line.fromMe ? Brand.ink : Color.primary)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(line.fromMe ? Brand.sky : Brand.surface,
                                in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .textSelection(.enabled)
                HStack(spacing: 4) {
                    if let sent = line.sentAt { Text(ChatFormat.clock(sent)) }
                    if seen { Text("· Seen").fontWeight(.semibold) }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            if !line.fromMe { Spacer(minLength: 48) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One-tap replies for the moments that come up on every job.
struct QuickReplies: View {
    let replies: [String]
    let send: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(replies, id: \.self) { reply in
                    Button { send(reply) } label: {
                        Text(reply)
                            .font(.subheadline)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Brand.surface, in: Capsule())
                            .overlay(Capsule().stroke(Brand.sky.opacity(0.5), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
        }
    }
}

/// The message box. Return sends; the button sends; nothing sends empty.
struct ChatComposer: View {
    @Binding var draft: String
    let placeholder: String
    let sending: Bool
    let send: () -> Void

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .submitLabel(.send)
                .onSubmit { if !empty && !sending { send() } }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Brand.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            Button(action: send) {
                if sending {
                    ProgressView().frame(width: 34, height: 34)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(empty ? Color(uiColor: .tertiaryLabel) : Brand.skyDark)
                }
            }
            .disabled(empty || sending)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// MARK: - Address search (both apps)

// Apple Maps fills in an address as it is typed: suggestions from the third
// letter, and a picked suggestion fills street, city, state and ZIP in Apple's
// own format. It runs on the phone (MapKit), so it needs no key, no location
// permission and no round trip through our server. The server still decides
// whether an address is in the service area; this only spares the typing.

/// An address as Apple Maps resolved it.
struct PickedAddress: Equatable {
    let street: String
    let city: String
    let state: String
    let zip: String
}

@MainActor
final class AddressSearch: NSObject, ObservableObject, MKLocalSearchCompleterDelegate {
    @Published private(set) var results: [MKLocalSearchCompletion] = []
    private let completer = MKLocalSearchCompleter()
    private let texasOnly: Bool
    /// The text a pick just wrote into the field; it is not searched again.
    private var picked: String?

    /// `texasOnly` keeps suggestions to addresses we can serve.
    init(texasOnly: Bool = true) {
        self.texasOnly = texasOnly
        super.init()
        completer.delegate = self
        completer.resultTypes = .address
        // Centered on Texas so Austin streets come before same-named streets elsewhere.
        completer.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 31.0, longitude: -99.3),
            span: MKCoordinateSpan(latitudeDelta: 11, longitudeDelta: 13)
        )
    }

    /// Call as the person types. Under three letters shows nothing.
    func update(_ text: String) {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let picked, query == picked { return }
        picked = nil
        guard query.count >= 3 else {
            clear()
            return
        }
        completer.queryFragment = query
    }

    func clear() {
        completer.cancel()
        results = []
    }

    /// Looks up the full address behind a suggestion.
    func resolve(_ completion: MKLocalSearchCompletion) async -> PickedAddress? {
        results = []
        let search = MKLocalSearch(request: MKLocalSearch.Request(completion: completion))
        guard let place = (try? await search.start())?.mapItems.first?.placemark else { return nil }
        let number = place.subThoroughfare ?? ""
        let road = place.thoroughfare ?? ""
        let street = [number, road].filter { !$0.isEmpty }.joined(separator: " ")
        let address = PickedAddress(
            street: street.isEmpty ? completion.title : street,
            city: place.locality ?? "",
            state: place.administrativeArea ?? "",
            zip: String((place.postalCode ?? "").prefix(5))
        )
        picked = address.street
        return address
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        MainActor.assumeIsolated {
            let found = completer.results.filter { item in
                guard texasOnly else { return true }
                return item.subtitle.contains(", TX") || item.subtitle.contains("Texas") || item.title.contains(", TX")
            }
            results = Array(found.prefix(5))
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        MainActor.assumeIsolated { results = [] }
    }
}

/// The suggestion rows under an address field.
struct AddressSuggestionList: View {
    @ObservedObject var search: AddressSearch
    let pick: (PickedAddress) -> Void

    var body: some View {
        ForEach(search.results, id: \.self) { item in
            Button {
                Task {
                    if let address = await search.resolve(item) { pick(address) }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "mappin.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Brand.skyDark)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        if !item.subtitle.isEmpty {
                            Text(item.subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Fills in the address")
        }
    }
}

// MARK: - Server fields

// Field names are the server's. Every field is optional and decoded one at a
// time, so one unexpected value never empties a whole list.

/// A signed-in Supabase session, kept in the Keychain (SessionVault).
struct AppSession: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var userID: String
    var expiresAt: Date
    /// From the sign-in response. The profile table is not read for it.
    var email: String?
}

struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

extension KeyedDecodingContainer where Key == DynamicKey {
    func string(_ key: String) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: DynamicKey(key)) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: DynamicKey(key)) { return String(value) }
        return nil
    }
    func number(_ key: String) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: DynamicKey(key)) { return value }
        if let text = try? decodeIfPresent(String.self, forKey: DynamicKey(key)) { return Double(text) }
        return nil
    }
    func bool(_ key: String) -> Bool? { (try? decodeIfPresent(Bool.self, forKey: DynamicKey(key))) ?? nil }
}
