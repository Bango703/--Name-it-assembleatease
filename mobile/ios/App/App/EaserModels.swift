import Foundation

// Field names are the server's. Every field is optional and decoded one at a
// time, so one unexpected value never empties a whole list on an Easer's phone.

/// The Easer app's session is the shared one (mobile/ios/Shared/AppFoundation.swift).
typealias EaserSession = AppSession

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
    /// Every step other than going online is done (nil from an older server).
    let requirementsReady: Bool?
    /// The owner's note when a new profile photo was requested.
    let photoRequestNote: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        isReady = c.bool("isReady") ?? false
        requirementsReady = c.bool("requirementsReady")
        photoRequestNote = c.string("photoRequestNote")
        missingItems = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("missingItems"))) ?? []
        suspended = c.bool("suspended") ?? false
    }
}

struct ReadinessEnvelope: Decodable { let readiness: Readiness }

/// One line of the job's scope, as api/booking/_booking-items.js sends it and
/// assembler/my-assignments.html shows it: a pack ("Wall anchors (per 4 pack)")
/// counts as its pieces, and an add-on is marked as one.
struct JobItem: Decodable, Hashable {
    let name: String
    let quantity: Int
    let isAddOn: Bool
    /// The service the item was booked under, when it differs from its group.
    let detail: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        let raw = (c.string("name") ?? "").trimmingCharacters(in: .whitespaces)
        var count = max(1, Int(c.number("quantity") ?? 1))
        if let pack = raw.range(of: #"\(\s*per\s+(\d+)\s+[^)]*\)"#, options: [.regularExpression, .caseInsensitive]) {
            let digits = raw[pack].filter(\.isNumber)
            if let size = Int(digits), size > 0 { count *= size }
        }
        name = raw.replacingOccurrences(of: #"\s*\(\s*per\b[^)]*\)"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespaces)
        quantity = count
        isAddOn = c.bool("isAddOn") ?? false
        detail = c.string("subgroup")
    }
}

/// The items of one service on the job ("Furniture Assembly": desk, bookcase).
struct JobItemGroup: Decodable, Hashable {
    let label: String?
    let items: [JobItem]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        if c.contains(DynamicKey("items")) {
            label = c.string("label")
            items = ((try? c.decodeIfPresent([JobItem].self, forKey: DynamicKey("items"))) ?? []).filter { !$0.name.isEmpty }
        } else {
            // An ungrouped item from an older response.
            label = nil
            let item = try JobItem(from: decoder)
            items = item.name.isEmpty ? [] : [item]
        }
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
    /// The token accept-dispatch needs: a dispatch offer's, or, for a job the
    /// owner assigned directly, the booking's assignment token (as the website sends).
    let acceptToken: String?
    let offerExpiresAt: String?
    let canDecline: Bool
    let payEstimateCents: Double?
    let customQuote: Bool
    let crewRole: String?
    let returnVisitOpen: Bool
    let itemGroups: [JobItemGroup]
    let evidenceRequested: Bool
    let evidenceUploaded: Bool
    let selfDropAllowed: Bool
    let enRouteAt: String?
    let arrivedAt: String?
    let startedAt: String?
    let completedAt: String?
    let payEstimateHiCents: Double?
    let sameDayBonusCents: Double?
    let crewSize: Int
    /// When a step is not open yet: stage (en_route, arrived, in_progress) to the time it opens.
    let stageOpensAt: [String: String]
    /// The customer-not-home clock (api/booking/customer-unavailable.js).
    let customerUnavailable: CustomerUnavailable?
    /// Where a reschedule moved the job from.
    let previousSlot: PreviousSlot?
    /// Tips the customer gave on this job (paid to the Easer's own Stripe account).
    let tips: TipSummary?
    /// The latest time this Easer proposed for the job.
    let timeProposal: TimeProposal?
    /// Extra work requested on this job, newest last. Description and status only.
    let extraWork: [ExtraWorkRequest]
    /// Whether this Easer has rated the customer.
    let customerFeedback: CustomerFeedbackGiven?

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
        acceptToken = offerToken ?? c.string("assignment_token")
        offerExpiresAt = c.string("_offer_expires_at")
        canDecline = c.bool("_can_decline") ?? false
        payEstimateCents = c.number("_pay_estimate_lo")
        customQuote = c.bool("_custom_quote") ?? false
        crewRole = c.string("_crew_role")
        returnVisitOpen = c.bool("_return_visit_open") ?? false
        itemGroups = ((try? c.decodeIfPresent([JobItemGroup].self, forKey: DynamicKey("_booking_items"))) ?? []).filter { !$0.items.isEmpty }
        evidenceRequested = c.string("evidence_requested_at") != nil
        evidenceUploaded = c.bool("_evidence_uploaded") ?? false
        selfDropAllowed = c.bool("_can_self_drop") ?? true
        enRouteAt = c.string("en_route_at")
        arrivedAt = c.string("checked_in_at")
        startedAt = c.string("job_started_at")
        completedAt = c.string("completed_at")
        payEstimateHiCents = c.number("_pay_estimate_hi")
        sameDayBonusCents = c.number("_same_day_bonus_cents")
        crewSize = Int(c.number("_crew_size") ?? 1)
        var opens: [String: String] = [:]
        if let gates = try? c.decodeIfPresent([String: StageGate].self, forKey: DynamicKey("_stage_availability")) {
            for (stage, gate) in gates where !gate.allowed {
                if let at = gate.earliestAt { opens[stage] = at }
            }
        }
        stageOpensAt = opens
        customerUnavailable = try? c.decodeIfPresent(CustomerUnavailable.self, forKey: DynamicKey("_customer_unavailable"))
        previousSlot = try? c.decodeIfPresent(PreviousSlot.self, forKey: DynamicKey("_previous_slot"))
        tips = try? c.decodeIfPresent(TipSummary.self, forKey: DynamicKey("_tips"))
        timeProposal = try? c.decodeIfPresent(TimeProposal.self, forKey: DynamicKey("_time_proposal"))
        extraWork = (try? c.decodeIfPresent([ExtraWorkRequest].self, forKey: DynamicKey("_extra_work"))) ?? []
        customerFeedback = try? c.decodeIfPresent(CustomerFeedbackGiven.self, forKey: DynamicKey("_customer_feedback"))
    }

    /// The server's verdict on one job step (my-assignments _stage_availability).
    struct StageGate: Decodable {
        let allowed: Bool
        let earliestAt: String?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: DynamicKey.self)
            allowed = c.bool("allowed") ?? true
            earliestAt = c.string("earliestAt")
        }
    }

    /// When the next step opens, if it is not open yet.
    var nextStepOpensAt: String? {
        switch nextStep {
        case .startTravel: return stageOpensAt["en_route"]
        case .arrived: return stageOpensAt["arrived"]
        case .startJob: return stageOpensAt["in_progress"]
        default: return nil
        }
    }

    static let finishedStatuses: Set<String> = ["completed", "cancelled", "declined", "refunded"]

    var isFinished: Bool { Self.finishedStatuses.contains(status) && !returnVisitOpen }
    /// "2 Desks · +1 more": the work at a glance, add-ons left out (as on the website's job list).
    var workSummary: String? {
        let work = itemGroups.flatMap(\.items).filter { !$0.isAddOn }
        guard let first = work.first else { return nil }
        let name = first.quantity > 1 ? "\(first.quantity) \(Self.plural(first.name))" : first.name
        return work.count > 1 ? "\(name) · +\(work.count - 1) more" : name
    }

    private static func plural(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.hasSuffix("s") { return name }
        if ["x", "z", "ch", "sh"].contains(where: { lower.hasSuffix($0) }) { return name + "es" }
        if lower.hasSuffix("y"), let before = lower.dropLast().last, !"aeiou".contains(before) { return String(name.dropLast()) + "ies" }
        return name + "s"
    }

    var needsAcceptance: Bool { acceptedAt == nil && !isFinished }
    var isOffer: Bool { needsAcceptance && offerToken != nil }
    var isActive: Bool { ["en_route", "arrived", "in_progress"].contains(status) }
    var isHelper: Bool { crewRole == "helper" }

    /// Appointment order: date, then the start of the arrival window ("9:00 AM - 11:00 AM").
    var startSortKey: String {
        String((date ?? "9999-12-31").prefix(10)) + String(format: "%04d", Self.startMinutes(time))
    }

    static func startMinutes(_ raw: String?) -> Int {
        guard let raw,
              let regex = try? NSRegularExpression(pattern: "(\\d{1,2})(?::(\\d{2}))?\\s*([AaPp][Mm])"),
              let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)) else { return 0 }
        func group(_ index: Int) -> String? {
            guard let range = Range(match.range(at: index), in: raw) else { return nil }
            return String(raw[range])
        }
        var hour = Int(group(1) ?? "0") ?? 0
        let minute = Int(group(2) ?? "0") ?? 0
        let pm = (group(3) ?? "").lowercased() == "pm"
        if hour == 12 { hour = pm ? 12 : 0 } else if pm { hour += 12 }
        return hour * 60 + minute
    }
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
    /// The server's own words for why new offers are paused (my-assignments meta.warnings).
    let pausedCode: String?
    let pausedReason: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        bookings = (try? c.decodeIfPresent([EaserJob].self, forKey: DynamicKey("bookings"))) ?? []
        if let access = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("access")) {
            newOffersAllowed = access.bool("newOffersAllowed") ?? true
        } else {
            newOffersAllowed = true
        }
        var code: String?
        var reason: String?
        if let meta = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("meta")),
           var list = try? meta.nestedUnkeyedContainer(forKey: DynamicKey("warnings")) {
            while !list.isAtEnd {
                guard let item = try? list.nestedContainer(keyedBy: DynamicKey.self) else { break }
                let itemCode = item.string("code")
                if code == nil, itemCode == "current_agreement_required" || itemCode == "new_offers_paused" {
                    code = itemCode
                    reason = item.string("message")
                }
            }
        }
        pausedCode = code
        pausedReason = reason
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
    /// Tips are the Easer's own money (api/assembler/_easer-tips.js), shown beside earnings.
    let tips: TipsEnvelope?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        earnings = (try? c.decodeIfPresent([Earning].self, forKey: DynamicKey("earnings"))) ?? []
        summary = try? c.decodeIfPresent(EarningsSummary.self, forKey: DynamicKey("summary"))
        tips = try? c.decodeIfPresent(TipsEnvelope.self, forKey: DynamicKey("tips"))
    }
}

// MARK: - Job lifecycle (owner audit, 2026-10-12)

/// The customer-not-home state of a job: when it was reported and when the wait ends.
struct CustomerUnavailable: Decodable, Hashable {
    let reportedAt: String?
    let waitUntil: String?
    let canReportNoShow: Bool
    let noShowReportedAt: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        reportedAt = c.string("reportedAt")
        waitUntil = c.string("waitUntil")
        canReportNoShow = c.bool("canReportNoShow") ?? false
        noShowReportedAt = c.string("noShowReportedAt")
    }
    var waitEnds: Date? { Format.timestamp(waitUntil) }
}

struct PreviousSlot: Decodable, Hashable {
    let date: String?
    let time: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        date = c.string("date")
        time = c.string("time")
    }
}

struct TipSummary: Decodable, Hashable {
    let count: Int
    let amountCents: Double
    let feeCents: Double
    let netCents: Double
    let feePending: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        count = Int(c.number("count") ?? 0)
        amountCents = c.number("amountCents") ?? 0
        feeCents = c.number("feeCents") ?? 0
        netCents = c.number("netCents") ?? 0
        feePending = c.bool("feePending") ?? false
    }
}

struct TipItem: Decodable, Identifiable, Hashable {
    let id: String
    let ref: String?
    let service: String?
    let date: String?
    let amountCents: Double
    let netCents: Double
    let createdAt: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        ref = c.string("ref")
        service = c.string("service")
        date = c.string("date")
        amountCents = c.number("amountCents") ?? 0
        netCents = c.number("netCents") ?? 0
        createdAt = c.string("createdAt")
    }
}

struct TipsEnvelope: Decodable {
    let summary: TipSummary?
    let items: [TipItem]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        summary = try? c.decodeIfPresent(TipSummary.self, forKey: DynamicKey("summary"))
        items = (try? c.decodeIfPresent([TipItem].self, forKey: DynamicKey("items"))) ?? []
    }
}

struct TimeProposal: Decodable, Hashable {
    let id: String?
    let date: String?
    let time: String?
    let status: String
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id")
        date = c.string("date")
        time = c.string("time")
        status = c.string("status") ?? "pending"
    }
    var isPending: Bool { status == "pending" }
}

struct ExtraWorkRequest: Decodable, Hashable, Identifiable {
    let id: String
    let description: String
    let status: String
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        description = c.string("description") ?? "Extra work"
        status = c.string("status") ?? ""
    }
    /// The change-order status (api/booking/_change-orders.js) in the Easer's words.
    var statusLabel: String {
        switch status {
        case "pending_customer_approval": return "Waiting for the customer"
        case "authorized", "captured": return "Approved"
        case "declined": return "Declined"
        case "refunded": return "Refunded"
        default: return "Closed"
        }
    }
    var approved: Bool { status == "authorized" || status == "captured" }
}

struct CustomerFeedbackGiven: Decodable, Hashable {
    let rating: Int?
    let flagged: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        rating = c.number("rating").map { Int($0) }
        flagged = c.bool("flagged") ?? false
    }
}

/// The Easer's reliability standing (api/assembler/reliability.js).
struct Reliability: Decodable {
    let strikes: Int
    let windowDays: Int
    let pauseAtStrikes: Int
    let paused: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        strikes = Int(c.number("strikes") ?? 0)
        windowDays = Int(c.number("windowDays") ?? 90)
        pauseAtStrikes = Int(c.number("pauseAtStrikes") ?? 3)
        paused = c.bool("paused") ?? false
    }
}

/// One time range on one day, 24-hour "HH:MM".
struct WorkWindow: Codable, Hashable {
    var start: String
    var end: String
}

/// The services an Easer takes and the hours they work (api/assembler/work-preferences.js).
/// nil services means every service; nil availability means any time.
struct WorkPreferences: Decodable {
    let allServices: [String]
    let weekdays: [String]
    let services: [String]?
    let availability: [String: [WorkWindow]]?
    let unavailable: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        allServices = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("allServices"))) ?? []
        weekdays = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("weekdays"))) ?? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        services = try? c.decodeIfPresent([String].self, forKey: DynamicKey("services"))
        availability = try? c.decodeIfPresent([String: [WorkWindow]].self, forKey: DynamicKey("availability"))
        unavailable = c.bool("unavailable") ?? false
    }
}

/// One catalog item the Easer can add on site (api/booking/extra-work.js). No prices.
struct ExtraWorkCatalogItem: Decodable, Hashable, Identifiable {
    let name: String
    let group: String?
    let addOn: Bool
    var id: String { name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? ""
        group = c.string("group")
        addOn = c.bool("addOn") ?? false
    }
}

struct ExtraWorkService: Decodable, Hashable, Identifiable {
    let name: String
    let items: [ExtraWorkCatalogItem]
    var id: String { name }
    init(name: String, items: [ExtraWorkCatalogItem]) {
        self.name = name
        self.items = items
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? ""
        items = (try? c.decodeIfPresent([ExtraWorkCatalogItem].self, forKey: DynamicKey("items"))) ?? []
    }
}

struct ExtraWorkOptions: Decodable {
    let canAdd: Bool
    let reason: String?
    let services: [ExtraWorkService]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        canAdd = c.bool("canAdd") ?? false
        reason = c.string("reason")
        services = (try? c.decodeIfPresent([ExtraWorkService].self, forKey: DynamicKey("services"))) ?? []
    }
}

struct TimeProposalOptions: Decodable {
    let slots: [String]
    let windowDays: Int
    let canPropose: Bool
    let reason: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        slots = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("slots"))) ?? []
        windowDays = Int(c.number("windowDays") ?? 30)
        canPropose = c.bool("canPropose") ?? false
        reason = c.string("reason")
    }
}

struct EaserNotice: Decodable, Identifiable {
    let id: String
    let title: String
    let detail: String
    let createdAt: String?
    var read: Bool
    let bookingID: String?
    /// Where its button goes: job, job_customer_messages, job_team_messages,
    /// payouts, account, personal_info, today or none (api/assembler/notifications.js).
    let action: String?
    /// The button's words, or nil when there is nothing to open.
    let actionLabel: String?
    /// jobs, money or account.
    let category: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        action = c.string("action")
        actionLabel = c.string("actionLabel")
        category = c.string("category") ?? "account"
        id = c.string("id") ?? UUID().uuidString
        title = c.string("title") ?? "Update"
        detail = c.string("detail") ?? ""
        createdAt = c.string("createdAt")
        read = c.bool("read") ?? false
        bookingID = c.string("bookingId")
    }
}

/// Something the platform needs from the Easer (payout setup, a policy to
/// acknowledge), from /api/assembler/required-actions.
struct RequiredAction: Decodable, Identifiable {
    let key: String
    let rule: String?
    let title: String
    let body: String
    let actionLabel: String?
    let actionURL: String?
    let ackRequired: Bool
    var id: String { key }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        key = c.string("key") ?? UUID().uuidString
        rule = c.string("rule")
        title = c.string("title") ?? "Action needed"
        body = c.string("body") ?? ""
        actionLabel = c.string("actionLabel")
        actionURL = c.string("actionUrl")
        ackRequired = c.bool("ackRequired") ?? false
    }
}

struct RequiredActionsEnvelope: Decodable {
    let actions: [RequiredAction]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        actions = (try? c.decodeIfPresent([RequiredAction].self, forKey: DynamicKey("actions"))) ?? []
    }
}

struct NoticesEnvelope: Decodable {
    let notifications: [EaserNotice]
    /// Where the next older page starts; nil at the oldest.
    let nextBefore: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        notifications = (try? c.decodeIfPresent([EaserNotice].self, forKey: DynamicKey("notifications"))) ?? []
        nextBefore = c.string("nextBefore")
    }
}

/// The Easer's two conversations on a job. The server stamps each message with
/// one (api/booking/_message-routing.js easerMessageThread).
enum MessageThread: String {
    case customer
    case team

    var title: String { self == .customer ? "Customer" : "AssembleAtEase" }
}

struct JobMessage: Decodable, Identifiable {
    let id: String
    let sender: String
    let body: String
    let createdAt: String?
    /// When the other side opened it: the server stamps read_at, the chat shows "Seen".
    let readAt: String?
    let thread: MessageThread
    var fromMe: Bool { sender == "assembler" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        sender = c.string("sender") ?? ""
        body = c.string("body") ?? ""
        createdAt = c.string("created_at")
        readAt = c.string("read_at")
        let recipient = c.string("recipient_type") ?? ""
        thread = MessageThread(rawValue: c.string("thread") ?? "")
            ?? ((sender == "customer" || recipient == "customer") ? .customer : .team)
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
    /// A demo (App Review) account: no payouts, nothing to set up.
    let demo: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        demo = c.bool("demo") ?? false
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

/// Onboarding state from /api/assembler/verification-link (GET), the same
/// endpoint the website's verify-identity page uses.
struct SetupStatus: Decodable {
    let fullName: String
    let identityVerified: Bool
    let requiresAgreement: Bool
    let priorAgreementOnFile: Bool
    let applicationStatus: String?
    let establishedEaser: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        fullName = c.string("fullName") ?? ""
        identityVerified = c.bool("identityVerified") ?? false
        requiresAgreement = c.bool("requiresAgreement") ?? true
        priorAgreementOnFile = c.bool("priorAgreementOnFile") ?? false
        applicationStatus = c.string("applicationStatus")
        establishedEaser = c.bool("establishedEaser") ?? false
    }

    var approved: Bool { establishedEaser || (applicationStatus ?? "").lowercased() == "approved" }
}

struct VerificationStart: Decodable {
    let verificationURL: URL?
    let alreadyVerified: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        verificationURL = c.string("verificationUrl").flatMap { URL(string: $0) }
        alreadyVerified = c.bool("alreadyVerified") ?? false
    }
}
