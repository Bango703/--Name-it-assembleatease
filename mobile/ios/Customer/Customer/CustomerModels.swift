import Foundation

// Field names are the server's (api/booking/customer-bookings.js and
// api/booking/track.js). Each field is decoded on its own, so one unexpected
// value never empties a screen. scripts/test-customer-native-app.mjs checks
// every field read here against the server.

/// Where a booking is on its way to done (api/booking/_customer-status.js customerProgress).
struct BookingProgress: Decodable, Hashable {
    let step: Int
    let steps: [String]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        step = Int(c.number("step") ?? 0)
        steps = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("steps"))) ?? []
    }
}

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
    let progress: BookingProgress?

    /// Finished bookings go under Past; everything else is upcoming.
    var isPast: Bool { ["completed", "cancelled", "declined", "refunded"].contains(status) }
    var isCompleted: Bool { status == "completed" }

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
        progress = try? c.decodeIfPresent(BookingProgress.self, forKey: DynamicKey("customer_progress"))
    }
}

struct BookingsEnvelope: Decodable {
    let bookings: [BookingSummary]
    let firstName: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        bookings = (try? c.decodeIfPresent([BookingSummary].self, forKey: DynamicKey("bookings"))) ?? []
        firstName = c.string("customer_first_name")
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
    let progress: BookingProgress?
    /// Decided by the server (track.js review): a completed job can be rated once.
    let canReview: Bool
    let myRating: Int?
    /// Extra work the pro asked for, waiting on this customer (track.js change_orders).
    let changeOrders: [ChangeOrder]

    /// Finished bookings show no change buttons and a quieter card.
    var isPast: Bool { ["completed", "cancelled", "declined", "refunded"].contains(status) }
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
        progress = try? c.decodeIfPresent(BookingProgress.self, forKey: DynamicKey("customer_progress"))
        let review = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("review"))
        canReview = review?.bool("can_review") ?? false
        myRating = review?.number("rating").map { Int($0) }
        changeOrders = (try? c.decodeIfPresent([ChangeOrder].self, forKey: DynamicKey("change_orders"))) ?? []
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
    /// When the other side opened it: the server stamps read_at, the chat shows "Seen".
    let readAt: String?
    var fromMe: Bool { sender == "customer" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? UUID().uuidString
        sender = c.string("sender") ?? ""
        body = c.string("body") ?? ""
        createdAt = c.string("created_at")
        readAt = c.string("read_at")
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

// MARK: - Booking in the app
// api/booking/catalog.js, api/booking/promo-preview.js and the booking create
// endpoint. Prices shown here are the catalog's; the server prices the order.

struct CatalogItem: Decodable, Hashable, Identifiable {
    let name: String
    let priceCents: Double
    let addOn: Bool
    let customQuote: Bool
    let popular: Bool
    var id: String { name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? ""
        priceCents = c.number("price_cents") ?? 0
        addOn = c.bool("add_on") ?? false
        customQuote = c.bool("custom_quote") ?? false
        popular = c.bool("popular") ?? false
    }
}

struct CatalogGroup: Decodable, Hashable, Identifiable {
    let name: String
    let items: [CatalogItem]
    var id: String { name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? ""
        items = (try? c.decodeIfPresent([CatalogItem].self, forKey: DynamicKey("items"))) ?? []
    }
}

struct CatalogService: Decodable, Hashable, Identifiable {
    let name: String
    let fromCents: Double?
    /// A real job photo for this service (api/booking/catalog.js SERVICE_PHOTOS).
    let photo: URL?
    let groups: [CatalogGroup]
    var id: String { name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        name = c.string("name") ?? ""
        fromCents = c.number("from_cents")
        photo = c.string("photo").map { Site.page($0) }
        groups = (try? c.decodeIfPresent([CatalogGroup].self, forKey: DynamicKey("groups"))) ?? []
    }
}

struct BundleLine: Decodable, Hashable {
    let service: String
    let name: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        service = c.string("service") ?? ""
        name = c.string("name") ?? ""
    }
}

struct CatalogBundle: Decodable, Hashable, Identifiable {
    let slug: String
    let name: String
    let outcome: String
    let included: [BundleLine]
    var id: String { slug }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        slug = c.string("slug") ?? UUID().uuidString
        name = c.string("name") ?? ""
        outcome = c.string("outcome") ?? ""
        included = (try? c.decodeIfPresent([BundleLine].self, forKey: DynamicKey("included"))) ?? []
    }
}

struct BookingCatalog: Decodable {
    let services: [CatalogService]
    let bundles: [CatalogBundle]
    let slots: [String]
    let firstDate: String
    let lastDate: String
    let today: String
    let todayOpenSlots: [String]
    let termsVersion: String
    let privacyNoticeVersion: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        services = (try? c.decodeIfPresent([CatalogService].self, forKey: DynamicKey("services"))) ?? []
        bundles = (try? c.decodeIfPresent([CatalogBundle].self, forKey: DynamicKey("bundles"))) ?? []
        slots = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("slots"))) ?? []
        firstDate = c.string("first_date") ?? ""
        lastDate = c.string("last_date") ?? ""
        today = c.string("today") ?? ""
        todayOpenSlots = (try? c.decodeIfPresent([String].self, forKey: DynamicKey("today_open_slots"))) ?? []
        termsVersion = c.string("terms_version") ?? ""
        privacyNoticeVersion = c.string("privacy_notice_version") ?? ""
    }

    func service(named name: String) -> CatalogService? { services.first { $0.name == name } }

    /// The windows a day offers: today only keeps the ones the server still accepts.
    func windows(on day: String) -> [String] { day == today ? todayOpenSlots : slots }
}

/// How this order is paid for, decided by the server (api/booking/_checkout.js).
struct CheckoutPlan: Decodable, Hashable {
    let kind: String
    let button: String
    let note: String

    var isQuote: Bool { kind == "quote" }
    var savesCard: Bool { kind == "save_card" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        kind = c.string("kind") ?? "pay_now"
        button = c.string("button") ?? "Book now"
        note = c.string("note") ?? ""
    }
}

/// The server's price for this order before it is booked.
struct CheckoutPreview: Decodable {
    let summary: PaymentSummary?
    let plan: CheckoutPlan?
    let promoApplied: Bool
    let promoReason: String
    /// Before AssembleCash: the figure the booking checks a promo against.
    let totalCents: Double
    /// AssembleCash this booking would apply (already in the summary rows).
    let assemblecashAppliedCents: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        summary = try? c.decodeIfPresent(PaymentSummary.self, forKey: DynamicKey("summary"))
        plan = try? c.decodeIfPresent(CheckoutPlan.self, forKey: DynamicKey("plan"))
        let promo = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("promo"))
        promoApplied = promo?.bool("applied") ?? false
        promoReason = promo?.string("reason") ?? "no_code"
        let pricing = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("pricing"))
        totalCents = pricing?.number("totalCents") ?? 0
        let cash = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("assemblecash"))
        assemblecashAppliedCents = cash?.number("applied_cents") ?? 0
    }
}

/// What the server answers when an order becomes a booking.
struct CreatedBooking: Decodable {
    let ref: String
    let bookingID: String
    let guestToken: String
    let clientSecret: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        ref = c.string("ref") ?? ""
        bookingID = c.string("bookingId") ?? ""
        guestToken = c.string("guestMutationToken") ?? ""
        clientSecret = c.string("clientSecret")
    }
}

struct AddressSuggestion: Decodable, Hashable, Identifiable {
    let street: String
    let city: String
    let state: String
    let zip: String
    let label: String
    var id: String { label }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        street = c.string("street") ?? ""
        city = c.string("city") ?? ""
        state = c.string("state") ?? "TX"
        zip = c.string("zip") ?? ""
        label = c.string("label") ?? ""
    }
}

struct AddressSuggestionsEnvelope: Decodable {
    let suggestions: [AddressSuggestion]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        suggestions = (try? c.decodeIfPresent([AddressSuggestion].self, forKey: DynamicKey("suggestions"))) ?? []
    }
}

/// The offer running now (api/promo.js), shown on Home.
struct CurrentOffer: Decodable, Hashable {
    let code: String
    let title: String
    let label: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        code = c.string("code") ?? ""
        title = c.string("title") ?? ""
        label = c.string("label") ?? ""
    }
}

struct CurrentOfferEnvelope: Decodable {
    let offer: CurrentOffer?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        offer = try? c.decodeIfPresent(CurrentOffer.self, forKey: DynamicKey("promo"))
    }
}

/// The signed-in customer's AssembleCash (api/customer/account.js GET).
struct AccountSummary: Decodable {
    let assemblecashCents: Double
    /// Passed to the preview and the booking so the server applies the balance.
    let assemblecashToken: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        let cash = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("assemblecash"))
        assemblecashCents = cash?.number("balance_cents") ?? 0
        assemblecashToken = cash?.string("token")
    }
}

/// One conversation in Inbox (api/customer/inbox.js).
struct InboxConversation: Decodable, Identifiable, Hashable {
    let ref: String
    let service: String
    let date: String?
    let proFirstName: String?
    /// "pro" or "team": who a reply goes to (api/booking/_message-routing.js).
    let messageRecipient: String
    let lastBody: String
    let lastFrom: String
    let lastAt: String?
    let unread: Int
    var id: String { ref }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        ref = c.string("ref") ?? ""
        service = c.string("service") ?? "Booking"
        date = c.string("date")
        proFirstName = c.string("pro_first_name")
        messageRecipient = c.string("message_recipient") ?? "team"
        lastBody = c.string("last_body") ?? ""
        lastFrom = c.string("last_from") ?? "team"
        lastAt = c.string("last_at")
        unread = Int(c.number("unread") ?? 0)
    }
}

struct InboxEnvelope: Decodable {
    let conversations: [InboxConversation]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        conversations = (try? c.decodeIfPresent([InboxConversation].self, forKey: DynamicKey("conversations"))) ?? []
    }
}

/// Extra work waiting for the customer's answer (api/booking/change-order-approve.js).
struct ChangeOrder: Decodable, Identifiable, Hashable {
    let id: String
    let summary: String
    let subtotalCents: Double
    let taxCents: Double
    let totalCents: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        id = c.string("id") ?? ""
        summary = c.string("description") ?? "Additional work"
        subtotalCents = c.number("subtotal_cents") ?? 0
        taxCents = c.number("tax_cents") ?? 0
        totalCents = c.number("total_cents") ?? 0
    }
}

/// Whether and how this job can be tipped (api/booking/tip.js quote).
struct TipQuote: Decodable {
    let easerFirstName: String
    let canReceive: Bool
    let alreadyTippedCents: Double?
    let reason: String?
    let minCents: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        easerFirstName = c.string("easerFirstName") ?? "your pro"
        canReceive = c.bool("canReceive") ?? false
        let already = try? c.nestedContainer(keyedBy: DynamicKey.self, forKey: DynamicKey("alreadyTipped"))
        alreadyTippedCents = already?.number("amountCents")
        reason = c.string("reason")
        minCents = c.number("minCents") ?? 100
    }
}

struct TipStart: Decodable {
    let clientSecret: String
    let stripeAccount: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        clientSecret = c.string("clientSecret") ?? ""
        stripeAccount = c.string("stripeAccount") ?? ""
    }
}

/// The server's answer to approve or decline: its own words, shown as written.
struct ServerVerdict: Decodable {
    let ok: Bool
    let message: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        ok = c.bool("ok") ?? false
        message = c.string("message") ?? ""
    }
}
