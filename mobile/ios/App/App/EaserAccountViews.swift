import SwiftUI
import UIKit

// MARK: - Profile

/// The Easer's profile: photo, level, stats, contact details, identity, reviews.
/// Mirrors assembler/profile.html; the server decides what may change.
struct ProfileView: View {
    init() {}

    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var fullName = ""
    @State private var phone = ""
    @State private var city = ""
    @State private var state = ""
    @State private var zip = ""
    @State private var loaded = false
    @State private var saving = false
    @State private var changingPhoto = false
    @State private var confirmReset = false

    private var locked: Bool { store.profile?.identityVerified == true }

    private var changed: Bool {
        guard let me = store.profile else { return false }
        func same(_ a: String, _ b: String?) -> Bool { a.trimmingCharacters(in: .whitespacesAndNewlines) == (b ?? "") }
        return !same(phone, me.phone) || (!locked && (!same(fullName, me.fullName) || !same(city, me.city) || !same(state, me.state) || !same(zip, me.zip)))
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Avatar(photo: store.profile?.profilePhoto, name: store.profile?.fullName, size: 96)
                    Text(store.profile?.fullName ?? "Easer").font(.title2.bold())
                    Text(store.profile?.levelLabel ?? "Easer")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Brand.sky.opacity(0.18), in: Capsule())
                        .foregroundStyle(Brand.skyDark)
                    Button("Change photo") { changingPhoto = true }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }

            Section {
                HStack {
                    Stat(value: "\(store.earnings?.summary?.completedJobs ?? 0)", label: "Jobs done")
                    Divider()
                    Stat(value: ratingText, label: "Rating")
                    Divider()
                    Stat(value: Format.money(cents: store.earnings?.summary?.totalEarnedCents ?? 0), label: "Earned")
                }
            }

            Section {
                LabeledField(label: "Full name", text: $fullName, locked: locked, content: .name)
                LabeledField(label: "Phone", text: $phone, locked: false, content: .telephoneNumber, keyboard: .phonePad)
                LabeledField(label: "City", text: $city, locked: locked, content: .addressCity)
                LabeledField(label: "State", text: $state, locked: locked, content: .addressState)
                LabeledField(label: "ZIP", text: $zip, locked: locked, content: .postalCode, keyboard: .numberPad)
                if changed {
                    Button {
                        saving = true
                        Task {
                            _ = await store.saveDetails(fullName: fullName, phone: phone, city: city, state: state, zip: zip)
                            saving = false
                            fill()
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Save changes").fontWeight(.semibold) }
                    }
                    .disabled(saving)
                }
            } header: {
                Text("Contact details")
            } footer: {
                if locked {
                    Text("Your verified name and location are locked. Contact \(Site.supportEmail) if they need to be corrected.")
                }
            }

            Section("Account and security") {
                LabeledContent("Email", value: store.email ?? "On file")
                LabeledContent("Identity") {
                    Text(locked ? "Verified" : "Not verified")
                        .foregroundStyle(locked ? Brand.skyDark : Brand.attention)
                }
                if !locked {
                    Button("Verify your identity") { openURL(Site.page("/assembler/verify-identity")) }
                }
                if let since = Format.day(store.profile?.createdAt) {
                    LabeledContent("Member since", value: since)
                }
                Button("Reset password") { confirmReset = true }
            }

            Section("Reviews") {
                if store.reviews.isEmpty {
                    Text("Reviews from customers will appear here.").foregroundStyle(.secondary)
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
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await store.refresh()
            await store.loadProfileExtras()
            fill()
        }
        .task {
            if !loaded { fill(); loaded = true }
            await store.loadProfileExtras()
        }
        .confirmationDialog("Send a password reset email?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Send email") { Task { await store.sendPasswordReset() } }
        } message: {
            Text("We'll email \(store.email ?? "you") a link to set a new password.")
        }
        .sheet(isPresented: $changingPhoto) { ProfilePhotoSheet().environmentObject(store) }
    }

    private var ratingText: String {
        guard let rating = store.profile?.rating, (store.profile?.reviewCount ?? 0) > 0 else { return "New" }
        return String(format: "%.1f", rating)
    }

    private func fill() {
        guard let me = store.profile else { return }
        fullName = me.fullName ?? ""
        phone = me.phone ?? ""
        city = me.city ?? ""
        state = me.state ?? ""
        zip = me.zip ?? ""
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

            if let connect = store.connect {
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
                        Text("Bank details are entered on Stripe's secure page, never in this app.")
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
                            Text("Usually arrives within 30 minutes. Or wait and get the full \(Format.money(cents: quote.grossCents)) free on the standard schedule. The fee is charged by Stripe; AssembleAtEase adds nothing.")
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
                        Text("AssembleAtEase pays you after each completed job and confirms the payment details with you.")
                    }
                }
            } else if store.payoutsProblem == nil {
                Section { HStack { ProgressView(); Text("Loading payout setup").foregroundStyle(.secondary) } }
            }

            Section {
                NavigationLink("Earnings history") { EarningsHistoryView() }
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
                Text("Earnings from completed jobs will appear here.").foregroundStyle(.secondary)
            }
            ForEach(rows) { EarningRow(earning: $0) }
        }
        .navigationTitle("Earnings history")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.refresh() }
    }
}
