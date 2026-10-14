import SwiftUI
import UIKit

// MARK: - Account

/// The top of the Account tab: photo, name, level, jobs and rating, the way
/// DoorDash, Instacart and Uber open theirs. One place; no second profile page.
struct AccountHeader: View {
    @EnvironmentObject private var store: EaserStore
    @State private var changingPhoto = false

    private var verified: Bool { store.profile?.identityVerified == true }

    var body: some View {
        VStack(spacing: 10) {
            Button { changingPhoto = true } label: {
                Avatar(photo: store.profile?.profilePhoto, name: store.profile?.fullName, size: 96)
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "camera.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(7)
                            .background(Brand.skyDark, in: Circle())
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Change profile photo")

            // The badge sits outside the name's own width, so the name stays centered.
            Text(store.profile?.fullName ?? "Easer")
                .font(.title2.bold())
                .multilineTextAlignment(.center)
                .overlay(alignment: .trailing) {
                    if verified {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(Brand.skyDark)
                            .offset(x: 26)
                            .accessibilityLabel("Identity verified")
                    }
                }

            Text(store.profile?.levelLabel ?? "Easer")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Brand.sky.opacity(0.18), in: Capsule())
                .foregroundStyle(Brand.skyDark)

            HStack {
                Stat(value: "\(store.earnings?.summary?.completedJobs ?? 0)", label: "Jobs done")
                Divider().frame(height: 32)
                Stat(value: ratingText, label: "Rating")
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .sheet(isPresented: $changingPhoto) { ProfilePhotoSheet().environmentObject(store) }
    }

    private var ratingText: String {
        guard let rating = store.profile?.rating, (store.profile?.reviewCount ?? 0) > 0 else { return "New" }
        return String(format: "%.1f", rating)
    }
}

/// Name, phone, location, email: one aligned row each, the way Uber and DoorDash
/// list them. A detail that can change opens its own screen with Save.
/// Mirrors assembler/profile.html; the server decides what may change.
struct PersonalInfoView: View {
    init() {}

    @EnvironmentObject private var store: EaserStore
    @State private var confirmReset = false

    private var locked: Bool { store.profile?.identityVerified == true }

    var body: some View {
        List {
            Section {
                if locked {
                    LabeledContent("Name", value: name)
                } else {
                    NavigationLink { EditDetailView(field: .name) } label: { LabeledContent("Name", value: name) }
                }
                NavigationLink { PhoneChangeView() } label: { LabeledContent("Phone", value: phone) }
                if locked {
                    LabeledContent("Location", value: location)
                } else {
                    NavigationLink { EditDetailView(field: .location) } label: { LabeledContent("Location", value: location) }
                }
                LabeledContent("Email", value: store.email ?? "On file")
                if let since = Format.day(store.profile?.createdAt) {
                    LabeledContent("Member since", value: since)
                }
            } footer: {
                if locked {
                    Text("For name or location changes, contact AssembleAtEase.")
                }
            }

            Section("Security") {
                if !locked {
                    LabeledContent("Identity") {
                        Text("Not verified").foregroundStyle(Brand.attention)
                    }
                }
                Button("Reset password") { confirmReset = true }
            }
        }
        .navigationTitle("Personal information")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
        .confirmationDialog("Send a password reset email?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Send email") { Task { await store.sendPasswordReset() } }
        } message: {
            Text("We'll email \(store.email ?? "you") a link to set a new password.")
        }
    }

    private var name: String {
        let value = store.profile?.fullName ?? ""
        return value.isEmpty ? "Not set" : value
    }

    private var phone: String {
        let value = Format.phone(store.profile?.phone)
        return value.isEmpty ? "Add" : value
    }

    /// "Austin, TX 78745", leaving out what is not on file.
    private var location: String {
        let me = store.profile
        let cityState = [me?.city ?? "", me?.state ?? ""].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ", ")
        let full = [cityState, (me?.zip ?? "").trimmingCharacters(in: .whitespaces)].filter { !$0.isEmpty }.joined(separator: " ")
        return full.isEmpty ? "Not set" : full
    }
}

/// One detail on its own screen. Save sits above the keyboard and lights up
/// once the new value is complete and different.
private struct EditDetailView: View {
    enum Field { case name, location }

    let field: Field
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    /// Apple Maps city search; an Easer may live anywhere, so not limited to Texas.
    @StateObject private var citySearch = AddressSearch(texasOnly: false)
    @State private var fullName = ""
    @State private var city = ""
    @State private var state = ""
    @State private var zip = ""
    @State private var loaded = false
    @State private var saving = false

    private var title: String {
        switch field {
        case .name: return "Name"
        case .location: return "Location"
        }
    }

    private func trimmed(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var complete: Bool {
        switch field {
        case .name: return trimmed(fullName).count >= 2
        case .location: return !trimmed(city).isEmpty && !trimmed(state).isEmpty && zip.filter(\.isNumber).count == 5
        }
    }

    private var changed: Bool {
        guard let me = store.profile else { return false }
        switch field {
        case .name: return trimmed(fullName) != (me.fullName ?? "")
        case .location: return trimmed(city) != (me.city ?? "") || trimmed(state) != (me.state ?? "") || trimmed(zip) != (me.zip ?? "")
        }
    }

    private var canSave: Bool { complete && changed && !saving }

    var body: some View {
        Form {
            Section {
                switch field {
                case .name:
                    TextField("Full name", text: $fullName)
                        .textContentType(.name)
                        .focused($focused)
                case .location:
                    TextField("City", text: $city)
                        .textContentType(.addressCity)
                        .focused($focused)
                        .onChange(of: city) { _, text in if focused { citySearch.update(text) } }
                    AddressSuggestionList(search: citySearch) { picked in
                        if !picked.city.isEmpty { city = picked.city }
                        if !picked.state.isEmpty { state = picked.state }
                        if !picked.zip.isEmpty { zip = picked.zip }
                    }
                    TextField("State", text: $state)
                        .textContentType(.addressState)
                        .textInputAutocapitalization(.characters)
                    TextField("ZIP", text: $zip)
                        .textContentType(.postalCode)
                        .keyboardType(.numberPad)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button {
                saving = true
                Task {
                    let saved = await store.saveDetails(fullName: fullName, city: city, state: state, zip: zip)
                    saving = false
                    if saved { dismiss() }
                }
            } label: {
                if saving { ProgressView().tint(Brand.ink) } else { Text("Save") }
            }
            .buttonStyle(PrimaryButtonStyle(enabled: canSave))
            .disabled(!canSave)
            .padding(16)
            .background(.bar)
        }
        .task {
            guard !loaded, let me = store.profile else { return }
            loaded = true
            fullName = me.fullName ?? ""
            city = me.city ?? ""
            state = me.state ?? ""
            zip = me.zip ?? ""
            try? await Task.sleep(nanoseconds: 400_000_000)
            focused = true
        }
    }
}

/// A new phone number, confirmed with a texted code before it is saved. The
/// number on file keeps getting texts until then (api/assembler/phone-verification.js).
private struct PhoneChangeView: View {
    enum Step: Hashable { case number, code }

    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Step?
    @State private var phone = ""
    @State private var code = ""
    @State private var sentTo: String?
    @State private var resendAt = Date.distantPast
    @State private var working = false
    @State private var problem: String?

    private var current: String { Format.phone(store.profile?.phone) }

    private var ready: Bool {
        if working { return false }
        if sentTo == nil {
            return Format.e164(phone) != nil && Format.phoneDigits(phone) != Format.phoneDigits(store.profile?.phone ?? "")
        }
        return code.count == 6
    }

    var body: some View {
        Form {
            if let sentTo {
                Section {
                    TextField("6-digit code", text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .focused($focus, equals: .code)
                        .onChange(of: code) { _, value in
                            let digits = String(value.filter(\.isNumber).prefix(6))
                            if digits != value { code = digits }
                        }
                } header: {
                    Text("Code sent to \(sentTo)")
                } footer: {
                    if let problem { Text(problem).foregroundStyle(Brand.attention) }
                }
                Section {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let wait = max(0, Int(resendAt.timeIntervalSince(context.date).rounded(.up)))
                        Button(wait > 0 ? "Send a new code in \(wait)s" : "Send a new code") {
                            Task { await send() }
                        }
                        .disabled(wait > 0 || working)
                    }
                    Button("Use a different number") {
                        self.sentTo = nil
                        code = ""
                        problem = nil
                        focus = .number
                    }
                }
            } else {
                if !current.isEmpty {
                    Section { LabeledContent("Current", value: current) }
                }
                Section {
                    TextField("512-555-0142", text: $phone)
                        .textContentType(.telephoneNumber)
                        .keyboardType(.phonePad)
                        .focused($focus, equals: .number)
                        .onChange(of: phone) { _, value in
                            let shown = Format.typingPhone(value)
                            if shown != value { phone = shown }
                        }
                } header: {
                    Text("New mobile number")
                } footer: {
                    if let problem { Text(problem).foregroundStyle(Brand.attention) }
                }
            }
        }
        .navigationTitle("Phone number")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button {
                Task {
                    if sentTo == nil { await send() } else { await confirm() }
                }
            } label: {
                if working { ProgressView().tint(Brand.ink) } else { Text(sentTo == nil ? "Send code" : "Confirm") }
            }
            .buttonStyle(PrimaryButtonStyle(enabled: ready))
            .disabled(!ready)
            .padding(16)
            .background(.bar)
        }
        .task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            focus = .number
        }
    }

    private func send() async {
        working = true
        problem = nil
        let target = Format.e164(phone) ?? phone
        if let issue = await store.sendPhoneCode(to: target) {
            problem = issue
        } else {
            sentTo = Format.phone(target)
            code = ""
            resendAt = Date().addingTimeInterval(30)
            focus = .code
        }
        working = false
    }

    private func confirm() async {
        working = true
        problem = nil
        let issue = await store.confirmPhoneCode(code)
        working = false
        if let issue {
            problem = issue
        } else {
            dismiss()
        }
    }
}

/// The services an Easer takes and the hours they work. Dispatch reads the same
/// settings (api/_easer-work-preferences.js); unset means every service, any time.
struct WorkPreferencesView: View {
    init() {}

    private struct DayHours: Identifiable {
        let key: String
        var on: Bool
        var start: Date
        var end: Date
        var id: String { key }
    }

    private static let dayNames: [String: String] = [
        "sun": "Sunday", "mon": "Monday", "tue": "Tuesday", "wed": "Wednesday",
        "thu": "Thursday", "fri": "Friday", "sat": "Saturday",
    ]

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    @EnvironmentObject private var store: EaserStore
    @State private var loaded = false
    @State private var allServicesList: [String] = []
    @State private var everyService = true
    @State private var chosen: Set<String> = []
    @State private var anyTime = true
    @State private var days: [DayHours] = []
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        List {
            if !loaded {
                Section { HStack { ProgressView(); Text("Loading").foregroundStyle(.secondary) } }
            } else {
                Section {
                    Toggle("Every service", isOn: $everyService)
                    if !everyService {
                        ForEach(allServicesList, id: \.self) { service in
                            Toggle(service, isOn: Binding(
                                get: { chosen.contains(service) },
                                set: { on in if on { chosen.insert(service) } else { chosen.remove(service) } }
                            ))
                        }
                    }
                } header: {
                    Text("Services you take")
                }

                Section {
                    Toggle("Any day, any time", isOn: $anyTime)
                    if !anyTime {
                        ForEach($days) { $day in
                            Toggle(Self.dayNames[day.key] ?? day.key, isOn: $day.on)
                            if day.on {
                                DatePicker("From", selection: $day.start, displayedComponents: .hourAndMinute)
                                DatePicker("To", selection: $day.end, displayedComponents: .hourAndMinute)
                            }
                        }
                    }
                } header: {
                    Text("When you work")
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(Brand.attention)
                    } else {
                        Text("Offers come only for these services and hours.")
                    }
                }
            }
        }
        .navigationTitle("Work preferences")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if loaded {
                Button {
                    Task { await save() }
                } label: {
                    if saving { ProgressView().tint(Brand.ink) } else { Text("Save") }
                }
                .buttonStyle(PrimaryButtonStyle(enabled: !saving))
                .disabled(saving)
                .padding(16)
                .background(.bar)
            }
        }
        .task {
            guard !loaded else { return }
            await load()
        }
    }

    private func time(_ hhmm: String, fallback: String) -> Date {
        Self.clock.date(from: hhmm) ?? Self.clock.date(from: fallback) ?? Date()
    }

    private func load() async {
        let prefs = await store.workPreferences()
        allServicesList = prefs?.allServices ?? []
        everyService = prefs?.services == nil
        chosen = Set(prefs?.services ?? allServicesList)
        anyTime = prefs?.availability == nil
        let order = prefs?.weekdays ?? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        days = order.map { key in
            let window = prefs?.availability?[key]?.first
            return DayHours(
                key: key,
                on: prefs?.availability == nil ? true : window != nil,
                start: time(window?.start ?? "08:00", fallback: "08:00"),
                end: time(window?.end ?? "20:00", fallback: "20:00")
            )
        }
        loaded = true
    }

    private func save() async {
        problem = nil
        let services: [String]? = everyService ? nil : allServicesList.filter { chosen.contains($0) }
        if let services, services.isEmpty {
            problem = "Choose at least one service."
            return
        }
        var availability: [String: [WorkWindow]]? = nil
        if !anyTime {
            var map: [String: [WorkWindow]] = [:]
            for day in days {
                let start = Self.clock.string(from: day.start)
                let end = Self.clock.string(from: day.end)
                if day.on {
                    if end <= start {
                        problem = "\(Self.dayNames[day.key] ?? day.key) must end after it starts."
                        return
                    }
                    map[day.key] = [WorkWindow(start: start, end: end)]
                } else {
                    map[day.key] = []
                }
            }
            if map.values.allSatisfy({ $0.isEmpty }) {
                problem = "Turn on at least one day."
                return
            }
            availability = map
        }
        saving = true
        problem = await store.saveWorkPreferences(services: services, availability: availability)
        saving = false
    }
}

/// What customers said, newest first.
struct ReviewsView: View {
    init() {}
    @EnvironmentObject private var store: EaserStore

    var body: some View {
        List {
            if store.reviews.isEmpty {
                Text("No reviews yet.").foregroundStyle(.secondary)
            }
            ForEach(store.reviews) { review in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 2) {
                        ForEach(0..<5, id: \.self) { index in
                            Image(systemName: index < review.rating ? "star.fill" : "star")
                                .font(.caption)
                                .foregroundStyle(index < review.rating ? Brand.sky : Color.secondary)
                        }
                        Spacer()
                        if let day = Format.day(review.createdAt) {
                            Text(day).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if !review.comment.isEmpty { Text(review.comment).font(.subheadline) }
                    Text(review.customerFirstName).font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle("Reviews")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.loadProfileExtras() }
        .task { await store.loadProfileExtras() }
    }
}

private struct Stat: View {
    let value: String
    let label: String
    var body: some View {
        VStack(spacing: 2) {
            Text(value).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Payouts

/// How the Easer gets paid. Stripe payout setup when it is on, otherwise the
/// preferred manual method; instant payout only when the server offers it.
struct PayoutsView: View {
    init() {}

    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var openedStripe = false
    @State private var opening = false
    @State private var confirmInstant = false
    @State private var preference = ""
    @State private var sendingInstant = false

    var body: some View {
        List {
            if let problem = store.payoutsProblem {
                Section { Text(problem).foregroundStyle(.secondary) }
            }

            if let connect = store.connect, connect.demo {
                Section { Text(connect.message ?? "Payouts aren't set up on demo accounts.").foregroundStyle(.secondary) }
            } else if let connect = store.connect {
                if connect.enabled {
                    Section {
                        Label(connect.payoutsEnabled ? "Payouts are on" : "Set up payouts",
                              systemImage: connect.payoutsEnabled ? "checkmark.seal.fill" : "building.columns")
                            .font(.headline)
                            .foregroundStyle(connect.payoutsEnabled ? Brand.skyDark : Color.primary)
                        Text(connect.payoutsEnabled
                             ? "Your earnings are sent to your bank automatically after each completed job."
                             : (connect.message ?? "Set up secure payouts so your earnings go straight to your bank."))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Button {
                            Task { await openStripe(manage: connect.payoutsEnabled) }
                        } label: {
                            if opening {
                                ProgressView()
                            } else {
                                Text(connect.payoutsEnabled ? "Manage bank account" : (connect.hasAccount ? "Finish payout setup" : "Set up payouts"))
                                    .fontWeight(.semibold)
                            }
                        }
                        .disabled(opening)
                    } footer: {
                        EmptyView()
                    }

                    if let quote = store.instantQuote, quote.available {
                        Section {
                            LabeledContent("Available now", value: Format.money(cents: quote.grossCents))
                            LabeledContent("Instant fee (\(String(format: "%g", quote.feePct))%)", value: "−" + Format.money(cents: quote.feeCents))
                            LabeledContent("You receive") {
                                Text(Format.money(cents: quote.netCents)).fontWeight(.bold)
                            }
                            Button {
                                confirmInstant = true
                            } label: {
                                if sendingInstant { ProgressView() } else { Text("Get paid now").fontWeight(.semibold) }
                            }
                            .disabled(sendingInstant)
                        } header: {
                            Text("Get paid now")
                        } footer: {
                            Text("Arrives in about 30 minutes. Standard payouts are free.")
                        }
                    }
                } else {
                    Section {
                        Picker("Preferred method", selection: $preference) {
                            Text("Choose a method").tag("")
                            ForEach(EaserStore.payoutMethods, id: \.value) { method in
                                Text(method.label).tag(method.value)
                            }
                        }
                        if !preference.isEmpty && preference != store.payoutPreference {
                            Button("Save") { Task { await store.savePayoutPreference(preference) } }
                                .fontWeight(.semibold)
                        }
                    } header: {
                        Text("How you get paid")
                    } footer: {
                        Text("Paid after each completed job.")
                    }
                }
            } else if store.payoutsProblem == nil {
                Section { HStack { ProgressView(); Text("Loading payout setup").foregroundStyle(.secondary) } }
            }

            Section {
            }
        }
        .navigationTitle("Payouts")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.loadPayouts() }
        .task {
            await store.loadPayouts()
            preference = store.payoutPreference
        }
        .onChange(of: store.payoutPreference) { _, saved in preference = saved }
        .onChange(of: store.browserCloses) { _, _ in
            // Back from Stripe: ask the server for the fresh status.
            if openedStripe {
                openedStripe = false
                Task { await store.loadPayouts(afterStripe: true) }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // Back from Stripe: ask the server for the fresh status.
            if phase == .active && openedStripe {
                openedStripe = false
                Task { await store.loadPayouts(afterStripe: true) }
            }
        }
        .confirmationDialog("Send this payout now?", isPresented: $confirmInstant, titleVisibility: .visible) {
            if let quote = store.instantQuote {
                Button("Send \(Format.money(cents: quote.netCents)) now") {
                    sendingInstant = true
                    Task {
                        await store.sendInstantPayout(quote)
                        sendingInstant = false
                    }
                }
            }
        } message: {
            if let quote = store.instantQuote {
                Text("A \(Format.money(cents: quote.feeCents)) instant fee applies.")
            }
        }
    }

    private func openStripe(manage: Bool) async {
        opening = true
        defer { opening = false }
        if let url = await store.payoutSetupLink(manage: manage) {
            openedStripe = true
            openURL(url)
        }
    }
}

// MARK: - Earnings rows

/// One earning, compact: job, amount, status and date. The server's longer
/// explanation appears only when the payout needs attention.
struct EarningRow: View {
    let earning: Earning

    private var paid: Bool { earning.disposition == "paid" }
    private var needsAttention: Bool { earning.disposition == "on_hold" }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(earning.service).font(.body.weight(.semibold)).lineLimit(1)
                Spacer()
                Text(Format.money(cents: earning.amountCents)).font(.body.weight(.semibold)).monospacedDigit()
            }
            HStack(spacing: 4) {
                Text(earning.statusLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(paid ? Brand.skyDark : (needsAttention ? Brand.attention : Color.secondary))
                if let day = Format.day(earning.earnedAt) {
                    Text("· " + day).font(.caption).foregroundStyle(.secondary)
                }
            }
            if needsAttention && !earning.statusMessage.isEmpty {
                Text(earning.statusMessage).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
    }
}

struct EarningsHistoryView: View {
    init() {}

    @EnvironmentObject private var store: EaserStore
    var body: some View {
        List {
            let rows = store.earnings?.earnings ?? []
            if rows.isEmpty {
                Text("No earnings yet.").foregroundStyle(.secondary)
            }
            ForEach(rows) { EarningRow(earning: $0) }
        }
        .navigationTitle("Earnings history")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
    }
}
