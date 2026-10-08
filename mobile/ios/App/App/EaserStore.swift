import Foundation
import SwiftUI
import UIKit
import UserNotifications

/// Bridges the app delegate (push token, notification taps) to the screens.
@MainActor
final class PushRelay: ObservableObject {
    static let shared = PushRelay()
    @Published var fcmToken: String?
    @Published var openJobID: String?

    func jobID(from userInfo: [AnyHashable: Any]) -> String? {
        if let id = userInfo["jobId"] as? String, !id.isEmpty { return id }
        if let id = userInfo["bookingId"] as? String, !id.isEmpty { return id }
        if let url = userInfo["url"] as? String,
           let parts = URLComponents(string: url),
           let id = parts.queryItems?.first(where: { $0.name == "job" })?.value, !id.isEmpty { return id }
        return nil
    }
}

struct Banner: Identifiable, Equatable {
    enum Kind { case success, problem }
    let id = UUID()
    let text: String
    let kind: Kind
}

@MainActor
final class EaserStore: ObservableObject {
    enum Phase { case launching, signedOut, signedIn }

    @Published var phase: Phase = .launching
    @Published var profile: EaserProfile?
    @Published var readiness: Readiness?
    @Published var jobs: [EaserJob] = []
    @Published var newOffersAllowed = true
    @Published var earnings: EarningsEnvelope?
    @Published var notices: [EaserNotice] = []
    @Published var loadedOnce = false
    @Published var loadProblem: String?
    @Published var banner: Banner?
    @Published var busyJobs: Set<String> = []
    @Published var availabilityBusy = false
    @Published var alertsAuthorized: Bool?

    let api = EaserAPI()
    private let location = OneTimeLocation()
    private var registeredPushToken: String?
    /// A photo already accepted by the server is never uploaded twice when only
    /// the completion call needs a retry.
    private var evidenceUploaded: Set<String> = []

    init() {
        api.onSessionEnded = { [weak self] in
            Task { @MainActor in self?.endSession(message: "Please sign in again.") }
        }
    }

    // MARK: Session

    func start() async {
        guard api.session != nil else { phase = .signedOut; return }
        phase = .signedIn
        await refresh()
        await refreshAlertStatus(registerIfAllowed: true)
    }

    func signIn(email: String, password: String) async throws {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty, !password.isEmpty else {
            throw EaserError(message: "Enter your email and password.", status: 0)
        }
        try await api.signIn(email: cleanEmail, password: password)
        let me: EaserProfile
        do {
            me = try await api.profile()
        } catch {
            api.signOut()
            throw error
        }
        guard me.role == "assembler" else {
            api.signOut()
            throw EaserError(message: "This app is for AssembleAtEase Easers. To book a service, visit assembleatease.com.", status: 403)
        }
        profile = me
        phase = .signedIn
        await refresh()
        await refreshAlertStatus(registerIfAllowed: true)
    }

    func signOut() async {
        await unregisterPush()
        endSession(message: nil)
    }

    private func endSession(message: String?) {
        api.signOut()
        profile = nil
        readiness = nil
        jobs = []
        earnings = nil
        notices = []
        loadedOnce = false
        loadProblem = nil
        evidenceUploaded = []
        registeredPushToken = nil
        phase = .signedOut
        if let message { banner = Banner(text: message, kind: .problem) }
    }

    // MARK: Loading

    /// Each part loads on its own: a slow earnings ledger never hides a job offer.
    func refresh() async {
        guard api.session != nil else { return }
        async let profileResult = capture { try await self.api.profile() }
        async let jobsResult = capture { try await self.api.get("/api/booking/my-assignments", as: AssignmentsEnvelope.self) }
        async let readinessResult = capture { try await self.api.get("/api/assembler/readiness", as: ReadinessEnvelope.self) }
        async let earningsResult = capture { try await self.api.get("/api/assembler/earnings", as: EarningsEnvelope.self) }
        async let noticesResult = capture { try await self.api.get("/api/assembler/notifications", as: NoticesEnvelope.self) }

        let (p, j, r, e, n) = await (profileResult, jobsResult, readinessResult, earningsResult, noticesResult)
        if case .success(let value) = p { profile = value }
        if case .success(let value) = j { jobs = value.bookings; newOffersAllowed = value.newOffersAllowed }
        if case .success(let value) = r { readiness = value.readiness }
        if case .success(let value) = e { earnings = value }
        if case .success(let value) = n { notices = value.notifications }

        if case .failure(let error) = j {
            loadProblem = error.localizedDescription
        } else {
            loadProblem = nil
        }
        loadedOnce = true
        if let pending = PushRelay.shared.openJobID, job(pending) == nil {
            // A tapped notification for a job this account cannot see is cleared, not left hanging.
            PushRelay.shared.openJobID = nil
        }
    }

    private func capture<T>(_ work: @escaping () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    func job(_ id: String) -> EaserJob? { jobs.first { $0.id == id } }

    var offers: [EaserJob] { jobs.filter { $0.needsAcceptance } }
    var activeJob: EaserJob? { jobs.first { $0.isActive } }
    var upcoming: [EaserJob] { jobs.filter { !$0.needsAcceptance && !$0.isActive && !$0.isFinished } }
    var past: [EaserJob] { jobs.filter { $0.isFinished } }
    var unreadCount: Int { notices.filter { !$0.read }.count }

    // MARK: Job actions (each waits for the server; nothing changes on hope)

    func accept(_ job: EaserJob) async {
        var body: [String: Any] = ["bookingId": job.id]
        if let token = job.offerToken { body["token"] = token }
        await perform(job, success: "Job accepted. It is in your schedule.") {
            _ = try await self.api.call("POST", "/api/booking/accept-dispatch", body: body)
        }
    }

    func decline(_ job: EaserJob) async {
        var body: [String: Any] = ["bookingId": job.id, "reason": NSNull()]
        if let token = job.offerToken { body["token"] = token }
        await perform(job, success: "Offer declined.") {
            _ = try await self.api.call("POST", "/api/booking/decline-dispatch", body: body)
        }
    }

    func startTravel(_ job: EaserJob) async {
        await perform(job, success: "The customer has been told you are on the way.") {
            _ = try await self.api.call("POST", "/api/booking/easer-status", body: ["bookingId": job.id, "stage": "en_route"])
        }
    }

    /// Location is asked for here, at the moment it is useful, and only once.
    func arrived(_ job: EaserJob) async {
        busyJobs.insert(job.id)
        var body: [String: Any] = ["bookingId": job.id, "stage": "arrived"]
        if let here = await location.current() {
            body["lat"] = here.coordinate.latitude
            body["lng"] = here.coordinate.longitude
            body["accuracy"] = here.horizontalAccuracy
        }
        await perform(job, success: "Checked in.") {
            _ = try await self.api.call("POST", "/api/booking/easer-status", body: body)
        }
    }

    func startJob(_ job: EaserJob) async {
        await perform(job, success: "Job started.") {
            _ = try await self.api.call("POST", "/api/booking/easer-status", body: ["bookingId": job.id, "stage": "in_progress"])
        }
    }

    /// Photo first, then completion. Returns true only when the server confirms completion.
    func complete(_ job: EaserJob, photo: UIImage) async -> Bool {
        busyJobs.insert(job.id)
        defer { busyJobs.remove(job.id) }
        do {
            if !evidenceUploaded.contains(job.id) {
                guard let jpeg = PhotoPrep.jpeg(from: photo) else {
                    banner = Banner(text: "That photo could not be prepared. Take a new one and try again.", kind: .problem)
                    return false
                }
                try await api.call("POST", "/api/booking/upload-evidence", body: [
                    "bookingId": job.id,
                    "fileBase64": jpeg.base64EncodedString(),
                    "mimeType": "image/jpeg",
                    "evidenceType": "completion_photo",
                ])
                evidenceUploaded.insert(job.id)
            }
            try await api.call("POST", "/api/booking/assembler-complete", body: ["bookingId": job.id])
            evidenceUploaded.remove(job.id)
            banner = Banner(text: "Job complete. Nice work.", kind: .success)
            await refresh()
            return true
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            await refresh()
            return false
        }
    }

    private func perform(_ job: EaserJob, success: String, _ work: @escaping () async throws -> Void) async {
        busyJobs.insert(job.id)
        defer { busyJobs.remove(job.id) }
        do {
            try await work()
            banner = Banner(text: success, kind: .success)
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
        await refresh()
    }

    // MARK: Availability

    /// Same checks as the web dashboard before going online: closure, suspension, readiness.
    func setAvailable(_ on: Bool) async {
        guard let me = profile, me.isAvailable != on else { return }
        if on {
            if me.closureHeld {
                banner = Banner(text: "Your account closure request is open, so you cannot go online.", kind: .problem)
                return
            }
            if let ready = readiness {
                if ready.suspended {
                    banner = Banner(text: "Your account is paused. Contact \(Site.supportEmail) to reactivate it.", kind: .problem)
                    return
                }
                if !ready.isReady {
                    let missing = ready.missingItems.joined(separator: ", ")
                    banner = Banner(text: missing.isEmpty ? "Finish your setup before going online." : "Still needed before going online: \(missing)", kind: .problem)
                    return
                }
            }
        }
        availabilityBusy = true
        defer { availabilityBusy = false }
        do {
            try await api.setAvailable(on)
            profile = try await api.profile()
            if on { await requestAlertsIfNeeded() }
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
    }

    // MARK: Inbox and messages

    func markRead(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        do {
            try await api.call("POST", "/api/assembler/notifications", body: ["ids": ids])
            if let fresh = try? await api.get("/api/assembler/notifications", as: NoticesEnvelope.self) {
                notices = fresh.notifications
            }
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
    }

    func messages(for job: EaserJob) async throws -> [JobMessage] {
        try await api.get("/api/booking/message?bookingId=" + EaserAPI.query(job.id), as: MessagesEnvelope.self).messages
    }

    func send(_ text: String, about job: EaserJob, toCustomer: Bool) async throws {
        var body: [String: Any] = ["bookingId": job.id, "body": text, "sender": "assembler"]
        if toCustomer { body["target"] = "customer" }
        try await api.call("POST", "/api/booking/message", body: body)
    }

    // MARK: Account

    func requestClosure(reason: String) async -> Bool {
        do {
            try await api.call("POST", "/api/assembler/request-account-closure", body: ["reason": reason])
            banner = Banner(text: "Your closure request was received. You are offline and AssembleAtEase will confirm by email.", kind: .success)
            await refresh()
            return true
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }

    // MARK: Job alerts

    func refreshAlertStatus(registerIfAllowed: Bool) async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        alertsAuthorized = settings.authorizationStatus == .notDetermined ? nil : allowed
        if allowed && registerIfAllowed { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// Asked when an Easer goes online, the moment job alerts start to matter.
    func requestAlertsIfNeeded() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .notDetermined else {
            await refreshAlertStatus(registerIfAllowed: true)
            return
        }
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        alertsAuthorized = granted
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// Called whenever Firebase hands over a token. Registered only for a signed-in Easer.
    func pushTokenChanged(_ token: String?) async {
        guard let token, phase == .signedIn, profile?.role == "assembler", token != registeredPushToken else { return }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        do {
            try await api.call("POST", "/api/assembler/native-push-register", body: ["token": token, "platform": "ios", "appVersion": version])
            registeredPushToken = token
        } catch {
            // Retried the next time the app opens or the token changes.
        }
    }

    /// Before the session ends, so this phone stops receiving this Easer's jobs.
    private func unregisterPush() async {
        guard let token = registeredPushToken ?? PushRelay.shared.fcmToken, api.session != nil else { return }
        try? await api.call("DELETE", "/api/assembler/native-push-register", body: ["token": token])
    }
}
