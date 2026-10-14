import SwiftUI

// Booking in the app: pick items, a day and a window, an address, then pay with
// Stripe's card sheet. The catalog, the total, how it is paid and every refusal
// come from the server (api/booking/catalog.js, api/booking/promo-preview.js and
// the booking create endpoint the website uses). Nothing here prices an order.

struct CartKey: Hashable {
    let service: String
    let item: String
}

struct OrderLine: Hashable {
    let service: String
    let name: String
    let quantity: Int
}

enum BookStep: Hashable {
    case service(String)
    case schedule
    case details
    case review
}

struct JustBooked: Identifiable {
    let ref: String
    let title: String
    let note: String
    var id: String { ref }
}

/// Name, phone and address from the last booking, kept on this phone for the next one.
private struct SavedContact: Codable {
    var name = ""
    var phone = ""
    var street = ""
    var unit = ""
    var city = ""
    var zip = ""
}

@MainActor
final class BookingFlow: ObservableObject {
    @Published var catalog: BookingCatalog?
    @Published var loadProblem: String?
    @Published var path: [BookStep] = []
    @Published var quantities: [CartKey: Int] = [:]
    @Published var day = Date()
    @Published var slot: String?
    @Published var name = ""
    @Published var phone = ""
    @Published var street = ""
    @Published var unit = ""
    @Published var city = ""
    @Published var zip = ""
    @Published var details = ""
    @Published var textUpdates = false
    @Published var suggestions: [AddressSuggestion] = []
    @Published var promoCode = ""
    @Published var agreed = false
    @Published var preview: CheckoutPreview?
    @Published var previewProblem: String?
    @Published var loadingPreview = false
    @Published var working = false
    @Published var problem: String?
    @Published var booked: JustBooked?

    /// Runs after a booking is made, so the Bookings tab shows it.
    var onBooked: (() async -> Void)?

    private let api: CustomerAPI
    private var publishableKey: String?
    private var pendingHold: (fingerprint: String, created: CreatedBooking)?
    private var pendingCard: (fingerprint: String, setupID: String)?
    private var suggestTask: Task<Void, Never>?
    private var suppressSuggestions = false
    private var loadedContactFor: String?

    init(api: CustomerAPI) {
        self.api = api
    }

    var email: String { api.session?.email ?? "" }
    var itemCount: Int { quantities.values.reduce(0, +) }

    // MARK: Catalog

    func load() async {
        do {
            let fresh = try await api.catalog()
            catalog = fresh
            loadProblem = nil
            if let first = Self.isoDay.date(from: fresh.firstDate), day < first { day = first }
            if let slot, !slotOptions.contains(slot) { self.slot = nil }
        } catch let error as AppError where error.isCancelled {
            return
        } catch {
            loadProblem = error.localizedDescription
        }
        restoreContact()
    }

    func quantity(_ key: CartKey) -> Int { quantities[key] ?? 0 }

    func setQuantity(_ value: Int, for key: CartKey) {
        let clamped = min(99, max(0, value))
        if clamped == 0 { quantities.removeValue(forKey: key) } else { quantities[key] = clamped }
        preview = nil
    }

    func count(in service: String) -> Int {
        quantities.filter { $0.key.service == service }.values.reduce(0, +)
    }

    /// A bundle adds its items to the order, one of each.
    func add(_ bundle: CatalogBundle) {
        guard let catalog else { return }
        for line in bundle.included {
            let known = catalog.service(named: line.service)?.groups.contains { $0.items.contains { $0.name == line.name } } ?? false
            guard known else { continue }
            let key = CartKey(service: line.service, item: line.name)
            if quantity(key) == 0 { quantities[key] = 1 }
        }
        preview = nil
    }

    /// The order in catalog order.
    var lines: [OrderLine] {
        guard let catalog else { return [] }
        var out: [OrderLine] = []
        for service in catalog.services {
            for group in service.groups {
                for item in group.items {
                    let qty = quantity(CartKey(service: service.name, item: item.name))
                    if qty > 0 { out.append(OrderLine(service: service.name, name: item.name, quantity: qty)) }
                }
            }
        }
        return out
    }

    private var orderedServices: [String] {
        var seen: [String] = []
        for line in lines where !seen.contains(line.service) { seen.append(line.service) }
        return seen
    }

    /// Items by service, named as the catalog names them. The server looks each one up and prices it.
    private var itemsPayload: [String: Any] {
        guard let catalog else { return [:] }
        var out: [String: Any] = [:]
        for service in catalog.services {
            var picked: [[String: Any]] = []
            for group in service.groups {
                for item in group.items {
                    let qty = quantity(CartKey(service: service.name, item: item.name))
                    guard qty > 0 else { continue }
                    picked.append(["name": item.name, "qty": qty, "addon": item.addOn, "customQuote": item.customQuote, "group": group.name])
                }
            }
            if !picked.isEmpty { out[service.name] = picked }
        }
        return out
    }

    // MARK: Day and window

    static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var dayISO: String { Self.isoDay.string(from: day) }

    var dayRange: ClosedRange<Date> {
        let first = Self.isoDay.date(from: catalog?.firstDate ?? "") ?? Calendar.current.startOfDay(for: Date())
        let last = Self.isoDay.date(from: catalog?.lastDate ?? "") ?? first.addingTimeInterval(30 * 86400)
        return first...max(first, last.addingTimeInterval(86399))
    }

    var slotOptions: [String] { catalog?.windows(on: dayISO) ?? [] }

    var whenText: String {
        [Format.day(dayISO), slot].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: Address and contact

    var addressLine: String {
        let base = street.trimmingCharacters(in: .whitespacesAndNewlines)
        let extra = unit.trimmingCharacters(in: .whitespacesAndNewlines)
        return extra.isEmpty ? base : "\(base), \(extra)"
    }

    var addressText: String {
        [addressLine, city.trimmingCharacters(in: .whitespaces), "TX " + zip.trimmingCharacters(in: .whitespaces)]
            .filter { !$0.isEmpty }.joined(separator: ", ")
    }

    var detailsProblem: String? {
        if street.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter the street address." }
        if city.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter the city." }
        let zipDigits = zip.trimmingCharacters(in: .whitespaces)
        if zipDigits.count != 5 || !zipDigits.allSatisfy(\.isNumber) { return "Enter a 5-digit ZIP code." }
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Enter your name." }
        if Format.phoneDigits(phone).count != 10 { return "Enter a 10-digit phone number." }
        return nil
    }

    func addressTyped(_ text: String) {
        suggestTask?.cancel()
        if suppressSuggestions {
            suppressSuggestions = false
            return
        }
        let query = text.trimmingCharacters(in: .whitespaces)
        guard query.count >= 5 else {
            suggestions = []
            return
        }
        suggestTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled, let self else { return }
            let found = (try? await self.api.addressSuggestions(for: query)) ?? []
            guard !Task.isCancelled else { return }
            self.suggestions = found.filter { $0.state == "TX" }
        }
    }

    func use(_ suggestion: AddressSuggestion) {
        suppressSuggestions = true
        street = suggestion.street
        if !suggestion.city.isEmpty { city = suggestion.city }
        if !suggestion.zip.isEmpty { zip = suggestion.zip }
        suggestions = []
    }

    private var contactKey: String { "customer.contact.v1." + email.lowercased() }

    private func restoreContact() {
        guard loadedContactFor != email, !email.isEmpty else { return }
        loadedContactFor = email
        guard let data = UserDefaults.standard.data(forKey: contactKey),
              let saved = try? JSONDecoder().decode(SavedContact.self, from: data) else { return }
        if name.isEmpty { name = saved.name }
        if phone.isEmpty { phone = saved.phone }
        if street.isEmpty {
            suppressSuggestions = true
            street = saved.street
            unit = saved.unit
            city = saved.city
            zip = saved.zip
        }
    }

    private func saveContact() {
        let saved = SavedContact(name: name, phone: phone, street: street, unit: unit, city: city, zip: zip)
        if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: contactKey) }
    }

    // MARK: Price

    private func baseOrder(quote: Bool) -> [String: Any] {
        [
            "services": orderedServices,
            "items": itemsPayload,
            "zip": zip.trimmingCharacters(in: .whitespaces),
            "email": email,
            "promoCode": promoCode.trimmingCharacters(in: .whitespaces),
            "date": dayISO,
            "isQuoteRequest": quote,
        ]
    }

    func refreshPreview() async {
        guard itemCount > 0 else {
            preview = nil
            return
        }
        loadingPreview = true
        defer { loadingPreview = false }
        do {
            var result = try await api.preview(baseOrder(quote: false))
            if result.plan?.isQuote == true && !promoCode.trimmingCharacters(in: .whitespaces).isEmpty {
                result = try await api.preview(baseOrder(quote: true))
            }
            preview = result
            previewProblem = nil
        } catch {
            previewProblem = error.localizedDescription
        }
    }

    var promoStatus: String? {
        guard !promoCode.trimmingCharacters(in: .whitespaces).isEmpty, let preview else { return nil }
        return preview.promoApplied ? "Code applied." : "This code does not apply to this booking."
    }

    var reviewProblem: String? {
        if preview?.plan == nil { return previewProblem ?? "Loading the total." }
        if !agreed { return "Agree to the Terms to continue." }
        return nil
    }

    // MARK: Book

    private var fingerprint: String {
        var order = baseOrder(quote: false)
        order["name"] = name
        order["phone"] = Format.phoneDigits(phone)
        order["address"] = addressLine
        order["city"] = city
        order["time"] = slot ?? ""
        order["details"] = details
        order["sms"] = textUpdates
        let data = (try? JSONSerialization.data(withJSONObject: order, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    private func order(plan: CheckoutPlan, quotePreview: CheckoutPreview, setupID: String?) -> [String: Any] {
        var order = baseOrder(quote: plan.isQuote)
        order["name"] = name.trimmingCharacters(in: .whitespaces)
        order["phone"] = Format.phoneDigits(phone)
        order["address"] = addressLine
        order["city"] = city.trimmingCharacters(in: .whitespaces)
        order["state"] = "TX"
        order["time"] = slot ?? ""
        order["details"] = details.trimmingCharacters(in: .whitespacesAndNewlines)
        order["paymentMethod"] = "card"
        order["promoPreviewApplied"] = quotePreview.promoApplied
        order["promoPreviewTotalCents"] = Int(quotePreview.totalCents.rounded())
        order["termsAccepted"] = agreed
        order["termsVersion"] = catalog?.termsVersion ?? ""
        order["privacyNoticeVersion"] = catalog?.privacyNoticeVersion ?? ""
        order["smsConsent"] = textUpdates
        if let setupID { order["setupIntentId"] = setupID }
        return order
    }

    private func stripeKey() async throws -> String {
        if let publishableKey { return publishableKey }
        let key = try await api.stripeKey()
        publishableKey = key
        return key
    }

    func submit() async {
        guard let current = preview, let plan = current.plan, slot != nil, !working else { return }
        working = true
        problem = nil
        defer { working = false }
        let orderPrint = fingerprint
        let cardName = name.trimmingCharacters(in: .whitespaces)
        let cardPhone = Format.e164(phone) ?? phone
        do {
            let key = try await stripeKey()
            if plan.isQuote || plan.savesCard {
                var setupID = pendingCard?.fingerprint == orderPrint ? pendingCard?.setupID : nil
                if setupID == nil {
                    let secret = try await api.cardSetup(name: cardName, email: email,
                                                         purpose: plan.isQuote ? "quote_booking" : "future_booking", date: dayISO)
                    switch await CardSheet.present(.setup(secret), publishableKey: key, name: cardName, email: email, phone: cardPhone) {
                    case .done:
                        setupID = secret.components(separatedBy: "_secret_").first
                        if let setupID { pendingCard = (orderPrint, setupID) }
                    case .cancelled:
                        return
                    case .failed(let reason):
                        problem = reason
                        return
                    }
                }
                let created = try await api.createBooking(order(plan: plan, quotePreview: current, setupID: setupID))
                await finish(created, plan: plan)
            } else {
                let created: CreatedBooking
                if let held = pendingHold, held.fingerprint == orderPrint {
                    created = held.created
                } else {
                    created = try await api.createBooking(order(plan: plan, quotePreview: current, setupID: nil))
                    pendingHold = (orderPrint, created)
                }
                guard let secret = created.clientSecret else {
                    await finish(created, plan: plan)
                    return
                }
                switch await CardSheet.present(.payment(secret), publishableKey: key, name: cardName, email: email, phone: cardPhone) {
                case .done:
                    await confirm(created)
                    await finish(created, plan: plan)
                case .cancelled:
                    return
                case .failed(let reason):
                    problem = reason
                }
            }
        } catch {
            problem = error.localizedDescription
            await refreshPreview()
        }
    }

    /// The hold went through; the server confirms the booking. Retried quietly,
    /// and Stripe's own notice to the server confirms it if every try fails.
    private func confirm(_ created: CreatedBooking) async {
        for attempt in 0..<3 {
            do {
                try await api.confirmBooking(created)
                return
            } catch {
                if attempt < 2 { try? await Task.sleep(nanoseconds: 1_500_000_000) }
            }
        }
    }

    private func finish(_ created: CreatedBooking, plan: CheckoutPlan) async {
        saveContact()
        booked = JustBooked(ref: created.ref, title: plan.isQuote ? "Quote requested" : "You're booked", note: plan.note)
        quantities = [:]
        slot = nil
        details = ""
        promoCode = ""
        agreed = false
        preview = nil
        problem = nil
        pendingHold = nil
        pendingCard = nil
        path = []
        await onBooked?()
    }

    /// Signing out leaves nothing of this person's order on screen.
    func reset() {
        quantities = [:]
        slot = nil
        name = ""
        phone = ""
        street = ""
        unit = ""
        city = ""
        zip = ""
        details = ""
        promoCode = ""
        agreed = false
        preview = nil
        problem = nil
        pendingHold = nil
        pendingCard = nil
        loadedContactFor = nil
        path = []
        booked = nil
    }
}

// MARK: - Screens

struct BookView: View {
    @EnvironmentObject private var flow: BookingFlow

    var body: some View {
        NavigationStack(path: $flow.path) {
            Group {
                if let catalog = flow.catalog {
                    BookHomeView(catalog: catalog)
                } else if let problem = flow.loadProblem {
                    VStack(spacing: 12) {
                        Text(problem).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("Try again") { Task { await flow.load() } }
                    }
                    .padding(32)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Book")
            .navigationDestination(for: BookStep.self) { step in
                switch step {
                case .service(let name): ServiceItemsView(serviceName: name)
                case .schedule: ScheduleStepView()
                case .details: DetailsStepView()
                case .review: ReviewStepView()
                }
            }
        }
        .task { if flow.catalog == nil { await flow.load() } }
        .fullScreenCover(item: $flow.booked) { done in
            BookedView(done: done)
        }
    }
}

private func serviceSymbol(_ name: String) -> String {
    switch name {
    case "Furniture Assembly": return "sofa"
    case "Mounting & Hanging": return "tv"
    case "Smart Home": return "house"
    case "Outdoor & Playsets": return "tree"
    case "Office Assembly": return "desktopcomputer"
    case "Fitness Equipment": return "dumbbell"
    default: return "wrench.and.screwdriver"
    }
}

private struct BookHomeView: View {
    let catalog: BookingCatalog
    @EnvironmentObject private var flow: BookingFlow
    @EnvironmentObject private var store: CustomerStore

    var body: some View {
        List {
            if !catalog.bundles.isEmpty {
                Section("Room-ready bundles") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(catalog.bundles) { bundle in
                                BundleCard(bundle: bundle) {
                                    flow.add(bundle)
                                    store.banner = CustomerBanner(text: "\(bundle.name) added.", kind: .success)
                                }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                }
            }
            Section("Services") {
                ForEach(catalog.services) { service in
                    NavigationLink(value: BookStep.service(service.name)) {
                        HStack(spacing: 14) {
                            Image(systemName: serviceSymbol(service.name))
                                .font(.title3)
                                .foregroundStyle(Brand.skyDark)
                                .frame(width: 30)
                            Text(service.name)
                            Spacer()
                            let picked = flow.count(in: service.name)
                            if picked > 0 {
                                Text("\(picked)")
                                    .font(.caption.weight(.bold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(Brand.sky.opacity(0.25), in: Capsule())
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            Section {
                Text("Prices are per item. A service call fee and sales tax are added at checkout.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .refreshable { await flow.load() }
        .safeAreaInset(edge: .bottom) { CartBar() }
    }
}

private struct BundleCard: View {
    let bundle: CatalogBundle
    let add: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(bundle.name).font(.headline)
            Text(bundle.outcome).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            Spacer(minLength: 0)
            Button("Add to order", action: add)
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderless)
                .foregroundStyle(Brand.skyDark)
        }
        .frame(width: 200, height: 150, alignment: .leading)
        .padding(14)
        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// The order so far, and the way forward.
private struct CartBar: View {
    @EnvironmentObject private var flow: BookingFlow

    var body: some View {
        if flow.itemCount > 0 {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(flow.itemCount == 1 ? "1 item" : "\(flow.itemCount) items").font(.headline)
                    Text("Pick a time next").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    flow.path.append(.schedule)
                } label: {
                    Text("Continue").padding(.horizontal, 22)
                }
                .buttonStyle(PrimaryButtonStyle())
                .frame(width: 160)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
        }
    }
}

private struct ServiceItemsView: View {
    let serviceName: String
    @EnvironmentObject private var flow: BookingFlow

    var body: some View {
        List {
            if let service = flow.catalog?.service(named: serviceName) {
                ForEach(service.groups) { group in
                    Section(group.name) {
                        ForEach(group.items) { item in
                            ItemRow(item: item, quantity: Binding(
                                get: { flow.quantity(CartKey(service: serviceName, item: item.name)) },
                                set: { flow.setQuantity($0, for: CartKey(service: serviceName, item: item.name)) }
                            ))
                        }
                    }
                }
            }
        }
        .navigationTitle(serviceName)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { CartBar() }
    }
}

private struct ItemRow: View {
    let item: CatalogItem
    @Binding var quantity: Int

    private var priceText: String {
        if item.customQuote { return "Quote" }
        return (item.addOn ? "+" : "") + Format.money(cents: item.priceCents)
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.subheadline)
                HStack(spacing: 6) {
                    Text(priceText).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark).monospacedDigit()
                    if item.popular {
                        Text("Popular")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Brand.sky.opacity(0.18), in: Capsule())
                    }
                }
            }
            Spacer(minLength: 8)
            QuantityControl(quantity: $quantity)
        }
        .padding(.vertical, 2)
    }
}

private struct QuantityControl: View {
    @Binding var quantity: Int

    var body: some View {
        if quantity == 0 {
            Button("Add") { quantity = 1 }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(Brand.skyDark)
        } else {
            HStack(spacing: 10) {
                Button { quantity -= 1 } label: { Image(systemName: "minus.circle.fill") }
                    .accessibilityLabel("Remove one")
                Text("\(quantity)").font(.headline).monospacedDigit().frame(minWidth: 20)
                Button { quantity += 1 } label: { Image(systemName: "plus.circle.fill") }
                    .accessibilityLabel("Add one")
            }
            .font(.title2)
            .buttonStyle(.borderless)
            .foregroundStyle(Brand.skyDark)
        }
    }
}

/// The bottom button of a step. A step that cannot go on says why above it.
private struct StepButton: View {
    let title: String
    let problem: String?
    var working = false
    let action: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            if let problem {
                Text(problem).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Button(action: action) {
                if working { ProgressView().tint(Brand.ink) } else { Text(title) }
            }
            .buttonStyle(PrimaryButtonStyle(enabled: problem == nil && !working))
            .disabled(problem != nil || working)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private struct ScheduleStepView: View {
    @EnvironmentObject private var flow: BookingFlow

    var body: some View {
        Form {
            Section {
                DatePicker("Day", selection: $flow.day, in: flow.dayRange, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(Brand.skyDark)
            }
            Section("Arrival window") {
                if flow.slotOptions.isEmpty {
                    Text("No windows left on this day. Pick another day.").foregroundStyle(.secondary)
                }
                ForEach(flow.slotOptions, id: \.self) { option in
                    Button {
                        flow.slot = option
                    } label: {
                        HStack {
                            Text(option).foregroundStyle(.primary)
                            Spacer()
                            if flow.slot == option { Image(systemName: "checkmark").foregroundStyle(Brand.skyDark) }
                        }
                    }
                }
            }
        }
        .navigationTitle("When")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: flow.day) { _, _ in
            if let chosen = flow.slot, !flow.slotOptions.contains(chosen) { flow.slot = nil }
            flow.preview = nil
        }
        .safeAreaInset(edge: .bottom) {
            StepButton(title: "Continue", problem: flow.slot == nil ? "Pick an arrival window." : nil) {
                flow.path.append(.details)
            }
        }
    }
}

private struct DetailsStepView: View {
    @EnvironmentObject private var flow: BookingFlow
    @Environment(\.openURL) private var openURL

    var body: some View {
        Form {
            Section {
                TextField("Street address", text: $flow.street)
                    .textContentType(.streetAddressLine1)
                    .onChange(of: flow.street) { _, text in flow.addressTyped(text) }
                ForEach(flow.suggestions) { suggestion in
                    Button {
                        flow.use(suggestion)
                    } label: {
                        Label(suggestion.label, systemImage: "mappin.circle").foregroundStyle(.primary).font(.subheadline)
                    }
                }
                TextField("Apt, suite or unit (optional)", text: $flow.unit)
                    .textContentType(.streetAddressLine2)
                TextField("City", text: $flow.city)
                    .textContentType(.addressCity)
                TextField("ZIP code", text: $flow.zip)
                    .textContentType(.postalCode)
                    .keyboardType(.numberPad)
                    .onChange(of: flow.zip) { _, value in
                        let digits = String(value.filter(\.isNumber).prefix(5))
                        if digits != value { flow.zip = digits }
                        flow.preview = nil
                    }
            } header: {
                Text("Address")
            } footer: {
                Text("Texas addresses only.")
            }

            Section("Contact") {
                TextField("Full name", text: $flow.name)
                    .textContentType(.name)
                TextField("Phone", text: $flow.phone)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .onChange(of: flow.phone) { _, value in
                        let typed = Format.typingPhone(value)
                        if typed != value { flow.phone = typed }
                    }
                LabeledContent("Email", value: flow.email)
            }

            Section("Notes for your pro") {
                TextField("Gate code, parking, where the items are", text: $flow.details, axis: .vertical)
                    .lineLimit(2...5)
            }

            Section {
                Toggle(isOn: $flow.textUpdates) {
                    Text("Optional: Text me appointment and service updates from AssembleAtEase at the number above. Message frequency varies. Message and data rates may apply. Consent is not a condition of purchase. Reply STOP to opt out or HELP for help.")
                        .font(.footnote)
                }
                .tint(Brand.skyDark)
                Button("SMS Terms") { openURL(Site.page("/terms#sms-terms")) }
                    .font(.footnote)
            }
        }
        .navigationTitle("Where")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            StepButton(title: "Review", problem: flow.detailsProblem) {
                flow.path.append(.review)
            }
        }
    }
}

private struct ReviewStepView: View {
    @EnvironmentObject private var flow: BookingFlow
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                CustomerBlock(title: "Your order") {
                    ForEach(flow.lines, id: \.self) { line in
                        Text(line.quantity > 1 ? "\(line.quantity) × \(line.name)" : line.name).font(.subheadline)
                    }
                    Button("Change items") { flow.path = [] }.font(.subheadline)
                }

                CustomerBlock(title: "When and where") {
                    Label(flow.whenText, systemImage: "calendar")
                    Label(flow.addressText, systemImage: "mappin.and.ellipse")
                }

                CustomerBlock(title: "Promo code") {
                    HStack {
                        TextField("Code", text: $flow.promoCode)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        Button("Apply") { Task { await flow.refreshPreview() } }
                            .disabled(flow.promoCode.trimmingCharacters(in: .whitespaces).isEmpty || flow.loadingPreview)
                    }
                    if let status = flow.promoStatus {
                        Text(status).font(.footnote).foregroundStyle(.secondary)
                    }
                }

                if let summary = flow.preview?.summary {
                    CustomerBlock(title: summary.totalLabel) {
                        if summary.totalCents > 0 {
                            Text(Format.money(cents: summary.totalCents)).font(.title2.bold()).monospacedDigit()
                        }
                        ForEach(Array(summary.rows.enumerated()), id: \.offset) { _, row in
                            HStack {
                                Text(row.label).font(.subheadline)
                                Spacer()
                                Text(Format.money(cents: row.cents)).font(.subheadline).monospacedDigit()
                            }
                        }
                        if let note = summary.note { Text(note).font(.caption).foregroundStyle(.secondary) }
                        if let plan = flow.preview?.plan, !plan.note.isEmpty {
                            Text(plan.note).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark)
                        }
                    }
                } else if let problem = flow.previewProblem {
                    CustomerBlock(title: "Total") {
                        Text(problem).foregroundStyle(.secondary)
                        Button("Try again") { Task { await flow.refreshPreview() } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding()
                }

                Toggle(isOn: $flow.agreed) {
                    Text("I agree to the Terms of Service and acknowledge the Privacy Notice.").font(.footnote)
                }
                .tint(Brand.skyDark)
                HStack(spacing: 18) {
                    Button("Terms") { openURL(Site.page("/terms")) }
                    Button("Privacy") { openURL(Site.page("/privacy")) }
                }
                .font(.footnote)

                if let problem = flow.problem {
                    Text(problem).font(.subheadline).foregroundStyle(Brand.attention)
                }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Review")
        .navigationBarTitleDisplayMode(.inline)
        .task { await flow.refreshPreview() }
        .safeAreaInset(edge: .bottom) {
            StepButton(title: flow.preview?.plan?.button ?? "Book now", problem: flow.reviewProblem, working: flow.working) {
                Task { await flow.submit() }
            }
        }
    }
}

private struct BookedView: View {
    let done: JustBooked
    @EnvironmentObject private var flow: BookingFlow
    @EnvironmentObject private var store: CustomerStore

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(Brand.skyDark)
            Text(done.title).font(.largeTitle.bold())
            Text("Booking \(done.ref)").font(.headline).foregroundStyle(.secondary)
            if !done.note.isEmpty {
                Text(done.note).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Text("A confirmation is on its way to \(flow.email).")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer()
            Button("View booking") {
                flow.booked = nil
                store.open(ref: done.ref)
            }
            .buttonStyle(PrimaryButtonStyle())
            Button("Done") { flow.booked = nil }
                .buttonStyle(SecondaryButtonStyle())
        }
        .padding(24)
    }
}
