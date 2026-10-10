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
    /// Bumped when a job alert arrives while the app is open, so the screens reload.
    @Published var arrivals = 0

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
    /// Every step other than going online is done. Offline alone is not "setup":
    /// the server counts being offline as not ready, so isReady cannot decide this.
    var setupComplete: Bool? {
        guard let r = readiness else { return nil }
        if let done = r.requirementsReady { return done }
        return r.missingItems.allSatisfy { $0 == "Availability enabled" }
    }

    /// A step other than going online still blocks job offers.
    var needsSetup: Bool { jobsLocked || setupComplete == false }

    /// The server's remaining setup items, without going online.
    var setupItems: [String] { (readiness?.missingItems ?? []).filter { $0 != "Availability enabled" } }

    /// Counts closings of the in-app browser, so a screen that sent the Easer to
    /// Stripe can ask the server for the result the moment they come back.
    @Published var browserCloses = 0
    enum Phase { case launching, signedOut, signedIn }

    @Published var phase: Phase = .launching
    @Published var profile: EaserProfile?
    @Published var readiness: Readiness?
    @Published var jobs: [EaserJob] = []
    @Published var newOffersAllowed = true
    @Published var offersPausedCode: String?
    /// The server refuses the job list until the account is approved: a status, not an error.
    @Published var jobsLocked = false
    @Published var setup: SetupStatus?
    @Published var offersPausedReason: String?
    /// Set from the scene: the app refreshes on its own only while it is on screen.
    var appActive = true
    @Published var earnings: EarningsEnvelope?
    @Published var notices: [EaserNotice] = []
    @Published var loadedOnce = false
    @Published var loadProblem: String?
    @Published var banner: Banner?
    @Published var busyJobs: Set<String> = []
    @Published var availabilityBusy = false
    @Published var alertsAuthorized: Bool?
    @Published var textAlerts: TextAlerts?
    @Published var reviews: [EaserReview] = []
    @Published var connect: ConnectStatus?
    @Published var payoutsProblem: String?
    @Published var instantQuote: InstantQuote?
    @Published var payoutPreference = ""

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
    private enum LoadedPart {
        case profile(Result<EaserProfile, Error>)
        case jobs(Result<AssignmentsEnvelope, Error>)
        case readiness(Result<ReadinessEnvelope, Error>)
        case earnings(Result<EarningsEnvelope, Error>)
        case notices(Result<NoticesEnvelope, Error>)
    }

    /// Each part is shown the moment it arrives: a slow earnings ledger never
    /// holds back a job offer, and the first screen paints as fast as its jobs.
    func refresh() async {
        guard api.session != nil else { return }
        await withTaskGroup(of: LoadedPart.self) { group in
            group.addTask {
                let result = await self.capture { try await self.api.get("/api/booking/my-assignments", as: AssignmentsEnvelope.self) }
                return .jobs(result)
            }
            group.addTask {
                let result = await self.capture { try await self.api.profile() }
                return .profile(result)
            }
            group.addTask {
                let result = await self.capture { try await self.api.get("/api/assembler/readiness", as: ReadinessEnvelope.self) }
                return .readiness(result)
            }
            group.addTask {
                let result = await self.capture { try await self.api.get("/api/assembler/notifications", as: NoticesEnvelope.self) }
                return .notices(result)
            }
            group.addTask {
                let result = await self.capture { try await self.api.get("/api/assembler/earnings", as: EarningsEnvelope.self) }
                return .earnings(result)
            }
            for await part in group {
                switch part {
                case .jobs(let result):
                    switch result {
                    case .success(let value):
                        apply(value)
                        loadProblem = nil
                        jobsLocked = false
                    case .failure(let error):
                        if (error as? EaserError)?.status == 403 {
                            jobsLocked = true
                            jobs = []
                            loadProblem = nil
                        } else {
                            loadProblem = error.localizedDescription
                        }
                    }
                    loadedOnce = true
                case .profile(let result):
                    if case .success(let value) = result { profile = value }
                case .readiness(let result):
                    if case .success(let value) = result { readiness = value.readiness }
                case .notices(let result):
                    if case .success(let value) = result { notices = value.notifications }
                case .earnings(let result):
                    if case .success(let value) = result { earnings = value }
                }
            }
        }
        loadedOnce = true
        // Setup steps are only asked for while something is unfinished; an approved
        // Easer never calls the onboarding endpoint.
        if needsSetup {
            setup = try? await api.get("/api/assembler/verification-link", as: SetupStatus.self)
        } else {
            setup = nil
        }
        // Retried here because on relaunch the token can arrive before the profile.
        await pushTokenChanged(PushRelay.shared.fcmToken)
    }

    private func apply(_ value: AssignmentsEnvelope) {
        jobs = value.bookings
        newOffersAllowed = value.newOffersAllowed
        offersPausedCode = value.pausedCode
        offersPausedReason = value.pausedReason
    }

    /// The light, frequent reload: jobs only. Offers expire, so the open app keeps current.
    func refreshJobs() async {
        guard api.session != nil, phase == .signedIn else { return }
        if let value = try? await api.get("/api/booking/my-assignments", as: AssignmentsEnvelope.self) {
            apply(value)
            loadProblem = nil
        }
    }

    func earning(for job: EaserJob) -> Earning? {
        earnings?.earnings.first { $0.bookingID == job.id }
    }

    /// Before completion: the server's estimate. After: the recorded earning, never a guess.
    func payText(for job: EaserJob) -> String {
        guard job.isFinished else { return job.payText }
        if let earned = earning(for: job) { return Format.money(cents: earned.amountCents) }
        guard earnings != nil else { return "\u{2014}" }
        return ["cancelled", "declined", "refunded"].contains(job.status) ? "No payout" : "Processing"
    }

    private func capture<T>(_ work: @escaping () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    func job(_ id: String) -> EaserJob? { jobs.first { $0.id == id } }

    var offers: [EaserJob] { jobs.filter { $0.needsAcceptance }.sorted { $0.startSortKey < $1.startSortKey } }
    var activeJob: EaserJob? { jobs.first { $0.isActive } }
    var upcoming: [EaserJob] {
        jobs.filter { !$0.needsAcceptance && !$0.isActive && !$0.isFinished }.sorted { $0.startSortKey < $1.startSortKey }
    }
    var past: [EaserJob] { jobs.filter { $0.isFinished } }
    var unreadCount: Int { notices.filter { !$0.read }.count }

    // MARK: Job actions (each waits for the server; nothing changes on hope)

    func accept(_ job: EaserJob) async {
        var body: [String: Any] = ["bookingId": job.id]
        if let token = job.acceptToken { body["token"] = token }
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
                banner = Banner(text: "Your account closure request is open.", kind: .problem)
                return
            }
            if let ready = readiness {
                if ready.suspended {
                    banner = Banner(text: "Your account is paused. Contact \(Site.supportEmail) to reactivate it.", kind: .problem)
                    return
                }
                // Being offline is what this switch fixes, so only the other steps block it.
                if needsSetup {
                    let missing = setupItems.joined(separator: ", ")
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

    // MARK: Profile photo

    /// Customers see this photo on their booking, so it is saved only when the server confirms.
    func updateProfilePhoto(_ image: UIImage) async -> Bool {
        guard let dataURL = ProfilePhotoPrep.dataURL(from: image) else {
            banner = Banner(text: "That photo could not be prepared. Try a different photo.", kind: .problem)
            return false
        }
        do {
            try await api.setProfilePhoto(dataURL)
            profile = try await api.profile()
            banner = Banner(text: "Profile photo saved.", kind: .success)
            return true
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }

    // MARK: Releasing a job, extra photos, damage

    /// The reliability cost of releasing, calculated by the server before anything changes.
    func releaseImpact(_ job: EaserJob) async throws -> ReleaseImpact? {
        let data = try await api.call("POST", "/api/booking/drop-job", body: ["bookingId": job.id, "preview": true])
        return try? JSONDecoder().decode(ReleasePreviewEnvelope.self, from: data).impact
    }

    static let releaseReasons = ["Emergency", "Vehicle issue", "Running too late", "Schedule conflict", "Other"]

    func release(_ job: EaserJob, reason: String, note: String) async -> Bool {
        busyJobs.insert(job.id)
        defer { busyJobs.remove(job.id) }
        do {
            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
            var body: [String: Any] = ["bookingId": job.id, "reason": reason]
            body["note"] = trimmed.isEmpty ? NSNull() : String(trimmed.prefix(1200))
            _ = try await api.call("POST", "/api/booking/drop-job", body: body)
            banner = Banner(text: "You're off this job.", kind: .success)
            await refresh()
            return true
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }

    func customerPhotos(for job: EaserJob) async -> [CustomerPhoto] {
        (try? await api.get("/api/booking/customer-photos?bookingId=" + EaserAPI.query(job.id), as: CustomerPhotosEnvelope.self).photos) ?? []
    }

    /// A photo AssembleAtEase asked for, or a damage report. Damage needs a description.
    func sendPhoto(_ image: UIImage, for job: EaserJob, damageNote: String?) async -> Bool {
        guard let jpeg = PhotoPrep.jpeg(from: image) else {
            banner = Banner(text: "That photo could not be prepared. Take a new one and try again.", kind: .problem)
            return false
        }
        var body: [String: Any] = [
            "bookingId": job.id,
            "fileBase64": jpeg.base64EncodedString(),
            "mimeType": "image/jpeg",
            "evidenceType": damageNote == nil ? "completion_photo" : "damage_claim",
        ]
        if let damageNote { body["notes"] = damageNote }
        do {
            _ = try await api.call("POST", "/api/booking/upload-evidence", body: body)
            banner = Banner(text: damageNote == nil ? "Photo sent to AssembleAtEase." : "Damage report sent. AssembleAtEase will follow up.", kind: .success)
            await refresh()
            return true
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }

    // MARK: Profile and account

    var email: String? { api.session?.email }

    /// Text alerts and reviews, loaded when the Easer opens their profile.
    func loadProfileExtras() async {
        async let texts = capture { try await self.api.get("/api/assembler/sms-preference", as: TextAlerts.self) }
        async let mine = capture { try await self.api.get("/api/assembler/reviews", as: ReviewsEnvelope.self) }
        let (t, r) = await (texts, mine)
        if case .success(let value) = t { textAlerts = value }
        if case .success(let value) = r { reviews = value.reviews }
    }

    /// Text consent is recorded by the server when the Easer asks for it (TCPA).
    func setTextAlerts(_ on: Bool) async {
        do {
            let data = try await api.call("POST", "/api/assembler/sms-preference", body: ["enabled": on])
            textAlerts = try? JSONDecoder().decode(TextAlerts.self, from: data)
            banner = Banner(text: on ? "Job texts are on." : "Job texts are off.", kind: .success)
            // Job texts are a setup step; the setup card updates from the server.
            await refresh()
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
    }

    /// Saves only what changed. The server decides which fields may change.
    func saveDetails(fullName: String, phone: String, city: String, state: String, zip: String) async -> Bool {
        guard let me = profile else { return false }
        var updates: [String: Any] = [:]
        func clean(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
        if clean(phone) != (me.phone ?? "") { updates["phone"] = clean(phone) }
        if !me.identityVerified {
            if clean(fullName) != (me.fullName ?? "") { updates["full_name"] = clean(fullName) }
            if clean(city) != (me.city ?? "") { updates["city"] = clean(city) }
            if clean(state) != (me.state ?? "") { updates["state"] = clean(state) }
            if clean(zip) != (me.zip ?? "") { updates["zip"] = clean(zip) }
        }
        guard !updates.isEmpty else { return true }
        do {
            try await api.updateDetails(updates)
            profile = try await api.profile()
            banner = Banner(text: "Profile saved.", kind: .success)
            return true
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            return false
        }
    }

    func sendPasswordReset() async {
        guard let email else {
            banner = Banner(text: "Use Forgot password on the sign-in screen.", kind: .problem)
            return
        }
        do {
            try await api.sendPasswordReset(to: email)
            banner = Banner(text: "Check \(email) for a link to set a new password.", kind: .success)
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
    }

    // MARK: Onboarding: agreement, identity, approval

    /// Records the signed agreement and Code of Conduct exactly as the website does
    /// (verification-link POST with the Easer's own session). Returns Stripe's
    /// identity page when verification is still needed.
    func signAgreement(fullName: String) async -> URL? {
        do {
            let data = try await api.call("POST", "/api/assembler/verification-link", body: [
                "fullName": fullName.trimmingCharacters(in: .whitespacesAndNewlines),
                "contractorAgreementSigned": true,
                "codeOfConductAccepted": true,
            ])
            let start = try? JSONDecoder().decode(VerificationStart.self, from: data)
            banner = Banner(text: start?.verificationURL != nil
                            ? "Agreement signed. Next, verify your identity with Stripe."
                            : "Agreement signed.", kind: .success)
            await refresh()
            return start?.verificationURL
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
            return nil
        }
    }

    /// Starts Stripe identity verification once the agreement is on file.
    func identityVerificationLink() async -> URL? {
        do {
            let data = try await api.call("POST", "/api/assembler/verification-link", body: [:])
            let start = try? JSONDecoder().decode(VerificationStart.self, from: data)
            if start?.alreadyVerified == true {
                banner = Banner(text: "Your identity is already verified.", kind: .success)
                await refresh()
                return nil
            }
            if let url = start?.verificationURL { return url }
            banner = Banner(text: "Identity verification could not be started. Try again.", kind: .problem)
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
        return nil
    }

    // MARK: Payouts

    /// Bank payout setup, instant payout and the manual payout preference.
    func loadPayouts(afterStripe: Bool = false) async {
        do {
            let status = try await api.get("/api/assembler/connect-status" + (afterStripe ? "?refresh=true" : ""), as: ConnectStatus.self)
            connect = status
            payoutsProblem = nil
            if status.enabled {
                let data = try? await api.call("POST", "/api/assembler/instant-payout", body: ["action": "quote"])
                instantQuote = data.flatMap { try? JSONDecoder().decode(InstantQuote.self, from: $0) }
            } else {
                instantQuote = nil
                if let saved = try? await api.get("/api/assembler/payout-preference", as: PayoutPreference.self) {
                    payoutPreference = saved.preference
                }
            }
        } catch {
            connect = nil
            payoutsProblem = "Payout setup could not be loaded. Pull down to try again."
        }
    }

    struct PayoutMethod: Hashable { let value: String; let label: String }

    /// The website's list (assembler/payouts.html).
    static let payoutMethods: [PayoutMethod] = [
        PayoutMethod(value: "ach", label: "ACH bank transfer"),
        PayoutMethod(value: "zelle", label: "Zelle"),
        PayoutMethod(value: "paypal", label: "PayPal"),
        PayoutMethod(value: "check", label: "Check"),
    ]

    func savePayoutPreference(_ value: String) async {
        do {
            _ = try await api.call("POST", "/api/assembler/payout-preference", body: ["preference": value])
            payoutPreference = value
            banner = Banner(text: "Payout method saved.", kind: .success)
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
    }

    /// Stripe's own pages for bank details. Returns the link to open, or nil after showing why not.
    func payoutSetupLink(manage: Bool) async -> URL? {
        do {
            let data = try await api.call("POST", manage ? "/api/assembler/connect-login" : "/api/assembler/connect-link")
            if let url = try JSONDecoder().decode(LinkEnvelope.self, from: data).url { return url }
            banner = Banner(text: "Payout setup could not be opened. Try again.", kind: .problem)
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
        return nil
    }

    /// Sends the instant payout at the fee the Easer was shown; the server refuses a changed fee.
    func sendInstantPayout(_ quote: InstantQuote) async {
        do {
            let data = try await api.call("POST", "/api/assembler/instant-payout", body: ["action": "payout", "acknowledgedFeeCents": Int(quote.feeCents.rounded())])
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            banner = Banner(text: (json?["message"] as? String) ?? "Your payout is on its way.", kind: .success)
        } catch {
            banner = Banner(text: error.localizedDescription, kind: .problem)
        }
        await loadPayouts()
        await refresh()
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
            banner = Banner(text: "Closure request received. You're offline.", kind: .success)
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
