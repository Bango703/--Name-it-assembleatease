import Foundation

// Field names are the server's (api/booking/customer-bookings.js and
// api/booking/track.js). Each field is decoded on its own, so one unexpected
// value never empties a screen. scripts/test-customer-native-app.mjs checks
// every field read here against the server.

/// One booking in the list.
struct BookingSummary: Decodable, Identifiable, Hashable {
    let id: String
    let ref: String
    let service: String
    let date: String?
    let time: String?
    let address: String?
    let status: String
    let statusLabel: String
    let statusDetail: String?
    let proFirstName: String?

    /// Finished bookings go under Past; everything else is upcoming.
    var isPast: Bool { ["completed", "cancelled", "declined", "refunded"].contains(status) }

    var when: String {
        [Format.day(date), time].compactMap { $0 }.joined(separator: " · ")
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        ref = c.string("ref") ?? ""
        service = c.string("service") ?? "Booking"
        date = c.string("date")
        time = c.string("time")
        address = c.string("address")
        status = c.string("status") ?? ""
        statusLabel = c.string("customer_status") ?? "Booking received"
        statusDetail = c.string("customer_status_detail")
        proFirstName = c.string("pro_first_name")
    }
}

struct BookingsEnvelope: Decodable {
    let bookings: [BookingSummary]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        bookings = (try? c.decodeIfPresent([BookingSummary].self, forKey: DynamicKey("bookings"))) ?? []
    }
}

struct BookingItem: Decodable, Hashable {
    let name: String
    let quantity: Int
    let isAddOn: Bool
    let addOnName: String?
    let lineTotalCents: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? ""
        quantity = Int(c.number("quantity") ?? 1)
        isAddOn = c.bool("isAddOn") ?? false
        addOnName = c.string("addOnName")
        lineTotalCents = c.number("lineTotalCents")
    }
}

struct BookingItemGroup: Decodable, Hashable {
    let label: String
    let items: [BookingItem]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        label = c.string("label") ?? ""
        items = (try? c.decodeIfPresent([BookingItem].self, forKey: DynamicKey("items"))) ?? []
    }
}

/// The price breakdown, worked out by the server (api/booking/_customer-payment-summary.js).
struct PaymentSummary: Decodable, Hashable {
    struct Row: Decodable, Hashable {
        let label: String
        let cents: Double
        let strong: Bool
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: DynamicKey.self)
            label = c.string("label") ?? ""
            cents = c.number("cents") ?? 0
            strong = c.bool("strong") ?? false
        }
    }
    let totalLabel: String
    let totalCents: Double
    let rows: [Row]
    let note: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        totalLabel = c.string("total_label") ?? "Booking Total"
        totalCents = c.number("total_cents") ?? 0
        rows = (try? c.decodeIfPresent([Row].self, forKey: DynamicKey("rows"))) ?? []
        note = c.string("note")
    }
}

/// The cancel button's warning, from the same evaluation the cancel endpoint charges with.
struct CancellationPreview: Decodable, Hashable {
    let feeCents: Double
    let message: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        feeCents = c.number("fee_cents") ?? 0
        message = c.string("message")
    }
}

/// A new time the pro proposed, for the customer to accept or decline.
struct ProposedTime: Decodable, Hashable {
    let id: String
    let date: String
    let time: String
    let note: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? ""
        date = c.string("date") ?? ""
        time = c.string("time") ?? ""
        note = c.string("note")
    }
}

/// One booking, opened (api/booking/track.js).
struct BookingDetail: Decodable {
    let id: String
    let ref: String
    let status: String
    let statusLabel: String
    let statusDetail: String?
    let service: String
    let date: String?
    let time: String?
    let address: String?
    let city: String?
    let proFirstName: String?
    let proPhoto: String?
    let proRating: Double?
    let proJobs: Int?
    let proVerified: Bool
    let completionPhotoURL: URL?
    /// "pro" once a pro has accepted, otherwise "team" (who the message box reaches).
    let messageRecipient: String
    let cancellation: CancellationPreview?
    let proposal: ProposedTime?
    let items: [BookingItemGroup]
    let slots: [String]
    let windowDays: Int
    let payment: PaymentSummary?

    /// Decided by the server (track.js can_reschedule, from reschedule.js's own gates).
    let canReschedule: Bool
    /// The server sends a cancellation preview only while cancelling is possible.
    var canCancel: Bool { cancellation != nil }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? ""
        ref = c.string("ref") ?? ""
        status = c.string("status") ?? ""
        statusLabel = c.string("customer_status") ?? "Booking received"
        statusDetail = c.string("customer_status_detail")
        service = c.string("service") ?? "Booking"
        date = c.string("date")
        time = c.string("time")
        address = c.string("address")
        city = c.string("city")
        proFirstName = c.string("pro_first_name")
        proPhoto = c.string("pro_photo")
        proRating = c.number("pro_rating")
        proJobs = c.number("pro_jobs").map { Int($0) }
        proVerified = c.bool("pro_verified") ?? false
        completionPhotoURL = c.string("completion_photo_url").flatMap(URL.init(string:))
        messageRecipient = c.string("message_recipient") ?? "team"
        cancellation = try? c.decodeIfPresent(CancellationPreview.self, forKey: DynamicKey("cancellation_preview"))
        proposal = try? c.decodeIfPresent(ProposedTime.self, forKey: DynamicKey("easer_time_proposal"))
        items = (try? c.decodeIfPresent([BookingItemGroup].self, forKey: DynamicKey("items"))) ?? []
        payment = try? c.decodeIfPresent(PaymentSummary.self, forKey: DynamicKey("payment_summary"))
        let options = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("reschedule_options"))
        slots = (try? options?.decodeIfPresent([String].self, forKey: DynamicKey("slots"))) ?? []
        windowDays = Int(options?.number("window_days") ?? 0)
        canReschedule = c.bool("can_reschedule") ?? false
    }

    var when: String {
        [Format.day(date), time].compactMap { $0 }.joined(separator: " · ")
    }
}

struct BookingEnvelope: Decodable {
    let booking: BookingDetail
}

struct CustomerMessage: Decodable, Identifiable, Hashable {
    let id: String
    let sender: String
    let body: String
    let createdAt: String?
    var fromMe: Bool { sender == "customer" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        sender = c.string("sender") ?? ""
        body = c.string("body") ?? ""
        createdAt = c.string("created_at")
    }
}

struct CustomerMessagesEnvelope: Decodable {
    let messages: [CustomerMessage]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        messages = (try? c.decodeIfPresent([CustomerMessage].self, forKey: DynamicKey("messages"))) ?? []
    }
}

struct BookingPhoto: Decodable, Identifiable, Hashable {
    let id: String
    let url: URL?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        url = c.string("signed_url").flatMap(URL.init(string:))
    }
}

struct BookingPhotosEnvelope: Decodable {
    let photos: [BookingPhoto]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        photos = (try? c.decodeIfPresent([BookingPhoto].self, forKey: DynamicKey("photos"))) ?? []
    }
}
