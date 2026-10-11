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

/// Name, phone, location, email. Verified facts are plain text; the phone is the
/// one input, saved from the top bar where the keyboard cannot cover it.
/// Mirrors assembler/profile.html; the server decides what may change.
struct PersonalInfoView: View {
    init() {}

    @EnvironmentObject private var store: EaserStore
    @State private var fullName = ""
    @State private var phone = ""
    @State private var city = ""
    @State private var state = ""
    @State private var zip = ""
    @State private var loaded = false
    @State private var saving = false
    @State private var confirmReset = false

    private var locked: Bool { store.profile?.identityVerified == true }

    private var changed: Bool {
        guard let me = store.profile else { return false }
        func same(_ a: String, _ b: String?) -> Bool { a.trimmingCharacters(in: .whitespacesAndNewlines) == (b ?? "") }
        return Format.phoneDigits(phone) != Format.phoneDigits(me.phone ?? "") || (!locked && (!same(fullName, me.fullName) || !same(city, me.city) || !same(state, me.state) || !same(zip, me.zip)))
    }

    var body: some View {
        List {
            Section {
                if locked {
                    LabeledContent("Name", value: fullName.isEmpty ? "Not set" : fullName)
                    LabeledField(label: "Phone", text: $phone, locked: false, content: .telephoneNumber, keyboard: .phonePad)
                    LabeledContent("Location", value: location)
                } else {
                    LabeledField(label: "Full name", text: $fullName, locked: false, content: .name)
                    LabeledField(label: "Phone", text: $phone, locked: false, content: .telephoneNumber, keyboard: .phonePad)
                    LabeledField(label: "City", text: $city, locked: false, content: .addressCity)
                    LabeledField(label: "State", text: $state, locked: false, content: .addressState)
                    LabeledField(label: "ZIP", text: $zip, locked: false, content: .postalCode, keyboard: .numberPad)
                }
                LabeledContent("Email", value: store.email ?? "On file")
                if let since = Format.day(store.profile?.createdAt) {
                    LabeledContent("Member since", value: since)
                }
            } footer: {
                if locked {
                    Text("For changes, contact AssembleAtEase.")
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
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if changed {
                    Button {
                        saving = true
                        Task {
                            _ = await store.saveDetails(fullName: fullName, phone: phone, city: city, state: state, zip: zip)
                            saving = false
                            fill()
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Save").fontWeight(.semibold) }
                    }
                    .disabled(saving)
                }
            }
        }
        .refreshable {
            await store.refresh()
            fill()
        }
        .task {
            if !loaded { fill(); loaded = true }
        }
        .confirmationDialog("Send a password reset email?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Send email") { Task { await store.sendPasswordReset() } }
        } message: {
            Text("We'll email \(store.email ?? "you") a link to set a new password.")
        }
    }

    /// "Austin, TX 78745", leaving out what is not on file.
    private var location: String {
        let cityState = [city, state].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ", ")
        let full = [cityState, zip.trimmingCharacters(in: .whitespaces)].filter { !$0.isEmpty }.joined(separator: " ")
        return full.isEmpty ? "Not set" : full
    }

    private func fill() {
        guard let me = store.profile else { return }
        fullName = me.fullName ?? ""
        phone = Format.phone(me.phone)
        city = me.city ?? ""
        state = me.state ?? ""
        zip = me.zip ?? ""
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

private struct LabeledField: View {
    let label: String
    @Binding var text: String
    let locked: Bool
    let content: UITextContentType
    var keyboard: UIKeyboardType = .default

    var body: some View {
        HStack {
            Text(label).frame(width: 90, alignment: .leading)
            if locked {
                Text(text.isEmpty ? "Not set" : text).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "lock.fill").font(.caption).foregroundStyle(.tertiary)
            } else {
                TextField(label, text: $text)
                    .textContentType(content)
                    .keyboardType(keyboard)
            }
        }
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
