import SwiftUI
import PhotosUI
import MapKit
import UIKit

struct JobRef: Identifiable, Hashable { let id: String }

// MARK: - Root

struct EaserRootView: View {
    @StateObject private var store = EaserStore()
    @ObservedObject private var relay = PushRelay.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {}

    var body: some View {
        ZStack(alignment: .top) {
            switch store.phase {
            case .launching:
                LaunchView()
            case .signedOut:
                SignInView()
            case .signedIn:
                MainTabsView()
            }
            if let banner = store.banner {
                BannerView(banner: banner)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { store.banner = nil }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.banner)
        .environmentObject(store)
        .environment(\.openURL, InAppBrowser.action {
            store.browserCloses += 1
            if store.phase == .signedIn { Task { await store.refresh() } }
        })
        .tint(Brand.skyDark)
        .task { await store.start() }
        .task(id: store.banner?.id) {
            guard store.banner != nil else { return }
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            store.banner = nil
        }
        .onChange(of: relay.fcmToken) { _, token in
            Task { await store.pushTokenChanged(token) }
        }
        .onChange(of: store.phase) { _, phase in
            if phase == .signedIn { Task { await store.pushTokenChanged(relay.fcmToken) } }
        }
        .onChange(of: scenePhase) { _, phase in
            store.appActive = phase == .active
            if phase == .active && store.phase == .signedIn {
                Task {
                    await store.refresh()
                    await store.refreshAlertStatus(registerIfAllowed: true)
                }
            }
        }
        .onChange(of: relay.arrivals) { _, _ in
            if store.phase == .signedIn { Task { await store.refresh() } }
        }
        .task(id: store.phase) {
            // Offers expire in minutes: while the app is open and signed in, jobs reload every minute.
            guard store.phase == .signedIn else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                if Task.isCancelled { break }
                if store.appActive { await store.refreshJobs() }
            }
        }
    }
}

private struct LaunchView: View {
    var body: some View {
        VStack(spacing: 14) {
            BrandLogo(size: 88)
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}

private struct BannerView: View {
    let banner: Banner
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: banner.kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(banner.kind == .success ? Brand.skyDark : Brand.attention)
            Text(banner.text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Sign in

private struct SignInView: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""
    @State private var working = false
    @State private var problem: String?
    @State private var confirmReset = false

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    BrandLogo(size: 96)
                        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
                        .padding(.bottom, 6)
                    Text("Easer")
                        .font(.system(size: 36, weight: .bold))
                    Text("by AssembleAtEase")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                    Text("Your job offers, schedule and earnings.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 36)
                .padding(.bottom, 6)

                VStack(spacing: 12) {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(14)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .padding(14)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if let problem {
                    Text(problem)
                        .font(.subheadline)
                        .foregroundStyle(Brand.attention)
                        .multilineTextAlignment(.center)
                }

                Button {
                    Task { await submit() }
                } label: {
                    if working { ProgressView().tint(Brand.ink) } else { Text("Sign in") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working)

                Button("Forgot password?") { forgotPassword() }
                    .font(.subheadline.weight(.semibold))

                VStack(spacing: 10) {
                    Text("Want to work with AssembleAtEase?")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("Apply to become an Easer") { openURL(Site.page("/assembler/apply")) }
                        .buttonStyle(SecondaryButtonStyle())
                }
                .padding(.top, 26)
            }
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
        .confirmationDialog("Reset your password?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Send reset link") { Task { await sendReset() } }
        } message: {
            Text("We'll email \(email.trimmingCharacters(in: .whitespacesAndNewlines)) a link to set a new password.")
        }
    }

    private func forgotPassword() {
        let clean = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.contains("@") else {
            problem = "Enter your email above, then tap Forgot password."
            return
        }
        problem = nil
        confirmReset = true
    }

    private func sendReset() async {
        let clean = email.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await store.api.sendPasswordReset(to: clean)
            store.banner = Banner(text: "Check \(clean) for a link to set a new password.", kind: .success)
        } catch {
            problem = error.localizedDescription
        }
    }

    private func submit() async {
        working = true
        problem = nil
        defer { working = false }
        do {
            try await store.signIn(email: email, password: password)
            password = ""
        } catch {
            problem = error.localizedDescription
        }
    }
}

// MARK: - Tabs

private struct MainTabsView: View {
    @EnvironmentObject private var store: EaserStore
    @ObservedObject private var relay = PushRelay.shared
    @State private var linkedJob: JobRef?
    @State private var reloadedFor: String?

    var body: some View {
        TabView(selection: $store.tab) {
            TodayView()
                .tabItem { Label("Today", systemImage: "sun.max") }
                .tag(AppTab.today)
            JobsView()
                .tabItem { Label("Jobs", systemImage: "briefcase") }
                .tag(AppTab.jobs)
            EarningsView()
                .tabItem { Label("Earnings", systemImage: "dollarsign.circle") }
                .tag(AppTab.earnings)
            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray") }
                .badge(store.unreadCount)
                .tag(AppTab.inbox)
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(AppTab.account)
        }
        // A tapped job notification opens that job, not a generic screen.
        .onChange(of: relay.openJobID) { _, id in openLinkedJob(id) }
        .onChange(of: store.jobs) { _, _ in openLinkedJob(relay.openJobID) }
        .onAppear { openLinkedJob(relay.openJobID) }
        .sheet(item: $linkedJob) { ref in
            NavigationStack {
                JobDetailView(jobID: ref.id)
                    .environmentObject(store)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { linkedJob = nil }
                        }
                    }
            }
        }
    }

    private func openLinkedJob(_ id: String?) {
        guard let id else { return }
        if store.job(id) != nil {
            linkedJob = JobRef(id: id)
            relay.openJobID = nil
            reloadedFor = nil
            return
        }
        guard store.loadedOnce else { return }
        if reloadedFor == id {
            // Still not on this account after a fresh load: taken by another Easer or withdrawn.
            relay.openJobID = nil
            reloadedFor = nil
            store.banner = Banner(text: "That job is no longer available.", kind: .problem)
            return
        }
        reloadedFor = id
        Task {
            await store.refresh()
            openLinkedJob(relay.openJobID)
        }
    }
}

// MARK: - Today

private struct TodayView: View {
    @EnvironmentObject private var store: EaserStore

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // Until setup is done the server refuses to put an Easer online,
                    // so the switch is not offered; the steps come first.
                    if !store.needsSetup { AvailabilityCard() }
                    RequiredActionsCard()
                    ReliabilityCard()
                    SetupCard()
                    if let problem = store.loadProblem, store.jobs.isEmpty, !store.jobsLocked {
                        NoticeCard(icon: "wifi.exclamationmark", title: "Jobs could not be loaded", text: problem)
                    }
                    if let active = store.activeJob {
                        SectionTitle("Right now")
                        NavigationLink(value: JobRef(id: active.id)) { JobCard(job: active, emphasis: true) }
                            .buttonStyle(.plain)
                    }
                    if !store.offers.isEmpty {
                        SectionTitle(store.offers.count == 1 ? "New offer" : "New offers")
                        ForEach(store.offers) { job in
                            NavigationLink(value: JobRef(id: job.id)) { JobCard(job: job, emphasis: store.activeJob == nil) }
                                .buttonStyle(.plain)
                        }
                    }
                    if let next = store.upcoming.first {
                        SectionTitle("Up next")
                        NavigationLink(value: JobRef(id: next.id)) { JobCard(job: next, emphasis: false) }
                            .buttonStyle(.plain)
                    }
                    if store.loadedOnce && !store.jobsLocked && store.activeJob == nil && store.offers.isEmpty && store.upcoming.isEmpty && store.loadProblem == nil {
                        EmptyTodayCard(online: store.profile?.isAvailable == true)
                    }
                }
                .padding(16)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Hi, \(store.profile?.firstName ?? "there")")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Avatar(photo: store.profile?.profilePhoto, name: store.profile?.fullName, size: 34)
                }
            }
            .navigationDestination(for: JobRef.self) { JobDetailView(jobID: $0.id) }
            .refreshable { await store.refresh() }
        }
    }
}

private struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.title3.bold()).padding(.top, 4)
    }
}

private struct AvailabilityCard: View {
    @EnvironmentObject private var store: EaserStore

    private var online: Bool { store.profile?.isAvailable == true }

    var body: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(online ? Color.green : Color.gray.opacity(0.5))
                .frame(width: 12, height: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(online ? "You're online" : "You're offline")
                    .font(.headline)
                Text(online ? "Job offers are on." : "Go online to get job offers.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.availabilityBusy || store.profile == nil {
                ProgressView()
            } else {
                Toggle("Available for jobs", isOn: Binding(
                    get: { online },
                    set: { value in Task { await store.setAvailable(value) } }
                ))
                .labelsHidden()
                .disabled(store.profile == nil || store.profile?.closureHeld == true)
            }
        }
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// Shown only when a real step blocks job offers. Every step is done inside the
/// app; only Stripe's identity check opens Stripe's own page.
/// Remaining setup items, each with its action where the app can do it.
private struct SetupItemRows: View {
    @EnvironmentObject private var store: EaserStore
    let items: [String]
    @State private var working = false
    @State private var uploadingPhoto = false

    var body: some View {
        ForEach(items, id: \.self) { item in
            if item.lowercased().contains("profile photo") {
                VStack(alignment: .leading, spacing: 6) {
                    Label(item, systemImage: "person.crop.circle.badge.exclamationmark").font(.subheadline.weight(.semibold))
                    if let note = store.readiness?.photoRequestNote, !note.isEmpty {
                        Text(note).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Button("Upload new photo") { uploadingPhoto = true }
                        .buttonStyle(PrimaryButtonStyle())
                }
                .sheet(isPresented: $uploadingPhoto) { ProfilePhotoSheet().environmentObject(store) }
            } else if item.lowercased().contains("job texts") {
                VStack(alignment: .leading, spacing: 6) {
                    Label(item, systemImage: "circle").font(.subheadline).foregroundStyle(.secondary)
                    Button {
                        working = true
                        Task {
                            await store.setTextAlerts(true)
                            working = false
                        }
                    } label: {
                        if working { ProgressView().tint(Brand.ink) } else { Text("Turn on job texts") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(working)
                    Text("Message and data rates may apply. Reply STOP to any text to turn texts off.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Label(item, systemImage: "circle").font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

private struct SetupCard: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var signing = false
    @State private var startingVerification = false

    private var needsSetup: Bool { store.needsSetup }

    /// Items the three steps below do not already cover, in the server's words.
    /// Going online is not a setup step: the online switch handles it.
    private var otherItems: [String] {
        let covered = ["contractor agreement", "code of conduct", "identity", "approv"]
        return store.setupItems.filter { item in
            !covered.contains { item.lowercased().contains($0) }
        }
    }

    var body: some View {
        if store.profile?.closureHeld == true {
            NoticeCard(icon: "person.crop.circle.badge.xmark", title: "Account closure requested",
                       text: "Your request is in review.")
        } else if store.readiness?.suspended == true {
            NoticeCard(icon: "pause.circle", title: "Your account is paused",
                       text: "Contact \(Site.supportEmail) to reactivate it.")
        } else if needsSetup, let setup = store.setup,
                  setup.requiresAgreement || !setup.identityVerified || !setup.approved {
            VStack(alignment: .leading, spacing: 14) {
                Text("Finish setting up to get jobs").font(.headline)
                SetupStep(number: 1, done: !setup.requiresAgreement,
                          title: "Sign the contractor agreement and Code of Conduct",
                          detail: setup.priorAgreementOnFile && setup.requiresAgreement ? "An updated version needs your signature." : nil) {
                    Button("Review and sign") { signing = true }
                        .buttonStyle(PrimaryButtonStyle())
                }
                SetupStep(number: 2, done: setup.identityVerified,
                          title: "Verify your identity",
                          detail: setup.requiresAgreement ? "Available after step 1." : "A quick ID and selfie check with Stripe.") {
                    if !setup.requiresAgreement {
                        Button {
                            startingVerification = true
                            Task {
                                if let url = await store.identityVerificationLink() { openURL(url) }
                                startingVerification = false
                            }
                        } label: {
                            if startingVerification { ProgressView().tint(Brand.ink) } else { Text("Verify identity") }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(startingVerification)
                    }
                }
                SetupStep(number: 3, done: setup.approved,
                          title: "Approval by AssembleAtEase",
                          detail: setup.approved ? nil : "We review your account and email you when you're approved.") {
                    EmptyView()
                }
                if !otherItems.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Also needed").font(.subheadline.weight(.semibold))
                        SetupItemRows(items: otherItems)
                    }
                }
            }
            .padding(16)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .sheet(isPresented: $signing) { AgreementSheet(legalName: setup.fullName).environmentObject(store) }
        } else if needsSetup {
            VStack(alignment: .leading, spacing: 10) {
                Label("Action needed", systemImage: "exclamationmark.circle").font(.headline)
                SetupItemRows(items: store.setupItems)
            }
            .padding(16)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        } else if !store.newOffersAllowed {
            VStack(alignment: .leading, spacing: 10) {
                NoticeCard(icon: "pause.circle", title: "New offers are paused",
                           text: store.offersPausedReason ?? "Your scheduled jobs are still here. Contact \(Site.supportEmail) to find out what is needed.")
                if store.offersPausedCode == "current_agreement_required" {
                    Button("Review and sign the agreement") { signing = true }
                        .buttonStyle(PrimaryButtonStyle())
                }
            }
            .sheet(isPresented: $signing) { AgreementSheet(legalName: store.profile?.fullName ?? "").environmentObject(store) }
        }
    }
}

private struct SetupStep<Action: View>: View {
    let number: Int
    let done: Bool
    let title: String
    let detail: String?
    @ViewBuilder let action: Action

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(done ? Brand.sky : Brand.surface).frame(width: 28, height: 28)
                if done {
                    Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(Brand.ink)
                } else {
                    Text("\(number)").font(.caption.bold()).foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(done ? .secondary : .primary)
                if let detail, !done { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                if !done { action }
            }
            Spacer(minLength: 0)
        }
    }
}

/// The contractor agreement and Code of Conduct, signed in the app with the same
/// wording and server step as assembler/verify-identity.html.
private struct AgreementSheet: View {
    let legalName: String
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var typedName = ""
    @State private var agreeContract = false
    @State private var agreeConduct = false
    @State private var working = false

    /// The first thing still missing, in the order the form asks for it.
    private var blockedReason: String? {
        if typedName.trimmingCharacters(in: .whitespaces).isEmpty { return "Type your full name to sign." }
        if !nameMatches { return legalName.isEmpty ? "Your account name could not be loaded." : "Your name must match \(legalName) exactly." }
        if !agreeContract || !agreeConduct { return "Turn on both agreements to continue." }
        return nil
    }

    private var nameMatches: Bool {
        return !legalName.isEmpty && Self.normalized(typedName) == Self.normalized(legalName)
    }

    /// Same comparison as the server: trimmed, single spaces, case-insensitive.
    private static func normalized(_ value: String) -> String {
        value.lowercased().split(separator: " ").joined(separator: " ")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Read both documents, then sign below.")
                    Button("Read the Independent Contractor Agreement") { openURL(Site.page("/assembler/contractor-agreement")) }
                    Button("Read the Code of Conduct and Terms of Service") { openURL(Site.page("/terms")) }
                }
                Section {
                    TextField("Full legal name", text: $typedName)
                        .textContentType(.name)
                        .autocorrectionDisabled()
                } header: {
                    Text("Sign with your full legal name")
                } footer: {
                    if legalName.isEmpty {
                        Text("Your account name could not be loaded. Close this and pull down on Today to refresh.")
                    } else {
                        Text("Name on your account: \(legalName). For changes, contact AssembleAtEase.")
                    }
                }
                Section {
                    Toggle(isOn: $agreeContract) {
                        Text("I have read the Independent Contractor Agreement in full and agree to be legally bound by its terms.")
                            .font(.subheadline)
                    }
                    Toggle(isOn: $agreeConduct) {
                        Text("I agree to the AssembleAtEase Code of Conduct and Terms of Service, and I understand identity verification is required before I can receive jobs.")
                            .font(.subheadline)
                    }
                }
                Section {
                    Button {
                        working = true
                        Task {
                            let next = await store.signAgreement(fullName: typedName)
                            working = false
                            if store.setup?.requiresAgreement == false || next != nil {
                                dismiss()
                                if let next { openURL(next) }
                            }
                        }
                    } label: {
                        if working { ProgressView() } else { Text("Sign and continue").fontWeight(.semibold) }
                    }
                    .disabled(blockedReason != nil || working)
                } footer: {
                    // A disabled button always says what it is waiting for.
                    if let blockedReason { Text(blockedReason) }
                }
            }
            .navigationTitle("Contractor agreement")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(working) }
            }
        }
        .interactiveDismissDisabled(working)
    }
}

private struct NoticeCard: View {
    let icon: String
    let title: String
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(Brand.attention)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct EmptyTodayCard: View {
    let online: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: online ? "checkmark.circle" : "moon.zzz")
                .font(.title)
                .foregroundStyle(Brand.skyDark)
            Text(online ? "You're all caught up" : "Nothing scheduled")
                .font(.headline)
            Text(online ? "New offers will appear here, and as a notification." : "Go online to start receiving job offers.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct JobCard: View {
    let job: EaserJob
    let emphasis: Bool
    @EnvironmentObject private var store: EaserStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                StatusPill(text: job.statusLabel, strong: job.needsAcceptance || job.isActive)
                Spacer()
                if job.isOffer, job.offerExpiresAt != nil {
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        if let left = Format.timeLeft(until: job.offerExpiresAt, now: context.date) {
                            Text(left).font(.caption.weight(.semibold)).foregroundStyle(Brand.attention)
                        }
                    }
                }
            }
            HStack(alignment: .firstTextBaseline) {
                Text(job.title)
                    .font(emphasis ? Font.title3.bold() : Font.headline)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer()
                Text(store.payText(for: job))
                    .font(emphasis ? Font.title3.bold() : Font.headline)
                    .foregroundStyle(.primary)
            }
            if let work = job.workSummary {
                Label(work, systemImage: "shippingbox").font(.subheadline).foregroundStyle(.secondary)
            }
            if !job.when.isEmpty {
                Label(job.when, systemImage: "calendar").font(.subheadline).foregroundStyle(.secondary)
            }
            Label(job.place, systemImage: "mappin.and.ellipse")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack {
                Text(actionHint).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark)
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(emphasis ? Brand.sky : Color(uiColor: .separator), lineWidth: emphasis ? 2 : 1)
        )
    }

    private var actionHint: String {
        switch job.nextStep {
        case .accept: return "Review offer"
        case .startTravel: return "Start travel when you leave"
        case .arrived: return "Check in when you arrive"
        case .startJob: return "Start the job"
        case .complete: return "Complete the job"
        case .noAction: return "View details"
        }
    }
}

private struct StatusPill: View {
    let text: String
    let strong: Bool
    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(strong ? Brand.sky.opacity(0.18) : Brand.surface, in: Capsule())
            .foregroundStyle(strong ? Brand.skyDark : Color.secondary)
    }
}

// MARK: - Jobs

private struct JobsView: View {
    enum Segment: String, CaseIterable, Identifiable {
        case offers = "Offers", upcoming = "Upcoming", past = "Past"
        var id: String { rawValue }
    }
    @EnvironmentObject private var store: EaserStore
    @State private var segment: Segment = .upcoming

    private var rows: [EaserJob] {
        switch segment {
        case .offers: return store.offers
        case .upcoming: return store.jobs.filter { $0.isActive } + store.upcoming
        case .past: return store.past
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Picker("Show", selection: $segment) {
                    ForEach(Segment.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))

                if rows.isEmpty {
                    Text(emptyText)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(rows) { job in
                        NavigationLink(value: JobRef(id: job.id)) { JobRow(job: job) }
                    }
                }
            }
            .navigationTitle("Jobs")
            .navigationDestination(for: JobRef.self) { JobDetailView(jobID: $0.id) }
            .refreshable { await store.refresh() }
            .onAppear { if !store.offers.isEmpty && segment == .upcoming && store.upcoming.isEmpty { segment = .offers } }
        }
    }

    private var emptyText: String {
        if store.jobsLocked { return "Your setup steps are on Today." }
        switch segment {
        case .offers: return "No offers right now."
        case .upcoming: return "No upcoming jobs."
        case .past: return "Completed jobs will appear here."
        }
    }
}

private struct JobRow: View {
    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(job.title).font(.headline)
                Spacer()
                Text(store.payText(for: job)).font(.subheadline.weight(.semibold))
            }
            Text([job.when, job.statusLabel].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Job detail

private enum PhotoSheetMode: String, Identifiable {
    case completion, requested, damage
    var id: String { rawValue }
}

struct JobDetailView: View {
    let jobID: String
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var confirmDecline = false
    @State private var photoSheet: PhotoSheetMode?
    @State private var releasing = false
    @State private var customerPhotos: [CustomerPhoto] = []
    @State private var helping = false
    @State private var addingWork = false
    @State private var proposingTime = false
    @State private var ratingCustomer = false
    @State private var choosingMapsApp = false
    @AppStorage(NavigationApp.storageKey) private var navigationApp = ""

    var body: some View {
        Group {
            if let job = store.job(jobID) {
                content(job)
            } else {
                ContentUnavailableView("This job is no longer available", systemImage: "briefcase")
            }
        }
        .navigationTitle("Job")
        .navigationBarTitleDisplayMode(.inline)
        // Accept, travel and complete own the bottom of the screen, as on Uber and DoorDash.
        .toolbar(.hidden, for: .tabBar)
    }

    @ViewBuilder
    private func content(_ job: EaserJob) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    StatusPill(text: job.statusLabel, strong: job.needsAcceptance || job.isActive)
                    Text(job.title).font(.title2.bold())
                    // What is being built, not only the service name.
                    if let work = job.workSummary {
                        Text(work).font(.headline).foregroundStyle(.primary)
                    }
                    if let ref = job.ref { Text(ref).font(.footnote).foregroundStyle(.secondary) }
                }

                if job.acceptedAt != nil && !job.isHelper {
                    DetailBlock(title: "Progress") { JobProgress(job: job) }
                }

                if job.photosRequested {
                    DetailBlock(title: "Photos requested") {
                        Text("AssembleAtEase needs another photo of this job.")
                            .foregroundStyle(.secondary)
                        Button {
                            photoSheet = .requested
                        } label: {
                            Label("Add photo", systemImage: "camera")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                }

                DetailBlock(title: job.isFinished ? "Earnings" : "Estimated earnings") {
                    Text(store.payText(for: job)).font(.largeTitle.bold())
                    if job.isFinished, let earned = store.earning(for: job) {
                        Text(earned.statusLabel).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark)
                    }
                    if !job.isFinished, let hi = job.payEstimateHiCents, let lo = job.payEstimateCents, hi > lo {
                        Text("Up to \(Format.money(cents: hi))").font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let bonus = job.sameDayBonusCents, bonus > 0 {
                        Label("Includes \(Format.money(cents: bonus)) same-day bonus", systemImage: "bolt.fill")
                            .font(.subheadline).foregroundStyle(Brand.skyDark)
                    }
                    if job.crewSize > 1 {
                        Label("Crew of \(job.crewSize)", systemImage: "person.2")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if job.isOffer, let left = Format.timeLeft(until: job.offerExpiresAt) {
                        Text(left).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.attention)
                    }
                    if let tips = job.tips, tips.count > 0 {
                        Label("Tip \(Format.money(cents: tips.amountCents))", systemImage: "heart.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark)
                        Text(tips.feePending ? "Paid to your Stripe account." : "You keep \(Format.money(cents: tips.netCents)) after Stripe's fee.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }

                DetailBlock(title: "When and where") {
                    if !job.isFinished {
                        JobMapCard(query: job.place, exact: job.acceptedAt != nil && job.address != nil)
                    }
                    if let previous = job.previousSlot, !job.isFinished {
                        Label("Moved from \([Format.day(previous.date), previous.time].compactMap { $0 }.joined(separator: " · "))", systemImage: "arrow.uturn.backward")
                            .font(.subheadline).foregroundStyle(Brand.attention)
                    }
                    if !job.when.isEmpty { Label(job.when, systemImage: "calendar") }
                    Label(job.place, systemImage: "mappin.and.ellipse")
                    if job.acceptedAt != nil, let address = job.address, !job.isFinished {
                        Button {
                            if let app = NavigationApp(rawValue: navigationApp) {
                                Directions.open(address, in: app)
                            } else {
                                choosingMapsApp = true
                            }
                        } label: {
                            Label("Directions", systemImage: "arrow.triangle.turn.up.right.diamond")
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .confirmationDialog("Open directions in", isPresented: $choosingMapsApp, titleVisibility: .visible) {
                            ForEach(NavigationApp.allCases) { app in
                                Button(app.title) {
                                    navigationApp = app.rawValue
                                    Directions.open(address, in: app)
                                }
                            }
                        } message: {
                            Text("Change this any time in Account.")
                        }
                    }
                }

                if !job.itemGroups.isEmpty {
                    DetailBlock(title: "What you're assembling") {
                        ForEach(Array(job.itemGroups.enumerated()), id: \.offset) { index, group in
                            if index > 0 { Divider() }
                            if let label = group.label, job.itemGroups.count > 1 || label != job.title {
                                Text(label).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark)
                            }
                            ForEach(Array(group.items.enumerated()), id: \.offset) { _, item in
                                ScopeRow(item: item)
                            }
                        }
                    }
                }

                if let details = job.details, !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    DetailBlock(title: "Notes from the customer") { Text(details) }
                }

                if !customerPhotos.isEmpty {
                    DetailBlock(title: "Photos from the customer") {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(customerPhotos) { photo in
                                    if let url = photo.url {
                                        Link(destination: url) {
                                            AsyncImage(url: url) { phase in
                                                if let image = phase.image {
                                                    image.resizable().scaledToFill()
                                                } else {
                                                    Brand.surface
                                                }
                                            }
                                            .frame(width: 104, height: 104)
                                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                        }
                                        .accessibilityLabel("Open customer photo")
                                    }
                                }
                            }
                        }
                    }
                }

                if job.acceptedAt != nil && !job.isFinished {
                    DetailBlock(title: "Contact") {
                        if let name = job.customerName { Label(name, systemImage: "person") }
                        if let phone = job.customerPhone, let url = URL(string: "tel:" + phone.filter { "+0123456789".contains($0) }) {
                            Button { openURL(url) } label: { Label("Call customer", systemImage: "phone") }
                        }
                        NavigationLink {
                            MessagesView(job: job, thread: .customer)
                        } label: {
                            Label("Message customer", systemImage: "bubble.left.and.bubble.right")
                        }
                        NavigationLink {
                            MessagesView(job: job, thread: .team)
                        } label: {
                            Label("Message AssembleAtEase", systemImage: "questionmark.bubble")
                        }
                    }
                }

                if job.acceptedAt != nil && job.isFinished {
                    DetailBlock(title: "Messages") {
                        NavigationLink {
                            MessagesView(job: job, thread: .customer)
                        } label: {
                            Label("Conversation with the customer", systemImage: "bubble.left.and.bubble.right")
                        }
                        NavigationLink {
                            MessagesView(job: job, thread: .team)
                        } label: {
                            Label("Message AssembleAtEase", systemImage: "questionmark.bubble")
                        }
                    }
                }

                // The rest of the job: proposed time, customer not here, extra work,
                // changes, help and the customer rating (owner audit, 2026-10-12).
                Group {
                    if let proposal = job.timeProposal, proposal.isPending, !job.isFinished {
                        DetailBlock(title: "New time you proposed") {
                            Label([Format.day(proposal.date), proposal.time].compactMap { $0 }.joined(separator: " · "), systemImage: "calendar.badge.clock")
                            Text("Waiting on the customer.").font(.subheadline).foregroundStyle(.secondary)
                            Button("Withdraw") { Task { await store.withdrawTimeProposal(job) } }
                                .buttonStyle(.borderless)
                        }
                    }

                    if job.status == "arrived" && job.acceptedAt != nil && !job.isHelper {
                        CustomerNotHereBlock(job: job)
                    }

                    if !job.extraWork.isEmpty {
                        DetailBlock(title: "Extra work") {
                            ForEach(job.extraWork) { request in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(request.description).font(.subheadline)
                                    Text(request.statusLabel).font(.caption.weight(.semibold))
                                        .foregroundStyle(request.approved ? Brand.skyDark : .secondary)
                                }
                            }
                        }
                    }

                    if job.acceptedAt != nil && !job.isFinished && !job.isHelper {
                        DetailBlock(title: "Job changes") {
                            if job.status == "confirmed" || job.status == "en_route" {
                                Menu {
                                    ForEach([10, 20, 30], id: \.self) { minutes in
                                        Button("\(minutes) minutes") { Task { await store.runningLate(job, minutes: minutes) } }
                                    }
                                } label: {
                                    Label("Running late", systemImage: "clock.badge.exclamationmark")
                                }
                            }
                            if job.status == "confirmed" && job.timeProposal?.isPending != true {
                                Button { proposingTime = true } label: { Label("Propose a new time", systemImage: "calendar.badge.clock") }
                            }
                            Button { addingWork = true } label: { Label("Add work", systemImage: "plus.circle") }
                        }
                    }

                    if job.acceptedAt != nil {
                        DetailBlock(title: "Something wrong?") {
                            if !job.isFinished {
                                Button { helping = true } label: { Label("Get help with this job", systemImage: "questionmark.circle") }
                            }
                            Button {
                                photoSheet = .damage
                            } label: {
                                Label("Report damage", systemImage: "exclamationmark.triangle")
                            }
                            if job.canRelease {
                                Button(role: .destructive) {
                                    releasing = true
                                } label: {
                                    Label("I can't make this job", systemImage: "calendar.badge.minus")
                                }
                            }
                        }
                    }

                    if job.status == "completed" {
                        DetailBlock(title: "How was the customer?") {
                            if let feedback = job.customerFeedback {
                                if feedback.flagged {
                                    Label("You flagged a concern", systemImage: "flag.fill").foregroundStyle(Brand.attention)
                                }
                                if let rating = feedback.rating {
                                    Label("You rated them \(rating) of 5", systemImage: "star.fill").foregroundStyle(Brand.skyDark)
                                }
                            } else {
                                Text("Only AssembleAtEase sees this.").font(.subheadline).foregroundStyle(.secondary)
                                Button { ratingCustomer = true } label: { Label("Rate the customer", systemImage: "star") }
                            }
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .refreshable {
            await store.refresh()
            await loadCustomerPhotos(job)
        }
        .task(id: job.acceptedAt) { await loadCustomerPhotos(job) }
        .safeAreaInset(edge: .bottom) { actionBar(job) }
        .confirmationDialog("Why are you declining?", isPresented: $confirmDecline, titleVisibility: .visible) {
            ForEach(EaserStore.declineReasons) { reason in
                Button(reason.label) { Task { await store.decline(job, reason: reason.code) } }
            }
            Button("Decline without a reason") { Task { await store.decline(job, reason: nil) } }
            Button("Keep offer", role: .cancel) {}
        }
        .sheet(item: $photoSheet) { mode in PhotoSheet(job: job, mode: mode).environmentObject(store) }
        .sheet(isPresented: $releasing) { ReleaseSheet(job: job).environmentObject(store) }
        .sheet(isPresented: $helping) {
            HelpSheet(job: job) {
                helping = false
                releasing = true
            }
            .environmentObject(store)
        }
        .sheet(isPresented: $addingWork) { AddWorkSheet(job: job).environmentObject(store) }
        .sheet(isPresented: $proposingTime) { ProposeTimeSheet(job: job).environmentObject(store) }
        .sheet(isPresented: $ratingCustomer) { RateCustomerSheet(job: job).environmentObject(store) }
    }

    /// Customer photos are shown once the job is accepted, as on the website.
    private func loadCustomerPhotos(_ job: EaserJob) async {
        guard job.acceptedAt != nil else { customerPhotos = []; return }
        customerPhotos = await store.customerPhotos(for: job)
    }

    @ViewBuilder
    private func actionBar(_ job: EaserJob) -> some View {
        let busy = store.busyJobs.contains(job.id)
        VStack(spacing: 10) {
            if busy {
                ProgressView().frame(maxWidth: .infinity, minHeight: 52)
            } else {
                switch job.nextStep {
                case .accept:
                    HStack(spacing: 12) {
                        if job.canDecline {
                            Button("Decline") { confirmDecline = true }
                                .buttonStyle(SecondaryButtonStyle())
                        }
                        Button("Accept job") { Task { await store.accept(job) } }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                case .startTravel, .arrived, .startJob:
                    if let opens = Format.clock(job.nextStepOpensAt) {
                        Button("Opens at \(opens)") {}
                            .buttonStyle(PrimaryButtonStyle(enabled: false))
                            .disabled(true)
                    } else if job.nextStep == .startTravel {
                        Button("Start travel") { Task { await store.startTravel(job) } }
                            .buttonStyle(PrimaryButtonStyle())
                    } else if job.nextStep == .arrived {
                        Button("I've arrived") { Task { await store.arrived(job) } }
                            .buttonStyle(PrimaryButtonStyle())
                    } else {
                        Button("Start job") { Task { await store.startJob(job) } }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                case .complete:
                    Button("Complete job") { photoSheet = .completion }
                        .buttonStyle(PrimaryButtonStyle())
                case .noAction:
                    if job.isHelper && !job.isFinished {
                        Text("The lead Easer updates this job's progress.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, job.nextStep == .noAction && !job.isHelper ? 0 : 12)
        .background(job.nextStep == .noAction && !job.isHelper ? AnyShapeStyle(Color.clear) : AnyShapeStyle(Material.bar))
        .overlay(alignment: .top) {
            if !(job.nextStep == .noAction && !job.isHelper) { Divider() }
        }
    }
}

// MARK: - The rest of the job (owner audit, 2026-10-12)

/// Help from inside a job, the same requests the website's support panel sends
/// (api/booking/message.js supportType). Customer-not-home has its own card.
private struct HelpSheet: View {
    let job: EaserJob
    let openRelease: () -> Void
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var topic: String?
    @State private var note = ""
    @State private var sending = false
    @State private var problem: String?

    private var topics: [(type: String, title: String)] {
        EaserStore.helpTopics.filter { $0.type != "customer_unavailable" }
    }

    private var canSend: Bool {
        guard let topic, !sending else { return false }
        let length = note.trimmingCharacters(in: .whitespacesAndNewlines).count
        switch topic {
        case "safety_concern": return length >= 10
        case "cannot_make": return true
        default: return length >= 3
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        if let url = URL(string: "tel:" + Site.supportPhone) { openURL(url) }
                    } label: {
                        Label("Call AssembleAtEase", systemImage: "phone")
                    }
                }
                Section("What do you need help with?") {
                    ForEach(Array(topics.enumerated()), id: \.offset) { _, item in
                        Button {
                            if item.type == "cannot_make" && job.canRelease {
                                openRelease()
                            } else {
                                topic = item.type
                                problem = nil
                            }
                        } label: {
                            HStack {
                                Text(item.title).foregroundStyle(.primary)
                                Spacer()
                                if topic == item.type {
                                    Image(systemName: "checkmark").foregroundStyle(Brand.skyDark)
                                }
                            }
                        }
                    }
                }
                if let topic {
                    if topic == "safety_concern" {
                        Section {
                            Text("If anyone is in danger, call 911. Move to a safe place first.")
                                .foregroundStyle(Brand.attention)
                        }
                    }
                    Section {
                        TextField(topic == "safety_concern" ? "What is happening" : "Add details", text: $note, axis: .vertical)
                            .lineLimit(3...6)
                    } footer: {
                        if let problem { Text(problem).foregroundStyle(Brand.attention) }
                    }
                }
            }
            .navigationTitle("Get help")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                if topic != nil {
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView().tint(Brand.ink) } else { Text(topic == "safety_concern" ? "Send urgent report" : "Send") }
                    }
                    .buttonStyle(PrimaryButtonStyle(enabled: canSend))
                    .disabled(!canSend)
                    .padding(16)
                    .background(.bar)
                }
            }
        }
    }

    private func send() async {
        guard let topic else { return }
        sending = true
        problem = await store.requestHelp(job, type: topic, note: note)
        sending = false
        if problem == nil { dismiss() }
    }
}

/// Customer isn't here: tell the customer and wait, then report a no-show
/// (api/booking/customer-unavailable.js). The clock is the server's.
private struct CustomerNotHereBlock: View {
    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        DetailBlock(title: "Customer isn't here?") {
            if let state = job.customerUnavailable {
                if state.noShowReportedAt != nil {
                    Label("No-show reported. You can leave.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Brand.skyDark)
                    Text("AssembleAtEase confirms it with the customer.").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let left = max(0, Int((state.waitEnds ?? context.date).timeIntervalSince(context.date)))
                        VStack(alignment: .leading, spacing: 10) {
                            if left > 0 {
                                Text("The customer was told you're here.")
                                Text("Wait \(left / 60):\(String(format: "%02d", left % 60))")
                                    .font(.title3.monospacedDigit().weight(.semibold))
                            } else {
                                Text("The wait is over.")
                            }
                            Button {
                                Task { await act("no_show") }
                            } label: {
                                if working { ProgressView().tint(Brand.ink) } else { Text("Report a no-show") }
                            }
                            .buttonStyle(PrimaryButtonStyle(enabled: left == 0 && !working))
                            .disabled(left > 0 || working)
                        }
                    }
                }
            } else {
                Text("Tell the customer you're here and wait 15 minutes.").font(.subheadline).foregroundStyle(.secondary)
                Button {
                    Task { await act("start") }
                } label: {
                    if working { ProgressView() } else { Text("Customer isn't here") }
                }
                .buttonStyle(SecondaryButtonStyle())
                .disabled(working)
            }
            if let problem {
                Text(problem).font(.footnote).foregroundStyle(Brand.attention)
            }
        }
    }

    private func act(_ action: String) async {
        working = true
        problem = await store.customerUnavailable(job, action: action)
        working = false
    }
}

/// Add work on site: pick catalog items; the customer approves before anything is
/// charged (api/booking/extra-work.js). No prices on this screen (Rule 3).
private struct AddWorkSheet: View {
    struct Picked: Identifiable, Hashable {
        let service: String
        let name: String
        var qty: Int
        var id: String { service + "|" + name }
    }

    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var options: ExtraWorkOptions?
    @State private var loading = true
    @State private var search = ""
    @State private var picked: [Picked] = []
    @State private var note = ""
    @State private var sending = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let options, !options.canAdd {
                    ContentUnavailableView("Extra work can't be added here", systemImage: "plus.circle",
                                           description: Text(options.reason ?? "Use Get help on this job."))
                } else if let options {
                    List {
                        if !picked.isEmpty {
                            Section {
                                ForEach($picked) { $item in
                                    Stepper(value: $item.qty, in: 1...20) {
                                        Text("\(item.name) ×\(item.qty)")
                                    }
                                }
                                .onDelete { picked.remove(atOffsets: $0) }
                                TextField("Note for the customer (optional)", text: $note, axis: .vertical)
                                    .lineLimit(1...4)
                            } header: {
                                Text("Adding")
                            } footer: {
                                if let problem {
                                    Text(problem).foregroundStyle(Brand.attention)
                                } else {
                                    Text("The customer gets a request to approve.")
                                }
                            }
                        }
                        ForEach(filtered(options.services)) { service in
                            Section(service.name) {
                                ForEach(service.items) { item in
                                    Button {
                                        toggle(service: service.name, name: item.name)
                                    } label: {
                                        HStack {
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(item.name).foregroundStyle(.primary)
                                                if let group = item.group {
                                                    Text(group).font(.caption).foregroundStyle(.secondary)
                                                }
                                            }
                                            Spacer()
                                            if picked.contains(where: { $0.service == service.name && $0.name == item.name }) {
                                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Brand.skyDark)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .searchable(text: $search, prompt: "Search items")
                } else {
                    ContentUnavailableView("Could not load the catalog", systemImage: "wifi.exclamationmark",
                                           description: Text("Close this and try again."))
                }
            }
            .navigationTitle("Add work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                if !picked.isEmpty {
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView().tint(Brand.ink) } else { Text("Send to the customer") }
                    }
                    .buttonStyle(PrimaryButtonStyle(enabled: !sending))
                    .disabled(sending)
                    .padding(16)
                    .background(.bar)
                }
            }
            .task {
                options = await store.extraWorkOptions(job)
                loading = false
            }
        }
    }

    private func filtered(_ services: [ExtraWorkService]) -> [ExtraWorkService] {
        let term = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !term.isEmpty else { return services }
        return services.compactMap { service in
            let items = service.items.filter { $0.name.lowercased().contains(term) || ($0.group ?? "").lowercased().contains(term) }
            return items.isEmpty ? nil : ExtraWorkService(name: service.name, items: items)
        }
    }

    private func toggle(service: String, name: String) {
        if let index = picked.firstIndex(where: { $0.service == service && $0.name == name }) {
            picked.remove(at: index)
        } else {
            picked.append(Picked(service: service, name: name, qty: 1))
        }
        problem = nil
    }

    private func send() async {
        sending = true
        problem = await store.requestExtraWork(job, items: picked.map { (service: $0.service, name: $0.name, qty: $0.qty) }, note: note)
        sending = false
        if problem == nil { dismiss() }
    }
}

/// Propose a new time instead of dropping the job. The customer accepts it on
/// their booking page (api/booking/time-proposal.js).
private struct ProposeTimeSheet: View {
    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var options: TimeProposalOptions?
    @State private var loading = true
    @State private var date = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    @State private var slot = ""
    @State private var note = ""
    @State private var sending = false
    @State private var problem: String?

    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private func lastDay(_ options: TimeProposalOptions) -> Date {
        Calendar.current.date(byAdding: .day, value: max(1, options.windowDays), to: Date()) ?? Date()
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let options, !options.canPropose {
                    ContentUnavailableView("A new time can't be proposed", systemImage: "calendar.badge.clock",
                                           description: Text(options.reason ?? "Use Get help on this job."))
                } else if let options {
                    Form {
                        Section {
                            DatePicker("Date", selection: $date, in: Date()...lastDay(options), displayedComponents: .date)
                            Picker("Time", selection: $slot) {
                                ForEach(options.slots, id: \.self) { Text($0).tag($0) }
                            }
                        } header: {
                            Text("Booked: \(job.when)")
                        }
                        Section {
                            TextField("Note for the customer (optional)", text: $note, axis: .vertical)
                                .lineLimit(1...4)
                        } footer: {
                            if let problem {
                                Text(problem).foregroundStyle(Brand.attention)
                            } else {
                                Text("The customer accepts it or keeps the booked time.")
                            }
                        }
                    }
                } else {
                    ContentUnavailableView("Could not load", systemImage: "wifi.exclamationmark",
                                           description: Text("Close this and try again."))
                }
            }
            .navigationTitle("Propose a new time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                if options?.canPropose == true {
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView().tint(Brand.ink) } else { Text("Send to the customer") }
                    }
                    .buttonStyle(PrimaryButtonStyle(enabled: !slot.isEmpty && !sending))
                    .disabled(slot.isEmpty || sending)
                    .padding(16)
                    .background(.bar)
                }
            }
            .task {
                options = await store.timeProposalOptions(job)
                if slot.isEmpty { slot = options?.slots.first ?? "" }
                loading = false
            }
        }
    }

    private func send() async {
        sending = true
        problem = await store.proposeTime(job, date: Self.isoDay.string(from: date), time: slot, note: note)
        sending = false
        if problem == nil { dismiss() }
    }
}

/// The Easer's private rating of the customer (api/booking/customer-feedback.js).
private struct RateCustomerSheet: View {
    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var rating = 0
    @State private var flagging = false
    @State private var reason = ""
    @State private var note = ""
    @State private var saving = false
    @State private var problem: String?

    private var ready: Bool {
        if saving { return false }
        if flagging {
            return !reason.isEmpty && (reason != "other" || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        return rating > 0
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        ForEach(1...5, id: \.self) { star in
                            Button {
                                rating = star
                            } label: {
                                Image(systemName: star <= rating ? "star.fill" : "star")
                                    .font(.title2)
                                    .foregroundStyle(star <= rating ? Brand.sky : Color.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(star) of 5")
                        }
                    }
                    .frame(maxWidth: .infinity)
                } header: {
                    Text("How was working with this customer?")
                } footer: {
                    Text("Only AssembleAtEase sees this.")
                }
                Section {
                    Toggle("Flag a concern", isOn: $flagging)
                    if flagging {
                        Picker("What happened", selection: $reason) {
                            Text("Choose").tag("")
                            ForEach(Array(EaserStore.customerFlagReasons.enumerated()), id: \.offset) { _, flag in Text(flag.label).tag(flag.code) }
                        }
                    }
                    TextField("Add details (optional)", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                } footer: {
                    if let problem { Text(problem).foregroundStyle(Brand.attention) }
                }
            }
            .navigationTitle("Rate the customer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await save() }
                } label: {
                    if saving { ProgressView().tint(Brand.ink) } else { Text("Save") }
                }
                .buttonStyle(PrimaryButtonStyle(enabled: ready))
                .disabled(!ready)
                .padding(16)
                .background(.bar)
            }
        }
    }

    private func save() async {
        saving = true
        problem = await store.rateCustomer(job, rating: rating > 0 ? rating : nil, flagReason: flagging ? reason : nil, note: note)
        saving = false
        if problem == nil { dismiss() }
    }
}

/// One item of the job: name and count, the service it was booked under, and an
/// Add-on mark, as the website's job sheet shows it.
private struct ScopeRow: View {
    let item: JobItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.quantity > 1 ? "\(item.name) ×\(item.quantity)" : item.name)
                    .font(.body.weight(.medium))
                if let detail = item.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if item.isAddOn {
                Text("Add-on")
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Brand.sky.opacity(0.15), in: Capsule())
                    .foregroundStyle(Brand.skyDark)
            }
        }
    }
}

/// Shown once when a job is completed: the check, the job, the estimate.
private struct JobCompleteView: View {
    let done: CompletedJob
    let finish: () -> Void
    @State private var appeared = false

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(Brand.sky)
                .symbolEffect(.bounce, value: appeared)
            Text("Job complete").font(.title2.bold())
            Text(done.title).font(.headline).foregroundStyle(.secondary)
            if let pay = done.pay {
                Text("Estimated earnings \(pay)").font(.subheadline)
            }
            Button("Done", action: finish)
                .buttonStyle(PrimaryButtonStyle())
                .padding(.top, 8)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { appeared = true }
    }
}

/// Accepted, On the way, Arrived, Started, Done, with the time each happened.
private struct JobProgress: View {
    let job: EaserJob

    var body: some View {
        let steps: [(String, String?)] = [
            ("Accepted", job.acceptedAt),
            ("On the way", job.enRouteAt),
            ("Arrived", job.arrivedAt),
            ("Started", job.startedAt),
            ("Done", job.status == "completed" ? (job.completedAt ?? job.startedAt) : nil),
        ]
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 12) {
                    VStack(spacing: 0) {
                        Circle()
                            .fill(step.1 != nil ? Brand.sky : Color.gray.opacity(0.3))
                            .frame(width: 12, height: 12)
                        if index < steps.count - 1 {
                            Rectangle()
                                .fill(steps[index + 1].1 != nil ? Brand.sky : Color.gray.opacity(0.25))
                                .frame(width: 2, height: 22)
                        }
                    }
                    Text(step.0)
                        .font(.subheadline.weight(step.1 != nil ? .semibold : .regular))
                        .foregroundStyle(step.1 != nil ? Color.primary : Color.secondary)
                    Spacer()
                    if let time = Format.clock(step.1) {
                        Text(time).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            }
        }
    }
}

/// A map of the job: the exact spot once accepted, the area before.
private struct JobMapCard: View {
    let query: String
    let exact: Bool
    @State private var coordinate: CLLocationCoordinate2D?
    @State private var notFound = false

    var body: some View {
        Group {
            if notFound {
                EmptyView()
            } else if coordinate == nil {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Brand.surface)
                    .frame(height: 130)
                    .overlay(ProgressView())
            } else if let coordinate {
                Map(initialPosition: .region(MKCoordinateRegion(center: coordinate,
                                                                latitudinalMeters: exact ? 700 : 5000,
                                                                longitudinalMeters: exact ? 700 : 5000)),
                    interactionModes: []) {
                    if exact {
                        Marker("Job", coordinate: coordinate)
                            .tint(Brand.skyDark)
                    } else {
                        MapCircle(center: coordinate, radius: 1200)
                            .foregroundStyle(Brand.sky.opacity(0.25))
                    }
                }
                .frame(height: 130)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityLabel(exact ? "Map of the job address" : "Map of the job area")
            }
        }
        .task(id: query) {
            guard !query.isEmpty else { return }
            if let place = try? await CLGeocoder().geocodeAddressString(query).first, let location = place.location {
                coordinate = location.coordinate
            } else {
                notFound = true
            }
        }
    }
}

/// The maps app an Easer drives with, chosen once and kept on this phone.
enum NavigationApp: String, CaseIterable, Identifiable {
    case apple
    case google

    static let storageKey = "navigationApp"
    var id: String { rawValue }
    var title: String { self == .apple ? "Apple Maps" : "Google Maps" }
}

/// Turn-by-turn to a job address, opened in the maps app itself. Opened with
/// UIApplication rather than openURL, which shows web links inside the app.
enum Directions {
    static func open(_ address: String, in app: NavigationApp) {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?#")
        let destination = address.addingPercentEncoding(withAllowedCharacters: allowed) ?? address
        let link: String
        switch app {
        case .apple: link = "maps://?daddr=\(destination)&dirflg=d"
        // The Google Maps universal link opens the Google Maps app when it is installed.
        case .google: link = "https://www.google.com/maps/dir/?api=1&destination=\(destination)&travelmode=driving"
        }
        if let url = URL(string: link) { UIApplication.shared.open(url) }
    }
}

/// What the platform needs from the Easer, each with the one button that does it.
private struct RequiredActionsCard: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var working: String?
    @State private var showingPayouts = false

    /// Notifications are how offers arrive; shown only once iOS has answered.
    private var alertsNeeded: Bool { store.alertsChecked && store.alertsAuthorized != true }

    var body: some View {
        if !store.openRequiredActions.isEmpty || alertsNeeded {
            VStack(alignment: .leading, spacing: 14) {
                Label("Action needed", systemImage: "exclamationmark.circle").font(.headline)
                if alertsNeeded {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(store.alertsAuthorized == false ? "Notifications are off" : "Turn on notifications")
                            .font(.subheadline.weight(.semibold))
                        Text("Job offers arrive as notifications.").font(.subheadline).foregroundStyle(.secondary)
                        Button(store.alertsAuthorized == false ? "Open Settings" : "Turn on") {
                            if store.alertsAuthorized == false {
                                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                            } else {
                                Task { await store.requestAlertsIfNeeded() }
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                    if !store.openRequiredActions.isEmpty { Divider() }
                }
                ForEach(store.openRequiredActions) { action in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(action.title).font(.subheadline.weight(.semibold))
                        if !action.body.isEmpty {
                            Text(action.body).font(.subheadline).foregroundStyle(.secondary)
                        }
                        button(for: action)
                    }
                    if action.id != store.openRequiredActions.last?.id { Divider() }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .sheet(isPresented: $showingPayouts) {
                NavigationStack { PayoutsView() }.environmentObject(store)
            }
        }
    }

    @ViewBuilder
    private func button(for action: RequiredAction) -> some View {
        if action.rule == "payout_setup_incomplete" {
            Button(action.actionLabel ?? "Set up payouts") { showingPayouts = true }
                .buttonStyle(PrimaryButtonStyle())
        } else if action.ackRequired {
            if let url = link(action.actionURL) {
                Button("Read it") { openURL(url) }.buttonStyle(SecondaryButtonStyle())
            }
            Button {
                working = action.id
                Task {
                    await store.acknowledge(action)
                    working = nil
                }
            } label: {
                if working == action.id { ProgressView().tint(Brand.ink) } else { Text(action.actionLabel ?? "I understand") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(working != nil)
        } else if let url = link(action.actionURL) {
            Button(action.actionLabel ?? "Open") { openURL(url) }.buttonStyle(PrimaryButtonStyle())
        }
    }

    /// A site path ("/assembler/payouts") or a full link, as a URL.
    private func link(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.hasPrefix("/") { return Site.page(raw) }
        return URL(string: raw)
    }
}

private struct DetailBlock<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// MARK: - Photos: completion, requested, damage

private struct PhotoSheet: View {
    let job: EaserJob
    let mode: PhotoSheetMode
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var photo: UIImage?
    @State private var note = ""
    @State private var submitting = false

    private var title: String {
        switch mode {
        case .completion: return "Complete job"
        case .requested: return "Add photo"
        case .damage: return "Report damage"
        }
    }

    private var explanation: String {
        switch mode {
        case .completion: return "Add a photo of the finished work."
        case .requested: return "Add the photo AssembleAtEase asked for."
        case .damage: return "Add a photo of the damage and describe what happened."
        }
    }

    private var noteReady: Bool { note.trimmingCharacters(in: .whitespacesAndNewlines).count >= 10 }
    private var ready: Bool { photo != nil && (mode != .damage || noteReady) }

    var body: some View {
        // The completion moment replaces the form in the same sheet.
        if mode == .completion, let done = store.justCompleted, done.id == job.id {
            JobCompleteView(done: done) {
                store.justCompleted = nil
                dismiss()
            }
            .onDisappear { if store.justCompleted?.id == job.id { store.justCompleted = nil } }
        } else {
            form
        }
    }

    private var form: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(explanation).foregroundStyle(.secondary)
                    PhotoChooser(photo: $photo)
                    if mode == .damage {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("What happened").font(.headline)
                            TextField("Describe the damage", text: $note, axis: .vertical)
                                .lineLimit(3...6)
                                .padding(12)
                                .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            if !note.isEmpty && !noteReady {
                                Text("Add a little more detail.").font(.footnote).foregroundStyle(Brand.attention)
                            }
                        }
                    }
                }
                .padding(16)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    guard let photo else { return }
                    submitting = true
                    Task {
                        let done: Bool
                        switch mode {
                        case .completion: done = await store.complete(job, photo: photo)
                        case .requested: done = await store.sendPhoto(photo, for: job, damageNote: nil)
                        case .damage: done = await store.sendPhoto(photo, for: job, damageNote: note.trimmingCharacters(in: .whitespacesAndNewlines))
                        }
                        submitting = false
                        if done && mode != .completion { dismiss() }
                    }
                } label: {
                    if submitting {
                        ProgressView().tint(Brand.ink)
                    } else if photo == nil {
                        Text("Add a photo to continue")
                    } else if !ready {
                        Text("Describe what happened")
                    } else {
                        Text(mode == .completion ? "Submit completion" : (mode == .damage ? "Send report" : "Send photo"))
                    }
                }
                .buttonStyle(PrimaryButtonStyle(enabled: ready))
                .disabled(!ready || submitting)
                .padding(16)
                .background(.bar)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(submitting)
                }
            }
        }
        .interactiveDismissDisabled(submitting)
    }
}

/// Take a photo or choose one. Camera access is asked for only when the Easer taps Take photo.
private struct PhotoChooser: View {
    @Binding var photo: UIImage?
    @State private var pickerItem: PhotosPickerItem?
    @State private var showCamera = false

    var body: some View {
        VStack(spacing: 12) {
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    showCamera = true
                } label: {
                    Label(photo == nil ? "Take photo" : "Retake photo", systemImage: "camera")
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            PhotosPicker(selection: $pickerItem, matching: .images) {
                Label("Choose from library", systemImage: "photo.on.rectangle")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(Brand.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .foregroundStyle(.primary)
        }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                    photo = image
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(image: $photo).ignoresSafeArea()
        }
    }
}

// MARK: - Releasing a job

private struct ReleaseSheet: View {
    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var impactText: String?
    @State private var impactProblem: String?
    @State private var reason = ""
    @State private var note = ""
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("You'll be removed from this job.")
                    if let impactText {
                        Text(impactText).foregroundStyle(Brand.attention)
                    } else if let impactProblem {
                        Text(impactProblem).foregroundStyle(.secondary)
                    } else {
                        HStack { ProgressView(); Text("Loading").foregroundStyle(.secondary) }
                    }
                }
                Section("Reason") {
                    Picker("Reason", selection: $reason) {
                        Text("Choose a reason").tag("")
                        ForEach(EaserStore.releaseReasons, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section("Anything else (optional)") {
                    TextField("Tell us anything else we should know", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    Button(role: .destructive) {
                        working = true
                        Task {
                            let done = await store.release(job, reason: reason, note: note)
                            working = false
                            if done { dismiss() }
                        }
                    } label: {
                        if working { ProgressView() } else { Text("Cancel this job") }
                    }
                    .disabled(reason.isEmpty || working)
                } footer: {
                    if reason.isEmpty { Text("Choose a reason to continue.") }
                }
            }
            .navigationTitle("Can't make this job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Keep job") { dismiss() }.disabled(working) }
            }
            .task {
                do {
                    if let impact = try await store.releaseImpact(job) {
                        impactText = impact.text
                    } else {
                        impactProblem = "The reliability cost could not be loaded. Cancelling within 24 hours of the job counts as a strike."
                    }
                } catch {
                    impactProblem = error.localizedDescription
                }
            }
        }
        .interactiveDismissDisabled(working)
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.image = info[.originalImage] as? UIImage
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

// MARK: - Messages

private struct MessagesView: View {
    let job: EaserJob
    @EnvironmentObject private var store: EaserStore
    @State private var thread: MessageThread
    @State private var messages: [JobMessage] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var loaded = false

    init(job: EaserJob, thread: MessageThread) {
        self.job = job
        _thread = State(initialValue: thread)
    }

    private var shown: [JobMessage] { messages.filter { $0.thread == thread } }

    private var customerFirstName: String {
        job.customerName?.split(separator: " ").first.map(String.init) ?? "Customer"
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Conversation", selection: $thread) {
                Text("Customer").tag(MessageThread.customer)
                Text("AssembleAtEase").tag(MessageThread.team)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if loaded && shown.isEmpty {
                            Text(thread == .customer ? "No messages with \(customerFirstName) yet." : "No messages with AssembleAtEase yet.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 40)
                        }
                        ForEach(shown) { message in
                            MessageBubble(message: message, otherName: thread == .customer ? customerFirstName : "AssembleAtEase").id(message.id)
                        }
                    }
                    .padding(16)
                }
                .onChange(of: shown.count) { _, _ in
                    if let last = shown.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                .onChange(of: thread) { _, _ in
                    problem = nil
                    if let last = shown.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            .refreshable { await load() }

            if thread == .customer && job.isFinished {
                VStack(spacing: 8) {
                    Text("This job is finished. Messages about it go to AssembleAtEase.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Message AssembleAtEase") { thread = .team }
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(12)
                .background(.bar)
            } else {
            VStack(spacing: 8) {
                if let problem {
                    Text(problem).font(.footnote).foregroundStyle(Brand.attention)
                }
                HStack(alignment: .bottom, spacing: 10) {
                    TextField(thread == .customer ? "Message \(customerFirstName)" : "Message AssembleAtEase", text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .padding(10)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                    }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel(thread == .customer ? "Send to \(customerFirstName)" : "Send to AssembleAtEase")
                }
            }
            .padding(12)
            .background(.bar)
            }
        }
        .navigationTitle(thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            messages = try await store.messages(for: job)
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
            try await store.send(text, about: job, toCustomer: thread == .customer)
            draft = ""
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

private struct MessageBubble: View {
    let message: JobMessage
    let otherName: String
    var body: some View {
        HStack {
            if message.fromMe { Spacer(minLength: 40) }
            VStack(alignment: message.fromMe ? .trailing : .leading, spacing: 4) {
                Text(message.fromMe ? "You" : otherName).font(.caption2).foregroundStyle(.secondary)
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

// MARK: - Earnings

private struct EarningsView: View {
    @EnvironmentObject private var store: EaserStore
    private let recentCount = 5

    var body: some View {
        NavigationStack {
            List {
                if let summary = store.earnings?.summary {
                    Section {
                        HStack {
                            MoneyTile(title: "Awaiting payout", cents: summary.awaitingPayoutCents)
                            Divider()
                            MoneyTile(title: "Paid", cents: summary.paidCents)
                        }
                        if summary.onHoldCents > 0 {
                            LabeledContent("On hold") {
                                Text(Format.money(cents: summary.onHoldCents)).fontWeight(.semibold).foregroundStyle(Brand.attention)
                            }
                        }
                        LabeledContent("Total earned") {
                            Text(Format.money(cents: summary.totalEarnedCents)).fontWeight(.semibold)
                        }
                    }
                }

                Section {
                    let rows = store.earnings?.earnings ?? []
                    if rows.isEmpty {
                        Text(store.loadedOnce ? "Earnings from completed jobs will appear here." : "Loading")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(rows.prefix(recentCount)) { EarningRow(earning: $0) }
                    if rows.count > recentCount {
                        NavigationLink("See all \(rows.count)") { EarningsHistoryView() }
                    }
                } header: {
                    Text("Recent")
                }

                if let tips = store.earnings?.tips, let summary = tips.summary, summary.count > 0 {
                    Section {
                        LabeledContent("Tips received") {
                            Text(Format.money(cents: summary.amountCents)).fontWeight(.semibold)
                        }
                        if !summary.feePending {
                            LabeledContent("You keep") {
                                Text(Format.money(cents: summary.netCents)).fontWeight(.semibold).foregroundStyle(Brand.skyDark)
                            }
                        }
                        ForEach(tips.items.prefix(recentCount)) { tip in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tip.service ?? "Job").font(.subheadline)
                                    Text([tip.ref, Format.day(tip.date)].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(Format.money(cents: tip.amountCents)).monospacedDigit()
                            }
                        }
                    } header: {
                        Text("Tips")
                    } footer: {
                        Text("Tips are paid to your Stripe account.")
                    }
                }

                Section {
                    NavigationLink {
                        PayoutsView()
                    } label: {
                        Label("Payouts", systemImage: "building.columns")
                    }
                }
            }
            .navigationTitle("Earnings")
            .refreshable { await store.refresh() }
        }
    }
}

/// Strikes and the pause, shown only when there is one (api/assembler/reliability.js).
private struct ReliabilityCard: View {
    @EnvironmentObject private var store: EaserStore

    var body: some View {
        if let standing = store.reliability, standing.paused || standing.strikes > 0 {
            VStack(alignment: .leading, spacing: 8) {
                Label(standing.paused ? "New jobs are paused" : "Reliability", systemImage: standing.paused ? "pause.circle.fill" : "exclamationmark.shield")
                    .font(.headline)
                    .foregroundStyle(standing.paused ? Brand.attention : .primary)
                Text("\(standing.strikes) strike\(standing.strikes == 1 ? "" : "s") in the last \(standing.windowDays) days. New jobs pause at \(standing.pauseAtStrikes).")
                    .font(.subheadline)
                if standing.paused {
                    Text("AssembleAtEase reviews your account.").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Text("Cancelling within 24 hours of a job is 1 strike; on the day of the job, 2.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Brand.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }
}

private struct MoneyTile: View {
    let title: String
    let cents: Double
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(Format.money(cents: cents)).font(.title3.bold()).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Inbox

private struct InboxView: View {
    @EnvironmentObject private var store: EaserStore
    @State private var path = NavigationPath()
    @State private var filter = "all"
    @State private var loadingOlder = false

    private var shown: [EaserNotice] {
        filter == "all" ? store.notices : store.notices.filter { $0.category == filter }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Picker("Show", selection: $filter) {
                    Text("All").tag("all")
                    Text("Jobs").tag("jobs")
                    Text("Money").tag("money")
                    Text("Account").tag("account")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                if shown.isEmpty {
                    Text(store.loadedOnce ? (filter == "all" ? "Job updates will appear here." : "Nothing here yet.") : "Loading")
                        .foregroundStyle(.secondary)
                }

                let unread = shown.filter { !$0.read }
                let earlier = shown.filter { $0.read }
                if !unread.isEmpty {
                    Section("New") {
                        ForEach(unread) { NoticeRow(notice: $0) }
                    }
                }
                if !earlier.isEmpty {
                    Section(unread.isEmpty ? "" : "Earlier") {
                        ForEach(earlier) { NoticeRow(notice: $0) }
                    }
                }

                if store.noticesNextBefore != nil {
                    Button {
                        loadingOlder = true
                        Task {
                            await store.loadOlderNotices()
                            loadingOlder = false
                        }
                    } label: {
                        if loadingOlder { ProgressView() } else { Text("Show older") }
                    }
                    .frame(maxWidth: .infinity)
                    .disabled(loadingOlder)
                }
            }
            .navigationTitle("Inbox")
            .navigationDestination(for: NoticeRef.self) { NoticeDetailView(noticeID: $0.id) }
            .navigationDestination(for: JobRef.self) { JobDetailView(jobID: $0.id) }
            .navigationDestination(for: MessagesRef.self) { ref in
                if let job = store.job(ref.jobID) {
                    MessagesView(job: job, thread: ref.thread)
                } else {
                    Text("This job is no longer on your schedule.").foregroundStyle(.secondary)
                }
            }
            .toolbar {
                if store.unreadCount > 0 {
                    Button("Mark all read") {
                        Task { await store.markRead(store.notices.filter { !$0.read }.map(\.id)) }
                    }
                }
            }
            .refreshable { await store.refresh() }
        }
    }
}

struct NoticeRef: Hashable { let id: String }
struct MessagesRef: Hashable {
    let jobID: String
    let thread: MessageThread
}

private struct NoticeRow: View {
    let notice: EaserNotice

    var body: some View {
        NavigationLink(value: NoticeRef(id: notice.id)) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(notice.read ? Color.clear : Brand.sky)
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                VStack(alignment: .leading, spacing: 4) {
                    Text(notice.title).font(notice.read ? Font.body : Font.body.weight(.semibold))
                    Text(notice.detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    if let when = Format.relative(notice.createdAt) {
                        Text(when).font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }
}

/// One inbox item in full: what happened, which job, and the one button that
/// goes to it (api/assembler/notifications.js decides the button).
private struct NoticeDetailView: View {
    let noticeID: String
    @EnvironmentObject private var store: EaserStore

    private var notice: EaserNotice? { store.notices.first { $0.id == noticeID } }

    var body: some View {
        List {
            if let notice {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(notice.title).font(.title3.bold())
                        if let when = Format.relative(notice.createdAt) {
                            Text(when).font(.caption).foregroundStyle(.secondary)
                        }
                        Text(notice.detail).font(.body)
                    }
                    .padding(.vertical, 4)
                }

                let job = notice.bookingID.flatMap { store.job($0) }
                if let job {
                    Section("Job") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(job.title).font(.headline)
                            if !job.when.isEmpty { Text(job.when).font(.subheadline).foregroundStyle(.secondary) }
                        }
                    }
                }

                if let label = notice.actionLabel {
                    Section {
                        actionButton(notice, job: job, label: label)
                    }
                }
            } else {
                Text("This update is no longer in your inbox.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Update")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if let notice, !notice.read { await store.markRead([notice.id]) }
        }
    }

    @ViewBuilder
    private func actionButton(_ notice: EaserNotice, job: EaserJob?, label: String) -> some View {
        switch notice.action {
        case "job":
            if let job { NavigationLink(label, value: JobRef(id: job.id)) } else { goneJob }
        case "job_customer_messages", "job_team_messages":
            if let job {
                NavigationLink(label, value: MessagesRef(jobID: job.id, thread: notice.action == "job_customer_messages" ? .customer : .team))
            } else { goneJob }
        case "payouts":
            NavigationLink(label) { PayoutsView() }
        case "personal_info":
            NavigationLink(label) { PersonalInfoView() }
        case "account":
            Button(label) { store.tab = .account }
        case "today":
            Button(label) { store.tab = .today }
        default:
            EmptyView()
        }
    }

    private var goneJob: some View {
        Text("This job is no longer on your schedule.").foregroundStyle(.secondary)
    }
}

// MARK: - Account

private struct AccountView: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @AppStorage(NavigationApp.storageKey) private var navigationApp = ""
    @State private var confirmSignOut = false
    @State private var closing = false

    var body: some View {
        NavigationStack {
            List {
                Section { AccountHeader() }

                Section {
                    NavigationLink { PersonalInfoView() } label: {
                        Label("Personal information", systemImage: "person.text.rectangle")
                    }
                    NavigationLink { ReviewsView() } label: {
                        LabeledContent {
                            Text("\(store.profile?.reviewCount ?? 0)")
                        } label: {
                            Label("Reviews", systemImage: "star")
                        }
                    }
                    NavigationLink { WorkPreferencesView() } label: {
                        Label("Work preferences", systemImage: "slider.horizontal.3")
                    }
                    Picker(selection: $navigationApp) {
                        Text("Ask each time").tag("")
                        ForEach(NavigationApp.allCases) { app in Text(app.title).tag(app.rawValue) }
                    } label: {
                        Label("Directions app", systemImage: "arrow.triangle.turn.up.right.diamond")
                    }
                }

                Section("Help") {
                    Button {
                        if let url = URL(string: "tel:" + Site.supportPhone) { openURL(url) }
                    } label: { Label("Call \(Site.supportPhoneDisplay)", systemImage: "phone") }
                    Button {
                        if let url = URL(string: "mailto:" + Site.supportEmail) { openURL(url) }
                    } label: { Label("Email support", systemImage: "envelope") }
                }

                Section("Legal") {
                    Button("Privacy Policy") { openURL(Site.page("/privacy")) }
                    Button("Terms of Service") { openURL(Site.page("/terms")) }
                    Button("Contractor Agreement") { openURL(Site.page("/assembler/contractor-agreement")) }
                }

                Section {
                    Button("Sign out") { confirmSignOut = true }
                    Button("Close my account", role: .destructive) { closing = true }
                        .disabled(store.profile?.closureHeld == true)
                } footer: {
                    if store.profile?.closureHeld == true {
                        Text("Your account closure request is being reviewed.")
                    }
                }
            }
            .navigationTitle("Account")
            .refreshable {
                await store.refresh()
                await store.loadProfileExtras()
                await store.refreshAlertStatus(registerIfAllowed: false)
            }
            .task {
                await store.loadProfileExtras()
                await store.refreshAlertStatus(registerIfAllowed: false)
            }
            .confirmationDialog("Sign out of Easer?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await store.signOut() } }
            } message: {
                Text("Job alerts stop on this phone.")
            }
            .sheet(isPresented: $closing) { CloseAccountSheet().environmentObject(store) }
        }
    }
}

private struct CloseAccountSheet: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("You'll go offline right away. AssembleAtEase confirms by email. Completed jobs and payout records are kept as required by law.")
                        .font(.subheadline)
                }
                Section("Reason (optional)") {
                    TextField("Tell us why", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    Button(role: .destructive) {
                        working = true
                        Task {
                            let done = await store.requestClosure(reason: String(reason.prefix(500)))
                            working = false
                            if done { dismiss() }
                        }
                    } label: {
                        if working { ProgressView() } else { Text("Request account closure") }
                    }
                    .disabled(working)
                }
            }
            .navigationTitle("Close account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}

/// Customers see this photo on their booking ("who's coming"), so it is a clear face photo.
struct ProfilePhotoSheet: View {
    init() {}

    @EnvironmentObject private var store: EaserStore
    @Environment(\.dismiss) private var dismiss
    @State private var photo: UIImage?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    if let photo {
                        Image(uiImage: photo)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 140, height: 140)
                            .clipShape(Circle())
                    } else {
                        Avatar(photo: store.profile?.profilePhoto, name: store.profile?.fullName, size: 140)
                    }
                    Text("Customers see this photo. Use a clear photo of your face.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    PhotoChooser(photo: $photo)
                }
                .padding(16)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    guard let photo else { return }
                    saving = true
                    Task {
                        let done = await store.updateProfilePhoto(photo)
                        saving = false
                        if done { dismiss() }
                    }
                } label: {
                    if saving { ProgressView().tint(Brand.ink) } else { Text("Save photo") }
                }
                .buttonStyle(PrimaryButtonStyle(enabled: photo != nil))
                .disabled(photo == nil || saving)
                .padding(16)
                .background(.bar)
            }
            .navigationTitle("Profile photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
            }
        }
        .interactiveDismissDisabled(saving)
    }
}
