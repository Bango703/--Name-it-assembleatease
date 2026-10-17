import UIKit
import SwiftUI

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: EaserAppRoot())
        self.window = window
        window.makeKeyAndVisible()
    }
}

private enum AppPalette {
    static let sky = Color(red: 0, green: 0.75, blue: 1)
    static let ink = Color(red: 0.05, green: 0.07, blue: 0.10)
    static let soft = Color(red: 0.96, green: 0.97, blue: 0.98)
}

private struct EaserSession: Codable {
    let accessToken: String
    let refreshToken: String?
    let userID: String
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", userID = "user_id" }
}

private struct AuthEnvelope: Decodable {
    let accessToken: String
    let refreshToken: String?
    let user: AuthUser
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", refreshToken = "refresh_token", user }
    struct AuthUser: Decodable { let id: String }
    var session: EaserSession { EaserSession(accessToken: accessToken, refreshToken: refreshToken, userID: user.id) }
}

private struct AssignmentEnvelope: Decodable {
    let bookings: [EaserJob]
}

private struct EaserJob: Codable, Identifiable, Hashable {
    let id: String
    let ref: String?
    let service: String?
    let date: String?
    let time: String?
    let address: String?
    let details: String?
    let customerName: String?
    let customerPhone: String?
    let status: String?
    let acceptedAt: String?
    let offerLocation: String?
    let offerToken: String?
    let offerExpiresAt: String?
    let canDecline: Bool?
    let estimateLow: Double?
    let estimateHigh: Double?
    let bookingItems: [JobItem]?

    enum CodingKeys: String, CodingKey {
        case id, ref, service, date, time, address, details, status
        case customerName = "customer_name"
        case customerPhone = "customer_phone"
        case acceptedAt = "assembler_accepted_at"
        case offerLocation = "_offer_location"
        case offerToken = "_offer_token"
        case offerExpiresAt = "_offer_expires_at"
        case canDecline = "_can_decline"
        case estimateLow = "_pay_estimate_lo"
        case estimateHigh = "_pay_estimate_hi"
        case bookingItems = "_booking_items"
    }

    struct JobItem: Codable, Hashable { let name: String?; let quantity: Int? }

    var isOffer: Bool { acceptedAt == nil && status == "confirmed" }
    var isActive: Bool { ["en_route", "arrived", "in_progress"].contains(status ?? "") }
    var money: String {
        guard let cents = estimateHigh ?? estimateLow else { return "Pay to be confirmed" }
        return "$" + String(format: "%.2f", cents / 100)
    }
    var shortLocation: String { address ?? offerLocation ?? "Texas service area" }
    var displayDate: String { [date, time].compactMap { $0 }.joined(separator: " · ") }
    var nextAction: String {
        switch status {
        case "confirmed": return isOffer ? "Review offer" : "Accept job"
        case "en_route": return "I arrived"
        case "arrived": return "Start work"
        case "in_progress": return "Complete job"
        default: return "View job"
        }
    }
}

private struct EarningsEnvelope: Decodable { let earnings: [Earning]; let summary: EarningsSummary }
private struct Earning: Decodable, Identifiable {
    let id: String
    let amountCents: Int?
    let payoutStatus: String?
    let earnedAt: String?
    let service: String?
    enum CodingKeys: String, CodingKey { case id; case amountCents = "amount_cents"; case payoutStatus = "payout_status"; case earnedAt = "earned_at"; case service }
}
private struct EarningsSummary: Decodable {
    let pendingCents: Int?
    let paidCents: Int?
    enum CodingKeys: String, CodingKey { case pendingCents = "pending_cents"; case paidCents = "paid_cents" }
}
private struct NotificationsEnvelope: Decodable { let notifications: [EaserNotice]; let unreadCount: Int? }
private struct EaserNotice: Decodable, Identifiable { let id: String; let title: String; let detail: String; let createdAt: String?; let read: Bool?; let bookingId: String?; enum CodingKeys: String, CodingKey { case id, title, detail, read; case createdAt = "createdAt"; case bookingId = "bookingId" } }
private struct APIProblem: Decodable { let error: String? }

@MainActor
private final class EaserStore: ObservableObject {
    @Published var session: EaserSession? { didSet { persistSession() } }
    @Published var jobs: [EaserJob] = []
    @Published var earnings: EarningsEnvelope?
    @Published var notices: [EaserNotice] = []
    @Published var available = false
    @Published var isLoading = false
    @Published var message: String?

    private let site = URL(string: "https://www.assembleatease.com")!
    private let supabase = URL(string: "https://ukamyqnaukxlmeoncjgr.supabase.co")!
    private let publicKey = "sb_publishable_VjHBCo8wUahtg31Gb321qA_TG1e_VbN"
    private let sessionKey = "assembleatease.easer.native.session.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: sessionKey), let saved = try? JSONDecoder().decode(EaserSession.self, from: data) { session = saved }
    }

    func signIn(email: String, password: String) async {
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !password.isEmpty else { message = "Enter your email and password."; return }
        isLoading = true; defer { isLoading = false }
        do {
            var request = URLRequest(url: supabase.appending(path: "/auth/v1/token"))
            request.httpMethod = "POST"
            request.setValue(publicKey, forHTTPHeaderField: "apikey")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
            var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            parts.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
            request.url = parts.url
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else { throw errorFrom(data, defaultMessage: "Sign in was not successful. Check your details and try again.") }
            session = try JSONDecoder().decode(AuthEnvelope.self, from: data).session
            await refresh()
        } catch { message = userMessage(error) }
    }

    func refresh() async {
        guard session != nil else { return }
        isLoading = true; defer { isLoading = false }
        do {
            async let assignments: AssignmentEnvelope = get("/api/booking/my-assignments")
            async let earned: EarningsEnvelope = get("/api/assembler/earnings")
            async let inbox: NotificationsEnvelope = get("/api/assembler/notifications")
            jobs = try await assignments.bookings
            earnings = try await earned
            notices = try await inbox.notifications
            message = nil
        } catch { message = userMessage(error) }
    }

    func accept(_ job: EaserJob) async {
        var body: [String: Any] = ["bookingId": job.id]
        if let token = job.offerToken { body["token"] = token }
        await mutate("/api/booking/accept-dispatch", body: body)
    }

    func decline(_ job: EaserJob) async {
        var body: [String: Any] = ["bookingId": job.id]
        if let token = job.offerToken { body["token"] = token }
        await mutate("/api/booking/decline-dispatch", body: body)
    }

    func advance(_ job: EaserJob) async {
        let next: String
        switch job.status {
        case "confirmed": await accept(job); return
        case "en_route": next = "arrived"
        case "arrived": next = "in_progress"
        case "in_progress": message = "Add the completion photo before submitting this job."; return
        default: return
        }
        await mutate("/api/booking/easer-status", body: ["bookingId": job.id, "stage": next])
    }

    func setAvailability(_ value: Bool) async {
        guard let session else { return }
        isLoading = true; defer { isLoading = false }
        do {
            var components = URLComponents(url: supabase.appending(path: "/rest/v1/profiles"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "id", value: "eq." + session.userID)]
            var request = URLRequest(url: components.url!)
            request.httpMethod = "PATCH"
            request.setValue(publicKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer " + session.accessToken, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("return=representation", forHTTPHeaderField: "Prefer")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["is_available": value])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else { throw errorFrom(data, defaultMessage: "Availability could not be updated.") }
            available = value
        } catch { message = userMessage(error) }
    }

    func signOut() { session = nil; jobs = []; earnings = nil; notices = []; available = false; message = nil }

    private func mutate(_ path: String, body: [String: Any]) async {
        isLoading = true; defer { isLoading = false }
        do {
            _ = try await request(path, method: "POST", body: body) as Data
            await refresh()
        } catch { message = userMessage(error) }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data: Data = try await request(path, method: "GET", body: nil)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func request(_ path: String, method: String, body: [String: Any]?) async throws -> Data {
        guard let session else { throw NSError(domain: "Easer", code: 401, userInfo: [NSLocalizedDescriptionKey: "Sign in is required."]) }
        var request = URLRequest(url: site.appending(path: path))
        request.httpMethod = method
        request.setValue("Bearer " + session.accessToken, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else { throw errorFrom(data, defaultMessage: "That update could not be completed. Refresh and try again.") }
        return data
    }

    private func errorFrom(_ data: Data, defaultMessage: String) -> Error {
        let problem = try? JSONDecoder().decode(APIProblem.self, from: data)
        return NSError(domain: "Easer", code: 1, userInfo: [NSLocalizedDescriptionKey: problem?.error ?? defaultMessage])
    }
    private func userMessage(_ error: Error) -> String { (error as NSError).localizedDescription }
    private func persistSession() {
        if let session, let data = try? JSONEncoder().encode(session) { UserDefaults.standard.set(data, forKey: sessionKey) }
        else { UserDefaults.standard.removeObject(forKey: sessionKey) }
    }
}

private struct EaserAppRoot: View {
    @StateObject private var store = EaserStore()
    var body: some View {
        Group {
            if store.session == nil { SignInView() }
            else { MainTabsView().task { await store.refresh() } }
        }
        .environmentObject(store)
        .tint(AppPalette.sky)
        .alert("AssembleAtEase", isPresented: Binding(get: { store.message != nil }, set: { if !$0 { store.message = nil } })) { Button("OK", role: .cancel) { store.message = nil } } message: { Text(store.message ?? "") }
    }
}

private struct SignInView: View {
    @EnvironmentObject private var store: EaserStore
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "wrench.and.screwdriver.fill").font(.system(size: 42)).foregroundStyle(AppPalette.sky)
            Text("Easer").font(.system(size: 34, weight: .bold)).foregroundStyle(AppPalette.ink)
            Text("Your jobs, earnings, and work updates.").foregroundStyle(.secondary).multilineTextAlignment(.center)
            VStack(spacing: 12) {
                TextField("Email", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress).textContentType(.username).padding().background(AppPalette.soft, in: RoundedRectangle(cornerRadius: 14))
                SecureField("Password", text: $password).textContentType(.password).padding().background(AppPalette.soft, in: RoundedRectangle(cornerRadius: 14))
            }
            Button { Task { await store.signIn(email: email, password: password) } } label: { if store.isLoading { ProgressView().tint(.white) } else { Text("Sign in") } }
                .buttonStyle(PrimaryButtonStyle()).disabled(store.isLoading)
            Text("Easer accounts only").font(.footnote).foregroundStyle(.secondary)
            Spacer()
        }.padding(28).background(Color.white.ignoresSafeArea())
    }
}

private struct MainTabsView: View {
    @EnvironmentObject private var store: EaserStore
    var body: some View {
        TabView {
            TodayView().tabItem { Label("Today", systemImage: "sun.max.fill") }
            JobsView().tabItem { Label("Jobs", systemImage: "briefcase.fill") }
            EarningsView().tabItem { Label("Earnings", systemImage: "dollarsign.circle.fill") }
            InboxView().tabItem { Label("Inbox", systemImage: "bubble.left.and.bubble.right.fill") }.badge(store.notices.filter { !($0.read ?? false) }.count)
            AccountView().tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
    }
}

private struct TodayView: View {
    @EnvironmentObject private var store: EaserStore
    @State private var selected: EaserJob?
    private var active: EaserJob? { store.jobs.first(where: { $0.isActive }) }
    private var offer: EaserJob? { store.jobs.first(where: { $0.isOffer }) }
    private var upcoming: EaserJob? { store.jobs.first(where: { !$0.isOffer && !$0.isActive && $0.status != "completed" }) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack { VStack(alignment: .leading) { Text("Today").font(.largeTitle.bold()); Text(store.available ? "You’re available for work" : "You’re paused").foregroundStyle(.secondary) }; Spacer(); Toggle("Availability", isOn: Binding(get: { store.available }, set: { value in Task { await store.setAvailability(value) } })).labelsHidden() }
                    if let active { JobPriorityCard(job: active, title: "Active job", action: active.nextAction) { selected = active } }
                    else if let offer { JobPriorityCard(job: offer, title: "New offer", action: "Review offer") { selected = offer } }
                    else { EmptyTodayCard() }
                    if let upcoming { Text("Up next").font(.headline); JobRow(job: upcoming) { selected = upcoming } }
                }.padding()
            }.navigationDestination(item: $selected) { JobDetailView(job: $0) }.refreshable { await store.refresh() }
        }
    }
}

private struct JobsView: View {
    @EnvironmentObject private var store: EaserStore
    @State private var selected: EaserJob?
    var body: some View { NavigationStack { List { Section("Offers") { ForEach(store.jobs.filter { $0.isOffer }) { JobRow(job: $0) { selected = $0 } } }; Section("Scheduled") { ForEach(store.jobs.filter { !$0.isOffer && $0.status != "completed" }) { JobRow(job: $0) { selected = $0 } } }; Section("Completed") { ForEach(store.jobs.filter { $0.status == "completed" }) { JobRow(job: $0) { selected = $0 } } } }.navigationTitle("Jobs").navigationDestination(item: $selected) { JobDetailView(job: $0) }.refreshable { await store.refresh() } } }
}

private struct EarningsView: View {
    @EnvironmentObject private var store: EaserStore
    var body: some View { NavigationStack { List { Section { HStack { MoneyStat(title: "Pending", cents: store.earnings?.summary.pendingCents); Spacer(); MoneyStat(title: "Paid", cents: store.earnings?.summary.paidCents) } } ; Section("History") { ForEach(store.earnings?.earnings ?? []) { item in HStack { VStack(alignment: .leading) { Text(item.service ?? "Completed job"); Text(item.payoutStatus?.replacingOccurrences(of: "_", with: " ").capitalized ?? "Processing").font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(cents(item.amountCents)).fontWeight(.semibold) } } } }.navigationTitle("Earnings").refreshable { await store.refresh() } } }
}

private struct InboxView: View {
    @EnvironmentObject private var store: EaserStore
    var body: some View { NavigationStack { List(store.notices) { notice in VStack(alignment: .leading, spacing: 4) { Text(notice.title).fontWeight(notice.read == true ? .regular : .bold); Text(notice.detail).font(.subheadline).foregroundStyle(.secondary) } }.overlay { if store.notices.isEmpty { ContentUnavailableView("No updates", systemImage: "bubble.left", description: Text("Job updates will appear here.")) } }.navigationTitle("Inbox").refreshable { await store.refresh() } } }
}

private struct AccountView: View {
    @EnvironmentObject private var store: EaserStore
    var body: some View { NavigationStack { List { Section("Work") { Toggle("Available for work", isOn: Binding(get: { store.available }, set: { value in Task { await store.setAvailability(value) } })) ; Label("Service areas", systemImage: "mappin.and.ellipse"); Label("Skills and tools", systemImage: "wrench.adjustable") }; Section("Support") { Link(destination: URL(string: "tel:+19792325139")!) { Label("Call AssembleAtEase", systemImage: "phone") }; Link(destination: URL(string: "mailto:service@assembleatease.com")!) { Label("Email support", systemImage: "envelope") } }; Section { Button("Sign out", role: .destructive) { store.signOut() } } }.navigationTitle("Account") } }
}

private struct JobDetailView: View {
    @EnvironmentObject private var store: EaserStore
    let job: EaserJob
    var body: some View { ScrollView { VStack(alignment: .leading, spacing: 20) { Text(job.service ?? "Service job").font(.title.bold()); HStack { Text(job.money).font(.title2.bold()).foregroundStyle(AppPalette.sky); Spacer(); Text(job.displayDate).font(.subheadline).foregroundStyle(.secondary) }; GroupBox("Location") { Label(job.shortLocation, systemImage: "mappin.and.ellipse").frame(maxWidth: .infinity, alignment: .leading) }; if let details = job.details, !details.isEmpty { GroupBox("Job details") { Text(details).frame(maxWidth: .infinity, alignment: .leading) } }; if let items = job.bookingItems, !items.isEmpty { GroupBox("Items") { VStack(alignment: .leading) { ForEach(Array(items.enumerated()), id: \.offset) { _, item in Text("• " + (item.name ?? "Item")) } }.frame(maxWidth: .infinity, alignment: .leading) } }; if job.isOffer { HStack { if job.canDecline == true { Button("Decline", role: .destructive) { Task { await store.decline(job) } }.buttonStyle(.bordered) }; Button("Accept job") { Task { await store.accept(job) } }.buttonStyle(PrimaryButtonStyle()) } } else if job.status != "completed" { Button(job.nextAction) { Task { await store.advance(job) } }.buttonStyle(PrimaryButtonStyle()) }; if job.status == "in_progress" { Text("A completion photo is required before you submit this job.").font(.footnote).foregroundStyle(.secondary) } } }.padding() }.navigationTitle("Job").navigationBarTitleDisplayMode(.inline) }
}

private struct JobPriorityCard: View { let job: EaserJob; let title: String; let action: String; let tap: () -> Void; var body: some View { Button(action: tap) { VStack(alignment: .leading, spacing: 12) { Text(title.uppercased()).font(.caption.bold()).foregroundStyle(AppPalette.sky); HStack(alignment: .top) { VStack(alignment: .leading, spacing: 4) { Text(job.service ?? "Service job").font(.headline).foregroundStyle(AppPalette.ink); Text(job.shortLocation).font(.subheadline).foregroundStyle(.secondary); Text(job.displayDate).font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(job.money).font(.headline).foregroundStyle(AppPalette.ink) }; Text(action).fontWeight(.semibold).foregroundStyle(AppPalette.ink) }.padding() }.buttonStyle(.plain).background(AppPalette.soft, in: RoundedRectangle(cornerRadius: 18)) }
}
private struct JobRow: View { let job: EaserJob; let tap: () -> Void; var body: some View { Button(action: tap) { HStack { Image(systemName: job.isOffer ? "bell.badge.fill" : "briefcase.fill").foregroundStyle(AppPalette.sky); VStack(alignment: .leading) { Text(job.service ?? "Service job").foregroundStyle(AppPalette.ink); Text(job.shortLocation + (job.displayDate.isEmpty ? "" : " · " + job.displayDate)).font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(job.money).foregroundStyle(AppPalette.ink).fontWeight(.semibold) } }.buttonStyle(.plain) } }
private struct EmptyTodayCard: View { var body: some View { VStack(alignment: .leading, spacing: 8) { Image(systemName: "checkmark.circle.fill").font(.title).foregroundStyle(AppPalette.sky); Text("You’re ready for work").font(.headline); Text("New matching work will appear here. Keep availability on when you want offers.").font(.subheadline).foregroundStyle(.secondary) }.padding().frame(maxWidth: .infinity, alignment: .leading).background(AppPalette.soft, in: RoundedRectangle(cornerRadius: 18)) } }
private struct MoneyStat: View { let title: String; let cents: Int?; var body: some View { VStack(alignment: .leading) { Text(title).font(.caption).foregroundStyle(.secondary); Text(cents(cents)).font(.title3.bold()) } } }
private struct PrimaryButtonStyle: ButtonStyle { func makeBody(configuration: Configuration) -> some View { configuration.label.frame(maxWidth: .infinity).padding(.vertical, 14).background(AppPalette.sky.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(AppPalette.ink).fontWeight(.bold) } }
private func cents(_ value: Int?) -> String { "$" + String(format: "%.2f", Double(value ?? 0) / 100) }
