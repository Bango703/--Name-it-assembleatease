import SwiftUI
import UIKit

// Home: find and book. One search box first (Uber's "Where to?": the sheet
// fills with the most booked jobs and the services before anything is typed),
// a slim bar only while a visit is live, at most one suggestion, the services
// and the bundles. Booking runs on this stack. What was already booked lives
// on Activity; nothing here repeats it. Every price and status comes from the
// server (catalog.js, customer-bookings.js, promo.js, customer/account.js).

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
    @State private var searching = false

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part = hour < 12 ? "Good morning" : (hour < 17 ? "Good afternoon" : "Good evening")
        let name = store.firstName ?? flow.name.split(separator: " ").first.map(String.init)
        return name.map { "\(part), \($0)" } ?? part
    }

    var body: some View {
        NavigationStack(path: $flow.path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(greeting).font(.largeTitle.bold())
                        if let cash = store.account?.assemblecashCents, cash > 0 {
                            Label("\(wholeDollars(cash)) AssembleCash", systemImage: "star.circle.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Brand.skyDark)
                        }
                    }

                    SearchBox { searching = true }

                    if let live = store.liveVisit {
                        LiveVisitBar(booking: live) { store.open(ref: live.ref) }
                    }

                    SuggestionCard { searching = true }

                    if let catalog = flow.catalog {
                        ServicesGrid(catalog: catalog)
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
                        if let season = catalog.season {
                            SeasonSection(season: season, catalog: catalog)
                        }
                    } else if let problem = flow.loadProblem {
                        VStack(spacing: 12) {
                            Text(problem).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            Button("Try again") { Task { await flow.load() } }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(24)
                    } else {
                        ProgressView().frame(maxWidth: .infinity).padding(32)
                    }
                }
                .padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await store.refresh()
                await flow.load()
            }
            .bookingSteps()
            .safeAreaInset(edge: .bottom) { CartBar() }
        }
        .sheet(isPresented: $searching) { SearchSheet() }
        .fullScreenCover(item: $flow.booked) { done in
            BookedView(done: done)
        }
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

/// Only while a visit is live (today, or the pro is on the way or there):
/// one line, like a ride in progress. The full booking is on Activity.
private struct LiveVisitBar: View {
    let booking: BookingSummary
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Circle().fill(Brand.sky).frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(booking.statusLabel).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text(booking.time ?? booking.service).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(14)
            .background(Brand.sky.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// At most one suggestion, the most useful for this customer right now.
private struct SuggestionCard: View {
    let search: () -> Void
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @ObservedObject private var push = CustomerPush.shared
    @State private var working = false

    private enum Pick {
        case updates
        case cash(Double)
        case offer(CurrentOffer)
    }

    private var pick: Pick? {
        if !store.upcoming.isEmpty && push.status == .notDetermined { return .updates }
        if let cash = store.account?.assemblecashCents, cash > 0 { return .cash(cash) }
        if store.bookings.isEmpty, let offer = store.offer, !offer.code.isEmpty { return .offer(offer) }
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
                    search()
                }
            case .offer(let offer):
                card("gift.fill", offer.title, offer.label, flow.promoCode.caseInsensitiveCompare(offer.code) == .orderedSame ? "Added" : "Use code") {
                    flow.promoCode = offer.code
                    store.banner = CustomerBanner(text: "Code \(offer.code) is on your order.", kind: .success)
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
}

/// Every service, in rows that always fill: three across when the count
/// divides by three, two otherwise. The catch-all is one full-width row.
private struct ServicesGrid: View {
    let catalog: BookingCatalog
    @EnvironmentObject private var flow: BookingFlow

    private var tiles: [CatalogService] { catalog.services.filter { $0.name != otherServiceName } }

    /// Photo cards two to a row; three when an odd count would leave one alone.
    private var columns: [GridItem] {
        let count = tiles.count % 2 == 0 ? 2 : 3
        return Array(repeating: GridItem(.flexible(), spacing: 12), count: count)
    }

    var body: some View {
        HomeSection(title: "Services") {
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
                            .frame(width: 40, height: 40)
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

// MARK: - Conversations

struct ConversationRow: View {
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

/// A service as a photo card: the real finished work, the name and the From price over it.
/// The card's size comes from a fixed base; the photo fills it as an overlay and is
/// clipped there, so a wide photo can never push into the card beside it.
private struct ServiceTile: View {
    let service: CatalogService
    let picked: Int

    var body: some View {
        Rectangle()
            .fill(Brand.sky.opacity(0.18))
            .frame(maxWidth: .infinity)
            .frame(height: 150)
            .overlay {
                if let photo = service.photo {
                    AsyncImage(url: photo) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            Color.clear
                        }
                    }
                }
            }
            .overlay {
                LinearGradient(colors: [.clear, .black.opacity(0.72)], startPoint: .center, endPoint: .bottom)
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(service.name)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(service.fromCents.map { "From " + wholeDollars($0) } ?? "Custom quote")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.9))
                }
                .padding(12)
            }
            .overlay(alignment: .topTrailing) {
                if picked > 0 {
                    Text("\(picked)")
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Brand.sky, in: Capsule())
                        .foregroundStyle(Brand.ink)
                        .padding(10)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .accessibilityElement(children: .combine)
    }
}

/// This time of year's picks, each with its price and an Add button. The server
/// chooses the season and the items; an item the catalog no longer has is skipped.
private struct SeasonSection: View {
    @EnvironmentObject private var flow: BookingFlow
    let season: CatalogSeason
    let catalog: BookingCatalog

    private var entries: [(key: CartKey, item: CatalogItem)] {
        season.items.compactMap { line in
            guard let item = catalog.service(named: line.service)?.groups.lazy
                .compactMap({ $0.items.first { $0.name == line.name } }).first else { return nil }
            return (CartKey(service: line.service, item: line.name), item)
        }
    }

    /// Three show first; the rest open with See all.
    @State private var expanded = false
    private let firstShown = 3

    private var symbolName: String {
        if let name = season.symbol, UIImage(systemName: name) != nil { return name }
        return "sparkles"
    }

    var body: some View {
        let all = entries
        if !all.isEmpty {
            let shown = expanded ? all : Array(all.prefix(firstShown))
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Image(systemName: symbolName)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(Brand.skyDark, in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(season.title).font(.title3.bold())
                        if let through = season.through, !through.isEmpty {
                            Text("Through \(through)").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 14)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)

                ForEach(shown, id: \.key) { entry in
                    Divider()
                    ItemRow(item: entry.item, quantity: Binding(
                        get: { flow.quantity(entry.key) },
                        set: { flow.setQuantity($0, for: entry.key) }
                    ))
                    .padding(.vertical, 8)
                }

                if all.count > firstShown {
                    Divider()
                    Button(expanded ? "Show fewer" : "See all \(all.count)") {
                        withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Brand.skyDark)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
            }
            .padding(.horizontal, 16)
            .background(Brand.sky.opacity(0.12), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Brand.sky.opacity(0.35), lineWidth: 1)
            )
        }
    }
}
