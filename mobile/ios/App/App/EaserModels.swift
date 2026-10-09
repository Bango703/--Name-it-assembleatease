import Foundation

// Field names are the server's. Every field is optional and decoded one at a
// time, so one unexpected value never empties a whole list on an Easer's phone.

struct EaserSession: Codable, Equatable {
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

struct EaserProfile: Decodable {
    let id: String
    let role: String?
    let fullName: String?
    let isAvailable: Bool
    let closureStatus: String?
    /// A data: URL or https URL, exactly as the website stores it. Customers see it on their booking.
    let profilePhoto: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? ""
        role = c.string("role")
        fullName = c.string("full_name")
        isAvailable = c.bool("is_available") ?? false
        closureStatus = c.string("account_closure_status")
        profilePhoto = c.string("profile_photo")
        phone = c.string("phone")
        city = c.string("city")
        state = c.string("state")
        zip = c.string("zip")
        tier = c.string("tier")
        rating = c.number("rating")
        reviewCount = Int(c.number("review_count") ?? 0)
        createdAt = c.string("created_at")
        identityVerified = c.bool("identity_verified") ?? false
    }

    let phone: String?
    let city: String?
    let state: String?
    let zip: String?
    let tier: String?
    let rating: Double?
    let reviewCount: Int
    let createdAt: String?
    /// Once verified, name and location are locked; the server refuses changes (owner review).
    let identityVerified: Bool

    /// Same labels as assembler/profile.html.
    var levelLabel: String {
        switch tier ?? "" {
        case "pending": return "Application Pending"
        case "starter": return "Starter Pro"
        case "professional": return "Professional"
        case "elite": return "Elite Pro"
        case "suspended": return "Suspended"
        case "": return "Easer"
        default: return tier ?? "Easer"
        }
    }

    var firstName: String {
        let first = (fullName ?? "").split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "there" : first
    }

    /// Same rule as the web Easer dashboard (assembler/index.html isClosureHeld).
    var closureHeld: Bool { ["requested", "reviewing", "completed"].contains(closureStatus ?? "") }
}

struct Readiness: Decodable {
    let isReady: Bool
    let missingItems: [String]
    let suspended: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        isReady = c.bool("isReady") ?? false
        missingItems = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("missingItems"))) ?? []
        suspended = c.bool("suspended") ?? false
    }
}

struct ReadinessEnvelope: Decodable { let readiness: Readiness }

struct JobItem: Decodable, Hashable {
    let name: String
    let quantity: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? "Item"
        quantity = max(1, Int(c.number("quantity") ?? 1))
    }
}

enum JobStep: Equatable {
    case accept, startTravel, arrived, startJob, complete, noAction
}

struct EaserJob: Decodable, Identifiable, Hashable {
    let id: String
    let ref: String?
    let service: String?
    let date: String?
    let time: String?
    let address: String?
    let details: String?
    let status: String
    let customerName: String?
    let customerPhone: String?
    let acceptedAt: String?
    let offerLocation: String?
    let offerToken: String?
    let offerExpiresAt: String?
    let canDecline: Bool
    let payEstimateCents: Double?
    let customQuote: Bool
    let crewRole: String?
    let returnVisitOpen: Bool
    let items: [JobItem]
    let evidenceRequested: Bool
    let evidenceUploaded: Bool
    let selfDropAllowed: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        ref = c.string("ref")
        service = c.string("service")
        date = c.string("date")
        time = c.string("time")
        address = c.string("address")
        details = c.string("details")
        status = c.string("status") ?? ""
        customerName = c.string("customer_name")
        customerPhone = c.string("customer_phone")
        acceptedAt = c.string("assembler_accepted_at")
        offerLocation = c.string("_offer_location")
        offerToken = c.string("_offer_token")
        offerExpiresAt = c.string("_offer_expires_at")
        canDecline = c.bool("_can_decline") ?? false
        payEstimateCents = c.number("_pay_estimate_lo")
        customQuote = c.bool("_custom_quote") ?? false
        crewRole = c.string("_crew_role")
        returnVisitOpen = c.bool("_return_visit_open") ?? false
        items = (try? c.decodeIfPresent([JobItem].self, forKey: DynamicKey("_booking_items"))) ?? []
        evidenceRequested = c.string("evidence_requested_at") != nil
        evidenceUploaded = c.bool("_evidence_uploaded") ?? false
        selfDropAllowed = c.bool("_can_self_drop") ?? true
    }

    static let finishedStatuses: Set<String> = ["completed", "cancelled", "declined", "refunded"]

    var isFinished: Bool { Self.finishedStatuses.contains(status) && !returnVisitOpen }
    var needsAcceptance: Bool { acceptedAt == nil && !isFinished }
    var isOffer: Bool { needsAcceptance && offerToken != nil }
    var isActive: Bool { ["en_route", "arrived", "in_progress"].contains(status) }
    var isHelper: Bool { crewRole == "helper" }
    /// AssembleAtEase asked for more photos and none has arrived yet.
    var photosRequested: Bool { evidenceRequested && !evidenceUploaded && acceptedAt != nil }
    /// Same rule as the web dashboard: accepted, confirmed, not started.
    var canRelease: Bool { acceptedAt != nil && status == "confirmed" && selfDropAllowed && !isHelper }

    var title: String { service ?? "Service job" }
    var when: String { [Format.day(date), time].compactMap { $0 }.joined(separator: " · ") }
    /// Before acceptance the server sends an area, not the address.
    var place: String { (acceptedAt != nil ? address : nil) ?? offerLocation ?? address ?? "Location shared after you accept" }

    var payText: String {
        if customQuote { return "Pay confirmed after quote" }
        guard let cents = payEstimateCents, cents > 0 else { return "Pay to be confirmed" }
        return Format.money(cents: cents)
    }

    /// Words a person uses, never a status code (seat 15).
    var statusLabel: String {
        if needsAcceptance { return isOffer ? "New offer" : "Waiting for you to accept" }
        switch status {
        case "en_route": return "On the way"
        case "arrived": return "Arrived"
        case "in_progress": return "In progress"
        case "completed": return returnVisitOpen ? "Return visit needed" : "Completed"
        case "cancelled", "declined", "refunded": return "Cancelled"
        default: return "Scheduled"
        }
    }

    var nextStep: JobStep {
        if isFinished { return .noAction }
        if needsAcceptance { return .accept }
        if isHelper { return .noAction }
        switch status {
        case "en_route": return .arrived
        case "arrived": return .startJob
        case "in_progress": return .complete
        case "completed": return .noAction
        default: return .startTravel
        }
    }
}

struct AssignmentsEnvelope: Decodable {
    let bookings: [EaserJob]
    let newOffersAllowed: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        bookings = (try? c.decodeIfPresent([EaserJob].self, forKey: DynamicKey("bookings"))) ?? []
        if let access = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("access")) {
            newOffersAllowed = access.bool("newOffersAllowed") ?? true
        } else {
            newOffersAllowed = true
        }
    }
}

struct Earning: Decodable, Identifiable {
    let bookingID: String
    let bookingRef: String?
    let service: String
    let earningType: String
    let earnedAt: String?
    let amountCents: Double
    let statusLabel: String
    let statusMessage: String
    let disposition: String
    var id: String { bookingID + ":" + earningType }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        bookingID = c.string("booking_id") ?? UUID().uuidString
        bookingRef = c.string("booking_ref")
        service = c.string("service") ?? "Service"
        earningType = c.string("earning_type") ?? "completed_job"
        earnedAt = c.string("earned_at")
        amountCents = c.number("amount_cents") ?? 0
        if let payout = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("payout")) {
            statusLabel = payout.string("status_label") ?? "Processing"
            statusMessage = payout.string("status_message") ?? ""
            disposition = payout.string("disposition") ?? ""
        } else {
            statusLabel = "Processing"
            statusMessage = ""
            disposition = ""
        }
    }
}

struct EarningsSummary: Decodable {
    let completedJobs: Int
    let totalEarnedCents: Double
    let paidCents: Double
    let awaitingPayoutCents: Double
    let onHoldCents: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        completedJobs = Int(c.number("completed_jobs") ?? 0)
        totalEarnedCents = c.number("total_earned_cents") ?? 0
        paidCents = c.number("paid_cents") ?? 0
        awaitingPayoutCents = c.number("awaiting_payout_cents") ?? 0
        onHoldCents = c.number("on_hold_cents") ?? 0
    }
}

struct EarningsEnvelope: Decodable {
    let earnings: [Earning]
    let summary: EarningsSummary?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        earnings = (try? c.decodeIfPresent([Earning].self, forKey: DynamicKey("earnings"))) ?? []
        summary = try? c.decodeIfPresent(EarningsSummary.self, forKey: DynamicKey("summary"))
    }
}

struct EaserNotice: Decodable, Identifiable {
    let id: String
    let title: String
    let detail: String
    let createdAt: String?
    let read: Bool
    let bookingID: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        title = c.string("title") ?? "Update"
        detail = c.string("detail") ?? ""
        createdAt = c.string("createdAt")
        read = c.bool("read") ?? false
        bookingID = c.string("bookingId")
    }
}

struct NoticesEnvelope: Decodable {
    let notifications: [EaserNotice]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        notifications = (try? c.decodeIfPresent([EaserNotice].self, forKey: DynamicKey("notifications"))) ?? []
    }
}

struct JobMessage: Decodable, Identifiable {
    let id: String
    let sender: String
    let body: String
    let createdAt: String?
    var fromMe: Bool { sender == "assembler" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        sender = c.string("sender") ?? ""
        body = c.string("body") ?? ""
        createdAt = c.string("created_at")
    }

    var senderLabel: String {
        switch sender {
        case "assembler": return "You"
        case "customer": return "Customer"
        default: return "AssembleAtEase"
        }
    }
}

struct MessagesEnvelope: Decodable {
    let messages: [JobMessage]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        messages = (try? c.decodeIfPresent([JobMessage].self, forKey: DynamicKey("messages"))) ?? []
    }
}

/// What releasing a job costs, as the server calculates it (drop-job preview).
struct ReleaseImpact: Decodable {
    let kind: String
    let strikesAdded: Int
    let strikesBefore: Int
    let windowDays: Int
    let pauseAtStrikes: Int
    let willPause: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        kind = c.string("kind") ?? ""
        strikesAdded = Int(c.number("strikesAdded") ?? 0)
        strikesBefore = Int(c.number("strikesBefore") ?? 0)
        windowDays = Int(c.number("windowDays") ?? 0)
        pauseAtStrikes = Int(c.number("pauseAtStrikes") ?? 0)
        willPause = c.bool("willPause") ?? false
    }

    /// The same sentences as the web dashboard (assembler/my-assignments.html reliabilityImpactText).
    var text: String {
        let plural = strikesAdded == 1 ? "" : "s"
        let cost: String
        switch kind {
        case "grace": cost = "You accepted this job less than 15 minutes ago, so cancelling now has no reliability strike."
        case "advance": cost = "The job is more than 24 hours away, so cancelling now has no reliability strike."
        case "same_day": cost = "The job is today. Cancelling counts as \(strikesAdded) reliability strikes."
        default: cost = "The job starts in less than 24 hours. Cancelling counts as \(strikesAdded) reliability strike\(plural)."
        }
        let before = strikesBefore == 1 ? "" : "s"
        let standing = " You have \(strikesBefore) strike\(before) in the last \(windowDays) days; at \(pauseAtStrikes), new jobs pause."
        let pause = willPause ? " This cancellation will pause new jobs until AssembleAtEase reviews your account." : ""
        return cost + standing + pause
    }
}

struct ReleasePreviewEnvelope: Decodable {
    let impact: ReleaseImpact?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        impact = try? c.decodeIfPresent(ReleaseImpact.self, forKey: DynamicKey("impact"))
    }
}

struct CustomerPhoto: Decodable, Identifiable {
    let id: String
    let url: URL?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        url = c.string("signed_url").flatMap { URL(string: $0) }
    }
}

struct CustomerPhotosEnvelope: Decodable {
    let photos: [CustomerPhoto]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        photos = (try? c.decodeIfPresent([CustomerPhoto].self, forKey: DynamicKey("photos"))) ?? []
    }
}

struct TextAlerts: Decodable {
    let enabled: Bool
    let hasPhone: Bool
    let optedOut: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        enabled = c.bool("enabled") ?? false
        hasPhone = c.bool("hasPhone") ?? false
        optedOut = c.bool("optedOut") ?? false
    }
}

struct EaserReview: Decodable, Identifiable {
    let id: String
    let rating: Int
    let comment: String
    let customerFirstName: String
    let createdAt: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        rating = max(0, min(5, Int(c.number("rating") ?? 0)))
        comment = c.string("comment") ?? ""
        customerFirstName = c.string("customerFirstName") ?? "Customer"
        createdAt = c.string("createdAt")
    }
}

struct ReviewsEnvelope: Decodable {
    let reviews: [EaserReview]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        reviews = (try? c.decodeIfPresent([EaserReview].self, forKey: DynamicKey("reviews"))) ?? []
    }
}

/// Stripe Connect payout setup, as /api/assembler/connect-status reports it.
struct ConnectStatus: Decodable {
    let enabled: Bool
    let payoutsEnabled: Bool
    let hasAccount: Bool
    let message: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        enabled = c.bool("enabled") ?? false
        payoutsEnabled = c.bool("payoutsEnabled") ?? false
        hasAccount = c.string("accountId") != nil
        if let connect = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("connect")) {
            message = connect.string("message")
        } else {
            message = nil
        }
    }
}

/// An instant payout offer, priced by the server. Shown only when Stripe says it can be sent.
struct InstantQuote: Decodable {
    let available: Bool
    let grossCents: Double
    let feePct: Double
    let feeCents: Double
    let netCents: Double
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        available = (c.bool("instantAvailable") ?? false) && (c.bool("eligible") ?? false)
        grossCents = c.number("grossCents") ?? 0
        feePct = c.number("feePct") ?? 0
        feeCents = c.number("feeCents") ?? 0
        netCents = c.number("netCents") ?? 0
    }
}

struct PayoutPreference: Decodable {
    let preference: String
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        preference = c.string("preference") ?? ""
    }
}

struct LinkEnvelope: Decodable {
    let url: URL?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        url = (c.string("onboardingUrl") ?? c.string("url")).flatMap { URL(string: $0) }
    }
}
