import SwiftUI
import UIKit

enum CustomerPhase: Equatable { case launching, signedOut, signedIn }
enum CustomerTab: Hashable { case bookings, book, account }

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
    @Published var tab: CustomerTab = .bookings
    @Published var bookings: [BookingSummary] = []
    @Published var loadedOnce = false
    @Published var loadProblem: String?
    @Published var banner: CustomerBanner?
    @Published var browserCloses = 0

    let api = CustomerAPI()
    private var cache: SnapshotCache?

    var email: String? { api.session?.email }
    var upcoming: [BookingSummary] { bookings.filter { !$0.isPast } }
    var past: [BookingSummary] { bookings.filter { $0.isPast } }

    init() {
        api.onSessionEnded = { [weak self] in self?.endSession() }
    }

    func start() async {
        guard let session = api.session else { phase = .signedOut; return }
        cache = SnapshotCache(userID: session.userID)
        if let data = cache?.load("bookings"), let value = try? JSONDecoder().decode(BookingsEnvelope.self, from: data) {
            bookings = value.bookings
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
        tab = .bookings
        phase = .signedOut
    }

    // MARK: Bookings

    func refresh() async {
        guard phase == .signedIn else { return }
        do {
            let data = try await api.getData("/api/booking/customer-bookings")
            let value = try JSONDecoder().decode(BookingsEnvelope.self, from: data)
            bookings = value.bookings
            cache?.save(data, as: "bookings")
            loadProblem = nil
        } catch let error as AppError where error.isCancelled {
            return
        } catch {
            loadProblem = error.localizedDescription
        }
        loadedOnce = true
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
