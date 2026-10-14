import SwiftUI

// Home: where the customer lands. Search, the next booking with its progress,
// the current offer, services, bundles, popular items and Book again; booking
// starts here and its steps push on this stack. Everything shown comes from the
// server: the catalog (api/booking/catalog.js), the bookings and their progress
// (api/booking/customer-bookings.js) and the offer (api/promo.js).

/// "$69", or "$69.50" when there are cents.
func wholeDollars(_ cents: Double) -> String {
    let dollars = cents / 100
    return dollars == dollars.rounded() ? "$" + String(Int(dollars)) : Format.money(cents: cents)
}

struct HomeView: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @State private var query = ""

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part = hour < 12 ? "Good morning" : (hour < 17 ? "Good afternoon" : "Good evening")
        let name = store.firstName ?? flow.name.split(separator: " ").first.map(String.init)
        return name.map { "\(part), \($0)" } ?? part
    }

    var body: some View {
        NavigationStack(path: $flow.path) {
            Group {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    HomeContent()
                } else {
                    SearchResultsView(query: query)
                }
            }
            .navigationTitle(greeting)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "What do you need help with?")
            .bookingSteps()
            .safeAreaInset(edge: .bottom) { CartBar() }
        }
        .task {
            flow.loadSavedDetails()
            if flow.catalog == nil { await flow.load() }
        }
        .fullScreenCover(item: $flow.booked) { done in
            BookedView(done: done)
        }
    }
}

private struct HomeContent: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @Environment(\.openURL) private var openURL
    @State private var rebooking: String?

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let next = store.nextBooking {
                    Button { store.open(ref: next.ref) } label: { NextBookingCard(booking: next) }
                        .buttonStyle(.plain)
                }

                if let offer = store.offer, !offer.code.isEmpty {
                    OfferCard(offer: offer)
                }

                if let catalog = flow.catalog {
                    HomeSection(title: "Services") {
                        LazyVGrid(columns: columns, spacing: 12) {
                            ForEach(catalog.services) { service in
                                NavigationLink(value: BookStep.service(service.name)) {
                                    ServiceTile(service: service, picked: flow.count(in: service.name))
                                }
                                .buttonStyle(.plain)
                            }
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
                } else if let problem = flow.loadProblem {
                    VStack(spacing: 10) {
                        Text(problem).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("Try again") { Task { await flow.load() } }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(24)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(24)
                }

                if !store.finishedJobs.isEmpty {
                    HomeSection(title: "Book again") {
                        VStack(spacing: 0) {
                            ForEach(Array(store.finishedJobs.prefix(3).enumerated()), id: \.element.id) { index, job in
                                if index > 0 { Divider().padding(.leading, 16) }
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(job.service).font(.subheadline.weight(.semibold))
                                        if !job.when.isEmpty {
                                            Text(job.when).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    Button {
                                        Task { await rebook(job) }
                                    } label: {
                                        if rebooking == job.ref { ProgressView() } else { Text("Book again") }
                                    }
                                    .buttonStyle(.bordered)
                                    .tint(Brand.skyDark)
                                    .disabled(rebooking != nil)
                                }
                                .padding(14)
                            }
                        }
                        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }
                }

                TrustRow()

                HomeSection(title: "Questions?") {
                    HStack(spacing: 12) {
                        Button {
                            if let url = URL(string: "tel:" + Site.supportPhone) { openURL(url) }
                        } label: {
                            Label("Call us", systemImage: "phone.fill").frame(maxWidth: .infinity)
                        }
                        Button {
                            if let url = URL(string: "mailto:" + Site.supportEmail) { openURL(url) }
                        } label: {
                            Label("Email us", systemImage: "envelope.fill").frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.bordered)
                    .tint(Brand.skyDark)
                    .controlSize(.large)
                }
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .refreshable {
            await store.refresh()
            await flow.load()
        }
    }

    private func popularItems(_ catalog: BookingCatalog) -> [(key: CartKey, item: CatalogItem)] {
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

    private func rebook(_ job: BookingSummary) async {
        rebooking = job.ref
        defer { rebooking = nil }
        do {
            let found = try await store.api.booking(ref: job.ref)
            if flow.catalog == nil { await flow.load() }
            if flow.rebook(found.items) > 0 {
                flow.path = [.schedule]
            } else {
                store.banner = CustomerBanner(text: "Those items are no longer offered. Pick from Services.", kind: .problem)
            }
        } catch {
            store.banner = CustomerBanner(text: error.localizedDescription, kind: .problem)
        }
    }
}

/// A titled block on Home.
private struct HomeSection<Content: View>: View {
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
                Text("Your next booking")
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
                        .lineLimit(2)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.steps.indices.contains(progress.step) ? "Step \(progress.step + 1) of \(progress.steps.count): \(progress.steps[progress.step])" : "")
    }
}

private struct OfferCard: View {
    let offer: CurrentOffer
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow

    private var added: Bool { flow.promoCode.caseInsensitiveCompare(offer.code) == .orderedSame }

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "gift.fill")
                .font(.title2)
                .foregroundStyle(Brand.skyDark)
                .frame(width: 44, height: 44)
                .background(Brand.sky.opacity(0.18), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(offer.title).font(.headline)
                Text(offer.label).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button(added ? "Added" : "Use code") {
                flow.promoCode = offer.code
                store.banner = CustomerBanner(text: "Code \(offer.code) is on your order.", kind: .success)
            }
            .buttonStyle(.borderedProminent)
            .tint(Brand.skyDark)
            .disabled(added)
        }
        .padding(14)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct ServiceTile: View {
    let service: CatalogService
    let picked: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Image(systemName: serviceSymbol(service.name))
                    .font(.title3)
                    .foregroundStyle(Brand.skyDark)
                    .frame(width: 44, height: 44)
                    .background(Brand.sky.opacity(0.16), in: Circle())
                Spacer()
                if picked > 0 {
                    Text("\(picked)")
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Brand.sky, in: Capsule())
                        .foregroundStyle(Brand.ink)
                }
            }
            Text(service.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
            Text(service.fromCents.map { "From " + wholeDollars($0) } ?? "Custom quote")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
        .padding(14)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

private struct PopularCard: View {
    let item: CatalogItem
    let service: String
    @Binding var quantity: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(service).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
            Text(item.name).font(.subheadline.weight(.semibold)).lineLimit(3)
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

/// Every catalog item whose name, group or service matches what was typed.
private struct SearchResultsView: View {
    let query: String
    @EnvironmentObject private var flow: BookingFlow

    private var matches: [(key: CartKey, item: CatalogItem)] {
        guard let catalog = flow.catalog else { return [] }
        let needle = query.trimmingCharacters(in: .whitespaces)
        var out: [(key: CartKey, item: CatalogItem)] = []
        for service in catalog.services {
            for group in service.groups {
                for item in group.items where item.name.localizedCaseInsensitiveContains(needle)
                    || group.name.localizedCaseInsensitiveContains(needle)
                    || service.name.localizedCaseInsensitiveContains(needle) {
                    out.append((CartKey(service: service.name, item: item.name), item))
                }
            }
        }
        return Array(out.prefix(60))
    }

    var body: some View {
        let found = matches
        List {
            if found.isEmpty {
                ContentUnavailableView {
                    Label("No match for \u{201C}\(query)\u{201D}", systemImage: "magnifyingglass")
                } description: {
                    Text("Try another word, or describe the job for a custom quote.")
                } actions: {
                    if flow.catalog?.service(named: "Other") != nil {
                        NavigationLink("Describe your project", value: BookStep.service("Other"))
                    }
                }
            }
            ForEach(found, id: \.key) { entry in
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.key.service).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                    ItemRow(item: entry.item, quantity: Binding(
                        get: { flow.quantity(entry.key) },
                        set: { flow.setQuantity($0, for: entry.key) }
                    ))
                }
            }
        }
        .listStyle(.plain)
    }
}
