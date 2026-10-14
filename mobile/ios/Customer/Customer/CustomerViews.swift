import SwiftUI
import PhotosUI

// MARK: - Sign in

/// Email, then the 6-digit code we email. No sign-in secret to remember.
struct CustomerSignInView: View {
    @EnvironmentObject private var store: CustomerStore
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var working = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var cleanEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                BrandLogo(size: 84).padding(.top, 48)
                VStack(spacing: 6) {
                    Text("AssembleAtEase").font(.title.bold())
                    Text(codeSent ? "Enter the code we sent to \(cleanEmail)." : "Sign in with the email you book with.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }

                if !codeSent {
                    TextField("Email", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .padding(14)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    TextField("6-digit code", text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .focused($focused)
                        .font(.title2.monospacedDigit())
                        .multilineTextAlignment(.center)
                        .padding(14)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .onChange(of: code) { _, value in
                            let digits = String(value.filter(\.isNumber).prefix(6))
                            if digits != value { code = digits }
                            if digits.count == 6 && !working { Task { await verify() } }
                        }
                }

                if let problem {
                    Text(problem).font(.footnote).foregroundStyle(Brand.attention).multilineTextAlignment(.center)
                }

                Button {
                    Task {
                        if codeSent { await verify() } else { await send() }
                    }
                } label: {
                    if working { ProgressView().tint(Brand.ink) } else { Text(codeSent ? "Sign in" : "Email me a code") }
                }
                .buttonStyle(PrimaryButtonStyle(enabled: canSubmit))
                .disabled(!canSubmit || working)

                if codeSent {
                    HStack(spacing: 18) {
                        Button("Send a new code") { Task { await send() } }
                        Button("Use another email") {
                            codeSent = false
                            code = ""
                            problem = nil
                        }
                    }
                    .font(.subheadline)
                    .disabled(working)
                }

                Text("By signing in you agree to the Terms of Service and Privacy Policy.")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                HStack(spacing: 18) {
                    Button("Terms") { openURL(Site.page("/terms")) }
                    Button("Privacy") { openURL(Site.page("/privacy")) }
                }
                .font(.caption)
            }
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear { focused = true }
    }

    private var canSubmit: Bool {
        codeSent ? code.count == 6 : (cleanEmail.contains("@") && cleanEmail.contains("."))
    }

    private func send() async {
        working = true
        problem = nil
        if let reason = await store.sendCode(to: cleanEmail) {
            problem = reason
        } else {
            codeSent = true
            code = ""
            focused = true
        }
        working = false
    }

    private func verify() async {
        guard code.count == 6 else { return }
        working = true
        problem = nil
        if let reason = await store.verify(email: cleanEmail, code: code) {
            problem = reason
            code = ""
        }
        working = false
    }
}

// MARK: - Activity

struct BookingRef: Hashable { let ref: String }

/// Activity: everything already booked, and every conversation about it.
/// Home finds and books; this tab follows what was booked. Nothing here repeats Home.
struct ActivityView: View {
    enum Segment: Hashable { case upcoming, past, messages }

    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @State private var path: [BookingRef] = []
    @State private var segment: Segment = .upcoming
    @State private var rebooking: String?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    Picker("Show", selection: $segment) {
                        Text("Upcoming").tag(Segment.upcoming)
                        Text("Past").tag(Segment.past)
                        Text(store.unreadCount > 0 ? "Messages (\(store.unreadCount))" : "Messages").tag(Segment.messages)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }

                if let problem = store.loadProblem, store.bookings.isEmpty {
                    Text(problem).foregroundStyle(.secondary)
                }

                switch segment {
                case .upcoming:
                    if store.loadedOnce && store.upcoming.isEmpty {
                        emptyState("No upcoming visits", "calendar", "Book a service and it shows up here.")
                    }
                    ForEach(store.upcoming) { booking in
                        NavigationLink(value: BookingRef(ref: booking.ref)) { BookingRow(booking: booking) }
                    }
                case .past:
                    if store.loadedOnce && store.past.isEmpty {
                        emptyState("No past visits", "clock.arrow.circlepath", "Finished and cancelled bookings show up here.")
                    }
                    ForEach(store.past) { booking in
                        NavigationLink(value: BookingRef(ref: booking.ref)) { BookingRow(booking: booking) }
                            .swipeActions(edge: .trailing) {
                                if booking.isCompleted {
                                    Button { Task { await rebook(booking) } } label: { Label("Book again", systemImage: "arrow.clockwise") }
                                        .tint(Brand.skyDark)
                                }
                            }
                    }
                case .messages:
                    if store.loadedOnce && store.conversations.isEmpty {
                        emptyState("No messages yet", "bubble.left.and.bubble.right", "Messages with your pro and with AssembleAtEase show up here.")
                    }
                    ForEach(store.conversations) { conversation in
                        NavigationLink {
                            CustomerMessagesView(ref: conversation.ref, recipient: conversation.proFirstName ?? "AssembleAtEase")
                        } label: {
                            ConversationRow(conversation: conversation)
                        }
                    }
                }
            }
            .navigationTitle("Activity")
            .navigationDestination(for: BookingRef.self) { BookingDetailView(ref: $0.ref) }
            .refreshable { await store.refresh() }
            .overlay {
                if !store.loadedOnce { ProgressView() }
            }
            .onChange(of: segment) { _, value in
                if value == .messages { Task { await store.refreshInbox() } }
            }
        }
        .onAppear(perform: openRequested)
        .onChange(of: store.openRef) { _, _ in openRequested() }
    }

    private func emptyState(_ title: String, _ symbol: String, _ detail: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            Text(detail)
        } actions: {
            if segment != .messages {
                Button("Find a service") { store.tab = .home }
                    .buttonStyle(.borderedProminent)
                    .tint(Brand.skyDark)
            }
        }
        .listRowBackground(Color.clear)
    }

    private func openRequested() {
        guard let ref = store.openRef else { return }
        store.openRef = nil
        segment = .upcoming
        path = [BookingRef(ref: ref)]
    }

    private func rebook(_ job: BookingSummary) async {
        rebooking = job.ref
        defer { rebooking = nil }
        do {
            let found = try await store.api.booking(ref: job.ref)
            if flow.catalog == nil { await flow.load() }
            if flow.rebook(found.items) > 0 {
                store.continueBooking()
            } else {
                store.banner = CustomerBanner(text: "Those items are no longer offered. Pick from Home.", kind: .problem)
            }
        } catch {
            store.banner = CustomerBanner(text: error.localizedDescription, kind: .problem)
        }
    }
}

private struct BookingRow: View {
    let booking: BookingSummary

    private static let monthIn: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private var dayParts: (month: String, day: String)? {
        guard let raw = booking.date, let date = Self.monthIn.date(from: String(raw.prefix(10))) else { return nil }
        let month = DateFormatter()
        month.dateFormat = "MMM"
        let day = DateFormatter()
        day.dateFormat = "d"
        return (month.string(from: date).uppercased(), day.string(from: date))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Text(dayParts?.month ?? "")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(booking.isPast ? Color.secondary : Brand.skyDark)
                Text(dayParts?.day ?? "-")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(booking.isPast ? Color.secondary : Color.primary)
            }
            .frame(width: 50, height: 54)
            .background(booking.isPast ? Brand.surface : Brand.sky.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                Text(booking.service).font(.headline)
                if let time = booking.time, !time.isEmpty {
                    Text(time).font(.subheadline).foregroundStyle(.secondary)
                }
                Text(booking.statusLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(booking.isPast ? Color.secondary : Brand.skyDark)
                if !booking.isPast, let progress = booking.progress {
                    ProgressTracker(progress: progress).padding(.top, 4)
                }
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - One booking

struct BookingDetailView: View {
    let ref: String
    @EnvironmentObject private var store: CustomerStore
    @Environment(\.openURL) private var openURL
    @State private var detail: BookingDetail?
    @State private var problem: String?
    @State private var rescheduling = false
    @State private var confirmCancel = false
    @State private var working = false

    var body: some View {
        ScrollView {
            if let detail {
                VStack(alignment: .leading, spacing: 16) {
                    heroCard(detail)
                    ForEach(detail.changeOrders) { order in
                        ChangeOrderCard(order: order) { await load() }
                    }
                    if detail.canReview || detail.myRating != nil {
                        RatingCard(ref: detail.ref, proName: detail.proFirstName, canReview: detail.canReview, given: detail.myRating) {
                            await load()
                        }
                    }
                    if detail.status == "completed" && detail.proFirstName != nil {
                        TipCard(ref: detail.ref)
                    }
                    if !detail.isPast { actionBar(detail) }
                    if let proposal = detail.proposal { proposalCard(detail, proposal) }
                    if detail.proFirstName != nil { proCard(detail) }
                    if !detail.isPast { photosCard(detail) }

                    if let url = detail.completionPhotoURL {
                        CustomerBlock(title: "Finished work") {
                            AsyncImage(url: url) { phase in
                                if let image = phase.image { image.resizable().scaledToFit() } else { Brand.surface.frame(height: 180) }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    if detail.status == "completed" && !detail.items.isEmpty {
                        Button {
                            if store.flow.rebook(detail.items) > 0 {
                                store.continueBooking()
                            } else {
                                store.banner = CustomerBanner(text: "Those items are no longer offered. Pick from Home.", kind: .problem)
                            }
                        } label: {
                            Label("Book this again", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }

                    if !detail.items.isEmpty { itemsCard(detail) }
                    if let payment = detail.payment, payment.totalCents > 0 { paymentCard(payment) }

                    if detail.isPast {
                        Button {
                            if let url = URL(string: "tel:" + Site.supportPhone) { openURL(url) }
                        } label: {
                            Label("Questions? Call \(Site.supportPhoneDisplay)", systemImage: "phone")
                                .font(.subheadline)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    if detail.canCancel {
                        Button(role: .destructive) { confirmCancel = true } label: {
                            Text("Cancel booking").font(.subheadline.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 4)
                    }
                    Text("Booking \(detail.ref)")
                        .font(.caption).foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity)
                }
                .padding(16)
            } else if let problem {
                VStack(spacing: 12) {
                    Text(problem).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { Task { await load() } }
                }
                .padding(32)
            } else {
                ProgressView().padding(40)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(detail?.service ?? "Booking")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $rescheduling) {
            if let detail {
                RescheduleSheet(detail: detail) { await load() }.environmentObject(store)
            }
        }
        .confirmationDialog("Cancel this booking?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel booking", role: .destructive) {
                Task {
                    working = true
                    _ = await store.perform("Your booking is cancelled.") { try await store.api.cancel(ref: ref) }
                    working = false
                    await load()
                }
            }
            Button("Keep booking", role: .cancel) {}
        } message: {
            Text(detail?.cancellation?.message ?? "")
        }
    }

    private func load() async {
        do {
            detail = try await store.api.booking(ref: ref)
            problem = nil
        } catch let error as AppError where error.isCancelled {
            return
        } catch {
            problem = error.localizedDescription
        }
    }

    /// What is happening, when and where: the first thing on the page.
    private func heroCard(_ detail: BookingDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(detail.statusLabel).font(.title3.bold())
                if let text = detail.statusDetail { Text(text).font(.subheadline).foregroundStyle(.secondary) }
            }
            if !detail.isPast, let progress = detail.progress {
                ProgressTracker(progress: progress)
            }
            Divider()
            if !detail.when.isEmpty {
                Label(detail.when, systemImage: "calendar").font(.subheadline)
            }
            if let address = detail.address, !address.isEmpty {
                Label(address, systemImage: "mappin.and.ellipse").font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(detail.isPast ? Color(uiColor: .separator) : Brand.sky, lineWidth: detail.isPast ? 1 : 2))
    }

    /// The everyday actions, side by side: message, call, change the time.
    private func actionBar(_ detail: BookingDetail) -> some View {
        HStack(spacing: 10) {
            NavigationLink {
                CustomerMessagesView(ref: detail.ref, recipient: detail.messageRecipient == "pro" ? (detail.proFirstName ?? "Your pro") : "AssembleAtEase")
            } label: {
                ActionTile(symbol: "bubble.left.fill", title: "Message")
            }
            Button {
                if let url = URL(string: "tel:" + Site.supportPhone) { openURL(url) }
            } label: {
                ActionTile(symbol: "phone.fill", title: "Call")
            }
            if detail.canReschedule {
                Button { rescheduling = true } label: {
                    ActionTile(symbol: "calendar.badge.clock", title: "Change time")
                }
            }
        }
        .buttonStyle(.plain)
    }

    /// Photos for the pro: their own card.
    private func photosCard(_ detail: BookingDetail) -> some View {
        NavigationLink {
            BookingPhotosView(ref: detail.ref)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "camera.fill")
                    .font(.title3)
                    .foregroundStyle(Brand.skyDark)
                    .frame(width: 44, height: 44)
                    .background(Brand.sky.opacity(0.16), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("Photos for your pro").font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                    Text("The space, the boxes or the wall").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(14)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func proposalCard(_ detail: BookingDetail, _ proposal: ProposedTime) -> some View {
        CustomerBlock(title: "\(detail.proFirstName ?? "Your pro") proposed a new time") {
            Label([Format.day(proposal.date), proposal.time].compactMap { $0 }.joined(separator: " · "), systemImage: "calendar.badge.clock")
                .font(.headline)
            if let note = proposal.note, !note.isEmpty { Text(note).font(.subheadline).foregroundStyle(.secondary) }
            Button {
                Task {
                    working = true
                    _ = await store.perform("Your booking moved to the new time.") {
                        try await store.api.reschedule(ref: detail.ref, date: proposal.date, time: proposal.time, proposalID: proposal.id)
                    }
                    working = false
                    await load()
                }
            } label: { Text("Accept new time") }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(working)
            Button("Keep my time") {
                Task {
                    working = true
                    _ = await store.perform("Your booked time stays the same.") {
                        try await store.api.keepBookedTime(ref: detail.ref, proposalID: proposal.id)
                    }
                    working = false
                    await load()
                }
            }
            .disabled(working)
        }
    }

    private func proCard(_ detail: BookingDetail) -> some View {
        CustomerBlock(title: "Your pro") {
            HStack(spacing: 12) {
                Avatar(photo: detail.proPhoto, name: detail.proFirstName, size: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(detail.proFirstName ?? "").font(.headline)
                    HStack(spacing: 10) {
                        if let rating = detail.proRating {
                            Label(String(format: "%.1f", rating), systemImage: "star.fill").foregroundStyle(Brand.skyDark)
                        }
                        if let jobs = detail.proJobs, jobs > 0 { Text("\(jobs) jobs") }
                        if detail.proVerified { Label("ID verified", systemImage: "checkmark.seal") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func itemsCard(_ detail: BookingDetail) -> some View {
        CustomerBlock(title: "What you booked") {
            ForEach(Array(detail.items.enumerated()), id: \.offset) { index, group in
                if index > 0 { Divider() }
                if detail.items.count > 1 { Text(group.label).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark) }
                ForEach(Array(group.items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline) {
                        Text(item.isAddOn ? "+ \(item.addOnName ?? item.name)" : (item.quantity > 1 ? "\(item.quantity) × \(item.name)" : item.name))
                            .font(.subheadline)
                        Spacer()
                        if let cents = item.lineTotalCents, cents > 0 {
                            Text(Format.money(cents: cents)).font(.subheadline).monospacedDigit()
                        }
                    }
                }
            }
        }
    }

    private func paymentCard(_ payment: PaymentSummary) -> some View {
        CustomerBlock(title: payment.totalLabel) {
            Text(Format.money(cents: payment.totalCents)).font(.title2.bold()).monospacedDigit()
            ForEach(Array(payment.rows.enumerated()), id: \.offset) { _, row in
                HStack {
                    Text(row.label).font(row.strong ? .subheadline.weight(.semibold) : .subheadline)
                    Spacer()
                    Text(Format.money(cents: row.cents)).font(row.strong ? .subheadline.weight(.semibold) : .subheadline).monospacedDigit()
                }
            }
            if let note = payment.note { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

/// Extra work the pro asked for: what it is, what it adds, approve or decline.
private struct ChangeOrderCard: View {
    let order: ChangeOrder
    let done: () async -> Void
    @EnvironmentObject private var store: CustomerStore
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Extra work needs your OK", systemImage: "exclamationmark.bubble.fill")
                .font(.headline)
                .foregroundStyle(Brand.skyDark)
            Text(order.summary).font(.subheadline)
            VStack(spacing: 6) {
                row("Additional work", order.subtotalCents)
                row("Sales tax", order.taxCents)
                Divider()
                row("Added to your total", order.totalCents, strong: true)
            }
            Text("Charged with the job when it is finished.").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button {
                    Task { await answer(false) }
                } label: { Text("Decline") }
                .buttonStyle(SecondaryButtonStyle())
                Button {
                    Task { await answer(true) }
                } label: {
                    if working { ProgressView().tint(Brand.ink) } else { Text("Approve") }
                }
                .buttonStyle(PrimaryButtonStyle(enabled: !working))
            }
            .disabled(working)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Brand.sky, lineWidth: 2))
    }

    private func row(_ label: String, _ cents: Double, strong: Bool = false) -> some View {
        HStack {
            Text(label).font(strong ? .subheadline.weight(.semibold) : .subheadline)
            Spacer()
            Text(Format.money(cents: cents)).font(strong ? .subheadline.weight(.semibold) : .subheadline).monospacedDigit()
        }
    }

    private func answer(_ approve: Bool) async {
        working = true
        defer { working = false }
        do {
            let verdict = try await store.api.answerChangeOrder(id: order.id, approve: approve)
            store.banner = CustomerBanner(text: verdict.message, kind: verdict.ok ? .success : .problem)
        } catch {
            store.banner = CustomerBanner(text: error.localizedDescription, kind: .problem)
        }
        await done()
    }
}

/// A tip for the pro after a finished job. It goes to the pro's own account.
private struct TipCard: View {
    let ref: String
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @State private var quote: TipQuote?
    @State private var cents = 1000
    @State private var working = false
    @State private var problem: String?

    private let choices = [500, 1000, 1500, 2000]

    var body: some View {
        Group {
            if let quote {
                VStack(alignment: .leading, spacing: 12) {
                    if let given = quote.alreadyTippedCents {
                        Label("You tipped \(quote.easerFirstName) \(Format.money(cents: given)). Thank you.", systemImage: "heart.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Brand.skyDark)
                    } else if !quote.canReceive {
                        if let reason = quote.reason { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                    } else {
                        Text("Tip \(quote.easerFirstName)").font(.headline)
                        HStack(spacing: 8) {
                            ForEach(choices, id: \.self) { value in
                                Button {
                                    cents = value
                                } label: {
                                    Text(wholeDollars(Double(value)))
                                        .font(.subheadline.weight(.semibold))
                                        .frame(maxWidth: .infinity)
                                        .frame(height: 44)
                                        .background(cents == value ? Brand.sky : Brand.surface,
                                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                        .foregroundStyle(cents == value ? Brand.ink : Color.primary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .sensoryFeedback(.selection, trigger: cents)
                        Button {
                            Task { await send() }
                        } label: {
                            if working { ProgressView().tint(Brand.ink) } else { Text("Send \(wholeDollars(Double(cents))) tip") }
                        }
                        .buttonStyle(PrimaryButtonStyle(enabled: !working))
                        .disabled(working)
                        Text("All of it goes to \(quote.easerFirstName).").font(.caption).foregroundStyle(.secondary)
                        if let problem { Text(problem).font(.footnote).foregroundStyle(Brand.attention) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
        .task { await load() }
    }

    private func load() async {
        quote = try? await store.api.tipQuote(ref: ref)
    }

    private func send() async {
        working = true
        problem = nil
        defer { working = false }
        do {
            let key = try await store.api.stripeKey()
            let start = try await store.api.startTip(ref: ref, cents: cents)
            let outcome = await CardSheet.present(.payment(start.clientSecret), publishableKey: key,
                                                  name: flow.name, email: store.email ?? "", phone: Format.e164(flow.phone) ?? "",
                                                  stripeAccount: start.stripeAccount)
            switch outcome {
            case .done:
                try await store.api.finishTip(ref: ref, succeeded: true)
                store.banner = CustomerBanner(text: "Your tip is on its way. Thank you.", kind: .success)
            case .cancelled:
                try? await store.api.finishTip(ref: ref, succeeded: false)
            case .failed(let reason):
                try? await store.api.finishTip(ref: ref, succeeded: false)
                problem = reason
            }
        } catch {
            problem = error.localizedDescription
        }
        await load()
    }
}

/// Rate a finished job: stars first, words optional. Once given, the rating shows.
private struct RatingCard: View {
    let ref: String
    let proName: String?
    let canReview: Bool
    let given: Int?
    let done: () async -> Void
    @EnvironmentObject private var store: CustomerStore
    @State private var stars = 0
    @State private var words = ""
    @State private var sending = false

    private var who: String { proName ?? "your pro" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let given, !canReview {
                Text("You rated \(who)").font(.subheadline.weight(.semibold))
                starRow(value: given, editable: false)
            } else {
                Text("How did \(who) do?").font(.headline)
                starRow(value: stars, editable: true)
                if stars > 0 {
                    TextField("Add a few words (optional)", text: $words, axis: .vertical)
                        .lineLimit(2...5)
                        .padding(10)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        Task { await submit() }
                    } label: {
                        if sending { ProgressView().tint(Brand.ink) } else { Text("Send rating") }
                    }
                    .buttonStyle(PrimaryButtonStyle(enabled: !sending))
                    .disabled(sending)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func starRow(value: Int, editable: Bool) -> some View {
        HStack(spacing: 10) {
            ForEach(1...5, id: \.self) { index in
                Image(systemName: index <= value ? "star.fill" : "star")
                    .font(.title)
                    .foregroundStyle(index <= value ? Brand.sky : Color(uiColor: .tertiaryLabel))
                    .onTapGesture { if editable { stars = index } }
                    .accessibilityLabel("\(index) star\(index == 1 ? "" : "s")")
                    .accessibilityAddTraits(editable ? AccessibilityTraits.isButton : AccessibilityTraits())
            }
        }
        .sensoryFeedback(.selection, trigger: stars)
    }

    private func submit() async {
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty && text.count < 10 {
            store.banner = CustomerBanner(text: "Write at least a sentence, or leave the words empty.", kind: .problem)
            return
        }
        sending = true
        defer { sending = false }
        let sent = await store.perform("Thanks. Your rating is in.") {
            try await store.api.review(ref: ref, rating: stars, body: text)
        }
        if sent { await done() }
    }
}

/// One of the booking page's everyday actions: an icon over a word, equal widths.
private struct ActionTile: View {
    let symbol: String
    let title: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: symbol).font(.title3).foregroundStyle(Brand.skyDark)
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 70)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// A titled card on a grouped page.
struct CustomerBlock<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// MARK: - Change the time

struct RescheduleSheet: View {
    let detail: BookingDetail
    let onDone: () async -> Void
    @EnvironmentObject private var store: CustomerStore
    @Environment(\.dismiss) private var dismiss
    @State private var day = Date()
    @State private var slot: String?
    @State private var working = false

    private var lastDay: Date {
        Calendar.current.date(byAdding: .day, value: max(1, detail.windowDays), to: Date()) ?? Date()
    }

    private static let iso: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Day", selection: $day, in: Date()...lastDay, displayedComponents: .date)
                        .datePickerStyle(.graphical)
                }
                Section("Time") {
                    ForEach(detail.slots, id: \.self) { option in
                        Button {
                            slot = option
                        } label: {
                            HStack {
                                Text(option).foregroundStyle(.primary)
                                Spacer()
                                if slot == option { Image(systemName: "checkmark").foregroundStyle(Brand.skyDark) }
                            }
                        }
                    }
                }
                if let message = detail.cancellation?.message {
                    Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Change the time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        guard let slot else { return }
                        working = true
                        Task {
                            let moved = await store.perform("Your booking moved to the new time.") {
                                try await store.api.reschedule(ref: detail.ref, date: Self.iso.string(from: day), time: slot)
                            }
                            working = false
                            if moved {
                                await onDone()
                                dismiss()
                            }
                        }
                    } label: {
                        if working { ProgressView() } else { Text("Save") }
                    }
                    .disabled(slot == nil || working)
                }
            }
        }
    }
}

// MARK: - Messages

struct CustomerMessagesView: View {
    let ref: String
    let recipient: String
    @EnvironmentObject private var store: CustomerStore
    @State private var messages: [CustomerMessage] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if loaded && messages.isEmpty {
                            Text("No messages yet.").foregroundStyle(.secondary).padding(.top, 40)
                        }
                        ForEach(messages) { message in
                            CustomerBubble(message: message).id(message.id)
                        }
                    }
                    .padding(16)
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .refreshable { await load() }

            VStack(spacing: 8) {
                if let problem { Text(problem).font(.footnote).foregroundStyle(Brand.attention) }
                HStack(alignment: .bottom, spacing: 10) {
                    TextField("Message \(recipient)", text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .padding(10)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                    }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send to \(recipient)")
                }
            }
            .padding(12)
            .background(.bar)
        }
        .navigationTitle(recipient)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            messages = try await store.api.messages(ref: ref)
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
        loaded = true
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            try await store.api.send(text, ref: ref)
            draft = ""
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

private struct CustomerBubble: View {
    let message: CustomerMessage
    var body: some View {
        HStack {
            if message.fromMe { Spacer(minLength: 40) }
            VStack(alignment: message.fromMe ? .trailing : .leading, spacing: 4) {
                Text(message.fromMe ? "You" : (message.sender == "assembler" ? "Your pro" : "AssembleAtEase"))
                    .font(.caption2).foregroundStyle(.secondary)
                Text(message.body)
                    .padding(12)
                    .background(message.fromMe ? Brand.sky.opacity(0.22) : Brand.surface,
                                in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                if let when = Format.relative(message.createdAt) {
                    Text(when).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            if !message.fromMe { Spacer(minLength: 40) }
        }
    }
}

// MARK: - Photos for the pro

struct BookingPhotosView: View {
    let ref: String
    @EnvironmentObject private var store: CustomerStore
    @State private var photos: [BookingPhoto] = []
    @State private var picked: PhotosPickerItem?
    @State private var uploading = false
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                Text("Photos of the space, the boxes or the wall help your pro arrive ready.")
                    .font(.subheadline).foregroundStyle(.secondary)
                PhotosPicker(selection: $picked, matching: .images) {
                    if uploading { ProgressView() } else { Label("Add a photo", systemImage: "plus") }
                }
                .disabled(uploading)
                if let problem { Text(problem).font(.footnote).foregroundStyle(Brand.attention) }
            }
            if !photos.isEmpty {
                Section("Shared with your pro") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 10)], spacing: 10) {
                        ForEach(photos) { photo in
                            AsyncImage(url: photo.url) { phase in
                                if let image = phase.image { image.resizable().scaledToFill() } else { Brand.surface }
                            }
                            .frame(width: 96, height: 96)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        .navigationTitle("Photos")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task { await upload(item) }
        }
    }

    private func load() async {
        do { photos = try await store.api.photos(ref: ref) } catch { problem = error.localizedDescription }
    }

    private func upload(_ item: PhotosPickerItem) async {
        uploading = true
        defer { uploading = false; picked = nil }
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            problem = "That photo could not be opened. Choose another."
            return
        }
        do {
            try await store.api.upload(image, ref: ref)
            problem = nil
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

// MARK: - Account

struct CustomerAccountView: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @Environment(\.openURL) private var openURL
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var deleting = false

    private var displayName: String {
        let saved = flow.name.trimmingCharacters(in: .whitespaces)
        if !saved.isEmpty { return saved }
        return store.firstName ?? "Your account"
    }

    private var initials: String {
        let letters = displayName.split(separator: " ").prefix(2).compactMap(\.first)
        return letters.isEmpty ? "A" : String(letters).uppercased()
    }

    private var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return "Version \(short) (\(build))"
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Text(initials)
                            .font(.title2.bold())
                            .foregroundStyle(Brand.ink)
                            .frame(width: 60, height: 60)
                            .background(Brand.sky, in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text(displayName).font(.title3.bold())
                            Text(store.email ?? "").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                }

                Section {
                    Button { store.tab = .activity } label: {
                        HStack {
                            accountRow("calendar", "Upcoming bookings")
                            Spacer()
                            Text("\(store.upcoming.count)").foregroundStyle(.secondary)
                        }
                    }
                    Button { store.tab = .activity } label: {
                        HStack {
                            accountRow("checkmark.circle", "Completed jobs")
                            Spacer()
                            Text("\(store.finishedJobs.count)").foregroundStyle(.secondary)
                        }
                    }
                }

                Section {
                    HStack {
                        accountRow("star.circle", "AssembleCash")
                        Spacer()
                        Text(wholeDollars(store.account?.assemblecashCents ?? 0)).foregroundStyle(.secondary).monospacedDigit()
                    }
                } footer: {
                    Text("Earned on completed jobs. It comes off your next booking at checkout.")
                }

                Section {
                    NavigationLink { YourDetailsView() } label: { accountRow("person.text.rectangle", "Your details") }
                } footer: {
                    Text("Your name, phone and address fill in each new booking.")
                }

                Section("Help") {
                    Button { openURL(Site.page("/contact")) } label: { accountRow("questionmark.circle", "Help and contact") }
                    Button {
                        if let url = URL(string: "tel:" + Site.supportPhone) { openURL(url) }
                    } label: { accountRow("phone", "Call \(Site.supportPhoneDisplay)") }
                    Button {
                        if let url = URL(string: "mailto:" + Site.supportEmail) { openURL(url) }
                    } label: { accountRow("envelope", "Email \(Site.supportEmail)") }
                }

                Section("About") {
                    Button { openURL(Site.page("/pricing")) } label: { accountRow("tag", "Prices") }
                    Button { openURL(Site.page("/about")) } label: { accountRow("info.circle", "About AssembleAtEase") }
                    Button { openURL(Site.page("/terms")) } label: { accountRow("doc.text", "Terms of Service") }
                    Button { openURL(Site.page("/privacy")) } label: { accountRow("hand.raised", "Privacy Policy") }
                }

                Section {
                    Button("Sign out") { confirmSignOut = true }
                    Button("Delete account", role: .destructive) { confirmDelete = true }
                        .disabled(deleting)
                } footer: {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Deleting your account removes your sign-in. Your bookings stay on record and remain open from your booking emails.")
                        Text(version)
                    }
                }
            }
            .navigationTitle("Account")
            .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { store.signOut() }
            }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) {
                    deleting = true
                    Task {
                        _ = await store.deleteAccount()
                        deleting = false
                    }
                }
            } message: {
                Text("You can sign in again later with the same email.")
            }
        }
    }

    private func accountRow(_ symbol: String, _ title: String) -> some View {
        Label {
            Text(title).foregroundStyle(.primary)
        } icon: {
            Image(systemName: symbol).foregroundStyle(Brand.skyDark)
        }
    }
}

/// The name, phone and address each new booking starts with. Kept on this phone.
private struct YourDetailsView: View {
    @EnvironmentObject private var store: CustomerStore
    @EnvironmentObject private var flow: BookingFlow
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Contact") {
                TextField("Full name", text: $flow.name).textContentType(.name)
                TextField("Phone", text: $flow.phone)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .onChange(of: flow.phone) { _, value in
                        let typed = Format.typingPhone(value)
                        if typed != value { flow.phone = typed }
                    }
                LabeledContent("Email", value: store.email ?? "")
            }
            Section("Home address") {
                TextField("Street address", text: $flow.street).textContentType(.streetAddressLine1)
                TextField("Apt, suite or unit", text: $flow.unit).textContentType(.streetAddressLine2)
                TextField("City", text: $flow.city).textContentType(.addressCity)
                TextField("ZIP code", text: $flow.zip)
                    .textContentType(.postalCode)
                    .keyboardType(.numberPad)
            }
        }
        .navigationTitle("Your details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    flow.saveDetails()
                    store.banner = CustomerBanner(text: "Your details are saved.", kind: .success)
                    dismiss()
                }
            }
        }
    }
}
