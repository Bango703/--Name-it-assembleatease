import SwiftUI

// Home, Services, search and Inbox.
//
// Built against decision fatigue (owner, 2026-10-13: "decision fatigue is all
// there, no search bar"). Uber's home is one "Where to?" box that fills with
// past and saved choices before anything is typed; the research on choice
// overload says the same: one primary action, the rest one step away. So Home
// is one search box, the next visit, and at most one suggestion. The whole
// catalog lives on the Services tab, in even grids. Every price and status
// shown comes from the server (catalog.js, customer-bookings.js, promo.js,
// customer/account.js, customer/inbox.js).

/// "$69", or "$69.50" when there are cents.
func wholeDollars(_ cents: Double) -> String {
    let dollars = cents / 100
    return dollars == dollars.rounded() ? "$" + String(Int(dollars)) : Format.money(cents: cents)
}

/// The catch-all service: shown as one full-width row, never as a tile.
private let otherServiceName = "Other"

// MARK: - Home

struct HomeView: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @ObservedObject private var push = CustomerPush.shared
    @State private var searching = false

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part = hour < 12 ? "Good morning" : (hour < 17 ? "Good afternoon" : "Good evening")
        let name = store.firstName ?? flow.name.split(separator: " ").first.map(String.init)
        return name.map { "\(part), \($0)" } ?? part
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(greeting).font(.largeTitle.bold())
                        if let cash = store.account?.assemblecashCents, cash > 0 {
                            Label("\(wholeDollars(cash)) AssembleCash", systemImage: "star.circle.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Brand.skyDark)
                        }
                    }

                    SearchBox { searching = true }

                    if let next = store.nextBooking {
                        Button { store.open(ref: next.ref) } label: { NextBookingCard(booking: next) }
                            .buttonStyle(.plain)
                    }

                    SuggestionCard()

                    if let catalog = flow.catalog {
                        HomeSection(title: "Browse") {
                            CompactServiceGrid(services: catalog.services.filter { $0.name != otherServiceName })
                        }
                    }
                }
                .padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await store.refresh() }
            .safeAreaInset(edge: .bottom) { CartBar() }
        }
        .sheet(isPresented: $searching) { SearchSheet() }
        .task {
            flow.loadSavedDetails()
            if flow.catalog == nil { await flow.load() }
        }
    }
}

/// The one thing Home asks for: what the customer needs.
struct SearchBox: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").font(.title3.weight(.semibold)).foregroundStyle(Brand.skyDark)
                Text("What do you need help with?").font(.headline).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: 58)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Brand.sky.opacity(0.6), lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Search services")
    }
}

/// At most one suggestion, the most useful for this customer right now.
private struct SuggestionCard: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @ObservedObject private var push = CustomerPush.shared
    @State private var working = false

    private enum Pick {
        case updates
        case cash(Double)
        case offer(CurrentOffer)
        case again(BookingSummary)
    }

    private var pick: Pick? {
        if !store.upcoming.isEmpty && push.status == .notDetermined { return .updates }
        if let cash = store.account?.assemblecashCents, cash > 0 { return .cash(cash) }
        if store.bookings.isEmpty, let offer = store.offer, !offer.code.isEmpty { return .offer(offer) }
        if store.upcoming.isEmpty, let last = store.finishedJobs.first { return .again(last) }
        return nil
    }

    var body: some View {
        if let pick {
            switch pick {
            case .updates:
                card("bell.badge.fill", "Know when your pro is on the way", "Get a notification when your pro is confirmed, on the way and done.", "Turn on") {
                    _ = await push.request()
                }
            case .cash(let cents):
                card("star.circle.fill", "\(wholeDollars(cents)) in AssembleCash", "It comes off your next booking at checkout.", "Book") {
                    store.tab = .services
                }
            case .offer(let offer):
                card("gift.fill", offer.title, offer.label, flow.promoCode.caseInsensitiveCompare(offer.code) == .orderedSame ? "Added" : "Use code") {
                    flow.promoCode = offer.code
                    store.banner = CustomerBanner(text: "Code \(offer.code) is on your order.", kind: .success)
                }
            case .again(let job):
                card("arrow.clockwise.circle.fill", "Book \(job.service) again", job.when.isEmpty ? "Same items, a new time." : "Last time: \(job.when)", "Book again") {
                    await rebook(job)
                }
            }
        }
    }

    private func card(_ symbol: String, _ title: String, _ detail: String, _ action: String, perform: @escaping () async -> Void) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.title2)
                .foregroundStyle(Brand.skyDark)
                .frame(width: 46, height: 46)
                .background(Brand.sky.opacity(0.16), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline).lineLimit(2)
                Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 8)
            Button {
                Task {
                    working = true
                    await perform()
                    working = false
                }
            } label: {
                if working { ProgressView() } else { Text(action).fixedSize() }
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.skyDark)
            .disabled(working || action == "Added")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func rebook(_ job: BookingSummary) async {
        do {
            let found = try await store.api.booking(ref: job.ref)
            if flow.catalog == nil { await flow.load() }
            if flow.rebook(found.items) > 0 {
                store.continueBooking()
            } else {
                store.banner = CustomerBanner(text: "Those items are no longer offered. Pick from Services.", kind: .problem)
            }
        } catch {
            store.banner = CustomerBanner(text: error.localizedDescription, kind: .problem)
        }
    }
}

/// Six services, three to a row, icon and name only: one tap opens the service.
private struct CompactServiceGrid: View {
    let services: [CatalogService]
    @EnvironmentObject private var store: CustomerStore

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
            ForEach(services) { service in
                Button { store.browse(service.name) } label: {
                    VStack(spacing: 8) {
                        Image(systemName: serviceSymbol(service.name))
                            .font(.title3)
                            .foregroundStyle(Brand.skyDark)
                            .frame(width: 42, height: 42)
                            .background(Brand.sky.opacity(0.16), in: Circle())
                        Text(service.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.primary)
                            .multilineTextAlignment(.center)
                            .lineLimit(2, reservesSpace: true)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 104)
                    .background(Brand.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Services (the whole catalog; booking runs on this stack)

struct ServicesView: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @State private var searching = false

    var body: some View {
        NavigationStack(path: $flow.path) {
            Group {
                if let catalog = flow.catalog {
                    ServicesContent(catalog: catalog) { searching = true }
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
            .navigationTitle("Services")
            .bookingSteps()
            .safeAreaInset(edge: .bottom) { CartBar() }
        }
        .sheet(isPresented: $searching) { SearchSheet() }
        .fullScreenCover(item: $flow.booked) { done in
            BookedView(done: done)
        }
        .task { if flow.catalog == nil { await flow.load() } }
    }
}

private struct ServicesContent: View {
    let catalog: BookingCatalog
    let search: () -> Void
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow

    private var tiles: [CatalogService] { catalog.services.filter { $0.name != otherServiceName } }

    /// Columns that fill every row: three when the count divides by three, else two.
    private var columns: [GridItem] {
        let count = tiles.count % 3 == 0 ? 3 : (tiles.count % 2 == 0 ? 2 : 3)
        return Array(repeating: GridItem(.flexible(), spacing: 12), count: count)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SearchBox(action: search)

                HomeSection(title: "All services") {
                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(tiles) { service in
                            NavigationLink(value: BookStep.service(service.name)) {
                                ServiceTile(service: service, picked: flow.count(in: service.name))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if catalog.service(named: otherServiceName) != nil {
                        NavigationLink(value: BookStep.service(otherServiceName)) {
                            HStack(spacing: 14) {
                                Image(systemName: "text.bubble.fill")
                                    .font(.title3)
                                    .foregroundStyle(Brand.skyDark)
                                    .frame(width: 42, height: 42)
                                    .background(Brand.sky.opacity(0.16), in: Circle())
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Something else").font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                                    Text("Describe your project for a custom quote").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                            .padding(14)
                            .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }

                if !catalog.bundles.isEmpty {
                    HomeSection(title: "Room-ready bundles") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(catalog.bundles) { bundle in
                                    BundleCard(bundle: bundle) {
                                        flow.add(bundle)
                                        store.banner = CustomerBanner(text: "\(bundle.name) added.", kind: .success)
                                    }
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                        .padding(.horizontal, -16)
                    }
                }

                let popular = popularItems(catalog)
                if !popular.isEmpty {
                    HomeSection(title: "Popular") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(popular, id: \.key) { entry in
                                    PopularCard(item: entry.item, service: entry.key.service, quantity: Binding(
                                        get: { flow.quantity(entry.key) },
                                        set: { flow.setQuantity($0, for: entry.key) }
                                    ))
                                }
                            }
                            .padding(.horizontal, 16)
                        }
                        .padding(.horizontal, -16)
                    }
                }

                TrustRow()
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .refreshable { await flow.load() }
    }
}

func popularItems(_ catalog: BookingCatalog) -> [(key: CartKey, item: CatalogItem)] {
    var out: [(key: CartKey, item: CatalogItem)] = []
    for service in catalog.services {
        for group in service.groups {
            for item in group.items where item.popular && !item.customQuote {
                out.append((CartKey(service: service.name, item: item.name), item))
            }
        }
    }
    return out
}

// MARK: - Search (the "Where to?" of this app)

/// Before anything is typed: popular jobs with their prices, the services and a
/// custom quote, so most people never type. While typing: every matching item
/// with its flat price and an Add button.
struct SearchSheet: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @FocusState private var focused: Bool

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    private var matches: [(key: CartKey, item: CatalogItem)] {
        guard let catalog = flow.catalog, !trimmed.isEmpty else { return [] }
        var out: [(key: CartKey, item: CatalogItem)] = []
        for service in catalog.services {
            for group in service.groups {
                for item in group.items where item.name.localizedCaseInsensitiveContains(trimmed)
                    || group.name.localizedCaseInsensitiveContains(trimmed)
                    || service.name.localizedCaseInsensitiveContains(trimmed) {
                    out.append((CartKey(service: service.name, item: item.name), item))
                }
            }
        }
        return Array(out.prefix(60))
    }

    var body: some View {
        NavigationStack {
            List {
                if trimmed.isEmpty {
                    if let catalog = flow.catalog {
                        let popular = Array(popularItems(catalog).prefix(6))
                        if !popular.isEmpty {
                            Section("Most booked") {
                                ForEach(popular, id: \.key) { entry in resultRow(entry) }
                            }
                        }
                        Section("Services") {
                            ForEach(catalog.services.filter { $0.name != otherServiceName }) { service in
                                Button {
                                    dismiss()
                                    store.browse(service.name)
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: serviceSymbol(service.name)).foregroundStyle(Brand.skyDark).frame(width: 26)
                                        Text(service.name).foregroundStyle(.primary)
                                        Spacer()
                                        if let cents = service.fromCents {
                                            Text("From \(wholeDollars(cents))").font(.subheadline).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                        if catalog.service(named: otherServiceName) != nil {
                            Section {
                                Button {
                                    dismiss()
                                    store.browse(otherServiceName)
                                } label: {
                                    Label("Describe your project for a custom quote", systemImage: "text.bubble")
                                }
                            }
                        }
                    } else {
                        ProgressView()
                    }
                } else if matches.isEmpty {
                    ContentUnavailableView {
                        Label("No match for \u{201C}\(trimmed)\u{201D}", systemImage: "magnifyingglass")
                    } description: {
                        Text("Try another word, or describe the job for a custom quote.")
                    } actions: {
                        Button("Describe your project") {
                            dismiss()
                            store.browse(otherServiceName)
                        }
                    }
                } else {
                    ForEach(matches, id: \.key) { entry in resultRow(entry) }
                }
            }
            .listStyle(.insetGrouped)
            .safeAreaInset(edge: .top) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("What do you need help with?", text: $query)
                        .focused($focused)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                            .accessibilityLabel("Clear")
                    }
                }
                .padding(.horizontal, 14)
                .frame(height: 50)
                .background(Brand.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
            .safeAreaInset(edge: .bottom) { CartBar(beforeContinue: { dismiss() }) }
            .navigationTitle("Find a service")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .task {
                if flow.catalog == nil { await flow.load() }
                focused = true
            }
        }
    }

    private func resultRow(_ entry: (key: CartKey, item: CatalogItem)) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.key.service).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
            ItemRow(item: entry.item, quantity: Binding(
                get: { flow.quantity(entry.key) },
                set: { flow.setQuantity($0, for: entry.key) }
            ))
        }
    }
}

// MARK: - Inbox

struct InboxView: View {
    @EnvironmentObject private var store: CustomerStore

    var body: some View {
        NavigationStack {
            List {
                if store.loadedOnce && store.conversations.isEmpty {
                    ContentUnavailableView {
                        Label("No messages yet", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Messages with your pro and with AssembleAtEase show up here.")
                    }
                    .listRowBackground(Color.clear)
                }
                ForEach(store.conversations) { conversation in
                    NavigationLink {
                        CustomerMessagesView(ref: conversation.ref, recipient: conversation.proFirstName ?? "AssembleAtEase")
                    } label: {
                        ConversationRow(conversation: conversation)
                    }
                }
            }
            .navigationTitle("Inbox")
            .refreshable { await store.refresh() }
            .onAppear { Task { await store.refreshInbox() } }
        }
    }
}

private struct ConversationRow: View {
    let conversation: InboxConversation

    private var who: String { conversation.proFirstName ?? "AssembleAtEase" }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(String(who.prefix(1)).uppercased())
                .font(.headline)
                .foregroundStyle(Brand.ink)
                .frame(width: 44, height: 44)
                .background(Brand.sky, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(who).font(.headline)
                    Spacer()
                    if let when = Format.relative(conversation.lastAt) {
                        Text(when).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Text(conversation.service).font(.caption).foregroundStyle(.secondary)
                HStack(alignment: .top) {
                    Text((conversation.lastFrom == "you" ? "You: " : "") + conversation.lastBody)
                        .font(.subheadline)
                        .foregroundStyle(conversation.unread > 0 ? Color.primary : Color.secondary)
                        .lineLimit(2)
                    Spacer()
                    if conversation.unread > 0 {
                        Text("\(conversation.unread)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Brand.ink)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Brand.sky, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Shared pieces

/// A titled block: one header style everywhere.
struct HomeSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title3.bold())
            content
        }
    }
}

/// The next booking, its status in the server's words and where it is on the way to done.
struct NextBookingCard: View {
    let booking: BookingSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Your next visit")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(booking.statusLabel).font(.title3.bold()).foregroundStyle(.primary)
                Text(booking.service).font(.subheadline).foregroundStyle(.primary)
                if !booking.when.isEmpty {
                    Label(booking.when, systemImage: "calendar").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if let progress = booking.progress { ProgressTracker(progress: progress) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Brand.sky, lineWidth: 2))
    }
}

/// Booked, Pro confirmed, On the way, Arrived, Done: the step comes from the server.
struct ProgressTracker: View {
    let progress: BookingProgress

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(Array(progress.steps.enumerated()), id: \.offset) { index, _ in
                    Capsule()
                        .fill(index <= progress.step ? Brand.sky : Color(uiColor: .tertiarySystemFill))
                        .frame(height: 6)
                }
            }
            HStack(alignment: .top, spacing: 4) {
                ForEach(Array(progress.steps.enumerated()), id: \.offset) { index, name in
                    Text(name)
                        .font(.caption2.weight(index == progress.step ? .bold : .regular))
                        .foregroundStyle(index <= progress.step ? Color.primary : Color.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2, reservesSpace: true)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.steps.indices.contains(progress.step) ? "Step \(progress.step + 1) of \(progress.steps.count): \(progress.steps[progress.step])" : "")
    }
}

private struct ServiceTile: View {
    let service: CatalogService
    let picked: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Image(systemName: serviceSymbol(service.name))
                    .font(.title3)
                    .foregroundStyle(Brand.skyDark)
                    .frame(width: 40, height: 40)
                    .background(Brand.sky.opacity(0.16), in: Circle())
                Spacer(minLength: 0)
                if picked > 0 {
                    Text("\(picked)")
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Brand.sky, in: Capsule())
                        .foregroundStyle(Brand.ink)
                }
            }
            Text(service.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(2, reservesSpace: true)
            Text(service.fromCents.map { "From " + wholeDollars($0) } ?? "Custom quote")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: 132, alignment: .topLeading)
        .padding(12)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct PopularCard: View {
    let item: CatalogItem
    let service: String
    @Binding var quantity: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(service).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase).lineLimit(1)
            Text(item.name).font(.subheadline.weight(.semibold)).lineLimit(3, reservesSpace: true)
            Spacer(minLength: 0)
            HStack {
                Text(wholeDollars(item.priceCents)).font(.headline).monospacedDigit()
                Spacer()
                QuantityControl(quantity: $quantity)
            }
        }
        .frame(width: 190, height: 150, alignment: .leading)
        .padding(14)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct TrustRow: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            fact("checkmark.shield.fill", "ID-verified pros")
            fact("tag.fill", "Flat prices, set before you book")
            fact("creditcard.fill", "Charged after the job is done")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func fact(_ symbol: String, _ text: String) -> some View {
        Label {
            Text(text).font(.subheadline)
        } icon: {
            Image(systemName: symbol).foregroundStyle(Brand.skyDark)
        }
    }
}
