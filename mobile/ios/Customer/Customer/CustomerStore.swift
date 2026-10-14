import SwiftUI
import UIKit

enum CustomerPhase: Equatable { case launching, signedOut, signedIn }
enum CustomerTab: Hashable { case home, activity, account }

struct CustomerBanner: Identifiable, Equatable {
    enum Kind { case success, problem }
    let id = UUID()
    let text: String
    let kind: Kind
}

/// The customer app's state. Every answer comes from the server; the app keeps
/// the last list it had so it opens on something real, then refreshes.
@MainActor
final class CustomerStore: ObservableObject {
    @Published var phase: CustomerPhase = .launching
    @Published var tab: CustomerTab = .home
    @Published var bookings: [BookingSummary] = []
    @Published var loadedOnce = false
    @Published var loadProblem: String?
    @Published var banner: CustomerBanner?
    @Published var browserCloses = 0
    /// A booking to open on the Bookings tab (set after booking in the app).
    @Published var openRef: String?
    /// From the customer's most recent booking, for the greeting.
    @Published var firstName: String?
    @Published var offer: CurrentOffer?
    /// AssembleCash balance and the token checkout uses to apply it.
    @Published var account: AccountSummary?
    @Published var conversations: [InboxConversation] = []

    let api: CustomerAPI
    /// The order being built on Home.
    let flow: BookingFlow
    let push: CustomerPush
    private var cache: SnapshotCache?
    private var registeredPushToken: String?

    var email: String? { api.session?.email }
    var upcoming: [BookingSummary] { bookings.filter { !$0.isPast } }
    var past: [BookingSummary] { bookings.filter { $0.isPast } }
    var unreadCount: Int { conversations.reduce(0) { $0 + $1.unread } }

    init() {
        let client = CustomerAPI()
        api = client
        flow = BookingFlow(api: client)
        push = CustomerPush.shared
        api.onSessionEnded = { [weak self] in self?.endSession() }
        flow.onBooked = { [weak self] in
            guard let self else { return }
            await self.refresh()
        }
    }

    func open(ref: String) {
        tab = .activity
        openRef = ref
    }

    /// Browse a service: Home, opened on it.
    func browse(_ service: String) {
        tab = .home
        flow.path = [.service(service)]
    }

    /// The order is ready for a time: Home, on the schedule step.
    func continueBooking() {
        tab = .home
        flow.path = [.schedule]
    }

    func refreshInbox() async {
        guard phase == .signedIn, let latest = try? await api.inbox() else { return }
        conversations = latest
    }

    // MARK: Notifications

    /// This phone gets booking updates for the signed-in customer.
    func pushTokenChanged(_ token: String?) async {
        guard phase == .signedIn, let token, token != registeredPushToken else { return }
        do {
            try await api.registerPush(token: token)
            registeredPushToken = token
        } catch {
            // Not switched on yet on the server, or offline: retried on the next refresh.
        }
    }

    func start() async {
        guard let session = api.session else { phase = .signedOut; return }
        cache = SnapshotCache(userID: session.userID)
        if let data = cache?.load("bookings"), let value = try? JSONDecoder().decode(BookingsEnvelope.self, from: data) {
            bookings = value.bookings
            firstName = value.firstName
            loadedOnce = true
        }
        phase = .signedIn
        await refresh()
    }

    // MARK: Sign-in

    /// Nil once the code is on its way; otherwise the reason to show.
    func sendCode(to email: String) async -> String? {
        do {
            try await api.sendCode(to: email)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func verify(email: String, code: String) async -> String? {
        do {
            try await api.verify(email: email, code: code)
            await start()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func signOut() {
        if let token = registeredPushToken {
            let client = api
            Task { try? await client.unregisterPush(token: token) }
        }
        api.signOut()
        endSession()
    }

    func deleteAccount() async -> Bool {
        do {
            try await api.deleteAccount()
            signOut()
            banner = CustomerBanner(text: "Your account was deleted.", kind: .success)
            return true
        } catch {
            banner = CustomerBanner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }

    private func endSession() {
        cache?.clear()
        cache = nil
        bookings = []
        loadedOnce = false
        loadProblem = nil
        openRef = nil
        firstName = nil
        offer = nil
        account = nil
        conversations = []
        registeredPushToken = nil
        flow.reset()
        tab = .home
        phase = .signedOut
    }

    // MARK: Bookings

    func refresh() async {
        guard phase == .signedIn else { return }
        offer = await api.currentOffer()
        do {
            let data = try await api.getData("/api/booking/customer-bookings")
            let value = try JSONDecoder().decode(BookingsEnvelope.self, from: data)
            bookings = value.bookings
            firstName = value.firstName ?? firstName
            cache?.save(data, as: "bookings")
            loadProblem = nil
        } catch let error as AppError where error.isCancelled {
            return
        } catch {
            loadProblem = error.localizedDescription
        }
        loadedOnce = true
        if let summary = try? await api.accountSummary() {
            account = summary
            flow.assemblecashToken = summary.assemblecashToken
        }
        if let latest = try? await api.inbox() { conversations = latest }
        await push.refreshStatus()
        await pushTokenChanged(push.fcmToken)
        await LiveTracker.sync(bookings: bookings, api: api, fcmToken: push.fcmToken)
    }

    /// Runs one booking action and says how it went. The server's reason is shown as written.
    func perform(_ success: String, _ action: () async throws -> Void) async -> Bool {
        do {
            try await action()
            banner = CustomerBanner(text: success, kind: .success)
            await refresh()
            return true
        } catch {
            banner = CustomerBanner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }
}

extension CustomerStore {
    /// A visit happening now: the pro is on the way or there, or it is today.
    /// Home shows it as one line; Activity has the booking.
    var liveVisit: BookingSummary? {
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.timeZone = TimeZone(identifier: "America/Chicago")
        day.dateFormat = "yyyy-MM-dd"
        let today = day.string(from: Date())
        return upcoming.first { ($0.progress?.step ?? 0) >= 2 }
            ?? upcoming.first { String(($0.date ?? "").prefix(10)) == today }
    }

    /// Finished jobs, for Book again.
    var finishedJobs: [BookingSummary] { past.filter(\.isCompleted) }
}
