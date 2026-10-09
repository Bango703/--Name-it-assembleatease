import SwiftUI
import PhotosUI
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
            if phase == .active && store.phase == .signedIn { Task { await store.refresh() } }
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
    enum Tab: Hashable { case today, jobs, earnings, inbox, account }
    @EnvironmentObject private var store: EaserStore
    @ObservedObject private var relay = PushRelay.shared
    @State private var tab: Tab = .today
    @State private var linkedJob: JobRef?
    @State private var reloadedFor: String?

    var body: some View {
        TabView(selection: $tab) {
            TodayView()
                .tabItem { Label("Today", systemImage: "sun.max") }
                .tag(Tab.today)
            JobsView()
                .tabItem { Label("Jobs", systemImage: "briefcase") }
                .tag(Tab.jobs)
            EarningsView()
                .tabItem { Label("Earnings", systemImage: "dollarsign.circle") }
                .tag(Tab.earnings)
            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray") }
                .badge(store.unreadCount)
                .tag(Tab.inbox)
            AccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(Tab.account)
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
                Text(online ? "New job offers can reach you." : "Go online when you're ready for job offers.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if store.availabilityBusy {
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
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// Shown only when a real step blocks job offers. Every step is done inside the
/// app; only Stripe's identity check opens Stripe's own page.
extension EaserStore {
    /// A step still blocks job offers (the server's readiness verdict).
    var needsSetup: Bool { jobsLocked || readiness?.isReady == false }
}

private struct SetupCard: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var signing = false
    @State private var startingVerification = false

    private var needsSetup: Bool { store.needsSetup }

    /// Items the three steps below do not already cover, in the server's words.
    private var otherItems: [String] {
        let covered = ["contractor agreement", "code of conduct", "identity", "approv"]
        return (store.readiness?.missingItems ?? []).filter { item in
            !covered.contains { item.lowercased().contains($0) }
        }
    }

    var body: some View {
        if store.profile?.closureHeld == true {
            NoticeCard(icon: "person.crop.circle.badge.xmark", title: "Account closure requested",
                       text: "You are offline while AssembleAtEase reviews your request.")
        } else if store.readiness?.suspended == true {
            NoticeCard(icon: "pause.circle", title: "Your account is paused",
                       text: "Contact \(Site.supportEmail) to reactivate it.")
        } else if needsSetup, let setup = store.setup {
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
                        ForEach(otherItems, id: \.self) { item in
                            Label(item, systemImage: "circle").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(16)
            .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .sheet(isPresented: $signing) { AgreementSheet(legalName: setup.fullName).environmentObject(store) }
        } else if needsSetup {
            VStack(alignment: .leading, spacing: 10) {
                Label("Finish setting up to get jobs", systemImage: "checklist").font(.headline)
                ForEach(store.readiness?.missingItems ?? [], id: \.self) { item in
                    Label(item, systemImage: "circle").font(.subheadline).foregroundStyle(.secondary)
                }
                Text("Pull down to refresh your setup steps.").font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
            .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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
                    Text("Before you can receive jobs, we need your contractor agreement and Code of Conduct acceptance on file.")
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
                    if !typedName.isEmpty && !nameMatches {
                        Text("Type your name exactly as it is on your application: \(legalName). Contact \(Site.supportEmail) if it needs correcting.")
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
                    .disabled(!(nameMatches && agreeContract && agreeConduct) || working)
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
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(emphasis ? Brand.sky : Color.clear, lineWidth: 2)
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
        if store.jobsLocked { return "Jobs appear here once your account is approved. Your setup steps are on Today." }
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

    var body: some View {
        Group {
            if let job = store.job(jobID) {
                content(job)
            } else {
                ContentUnavailableView("This job is no longer available", systemImage: "briefcase",
                                       description: Text("It may have been taken by another Easer or changed by AssembleAtEase."))
            }
        }
        .navigationTitle("Job")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func content(_ job: EaserJob) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    StatusPill(text: job.statusLabel, strong: job.needsAcceptance || job.isActive)
                    Text(job.title).font(.title2.bold())
                    if let ref = job.ref { Text(ref).font(.footnote).foregroundStyle(.secondary) }
                }

                if job.photosRequested {
                    DetailBlock(title: "Photos requested") {
                        Text("AssembleAtEase asked for more photos of this job. Your payout continues once one arrives.")
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
                    Text(store.payText(for: job)).font(.title.bold())
                    if job.isFinished, let earned = store.earning(for: job) {
                        Text(earned.statusLabel).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.skyDark)
                    }
                    if job.isOffer, let left = Format.timeLeft(until: job.offerExpiresAt) {
                        Text(left).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.attention)
                    }
                }

                DetailBlock(title: "When and where") {
                    if !job.when.isEmpty { Label(job.when, systemImage: "calendar") }
                    Label(job.place, systemImage: "mappin.and.ellipse")
                    if job.acceptedAt != nil, let address = job.address, !job.isFinished {
                        Button {
                            if let url = URL(string: "http://maps.apple.com/?daddr=" + EaserAPI.query(address)) { openURL(url) }
                        } label: {
                            Label("Directions", systemImage: "arrow.triangle.turn.up.right.diamond")
                        }
                        .buttonStyle(SecondaryButtonStyle())
                    }
                }

                if !job.items.isEmpty {
                    DetailBlock(title: "What you're assembling") {
                        ForEach(Array(job.items.enumerated()), id: \.offset) { _, item in
                            Text(item.quantity > 1 ? "\(item.quantity) × \(item.name)" : item.name)
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
                            MessagesView(job: job)
                        } label: {
                            Label("Messages", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                }

                if job.acceptedAt != nil {
                    DetailBlock(title: "Something wrong?") {
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
        .confirmationDialog("Decline this offer?", isPresented: $confirmDecline, titleVisibility: .visible) {
            Button("Decline offer", role: .destructive) { Task { await store.decline(job) } }
            Button("Keep offer", role: .cancel) {}
        } message: {
            Text("The job will be offered to another Easer.")
        }
        .sheet(item: $photoSheet) { mode in PhotoSheet(job: job, mode: mode).environmentObject(store) }
        .sheet(isPresented: $releasing) { ReleaseSheet(job: job).environmentObject(store) }
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
                case .startTravel:
                    Button("Start travel") { Task { await store.startTravel(job) } }
                        .buttonStyle(PrimaryButtonStyle())
                case .arrived:
                    Button("I've arrived") { Task { await store.arrived(job) } }
                        .buttonStyle(PrimaryButtonStyle())
                case .startJob:
                    Button("Start job") { Task { await store.startJob(job) } }
                        .buttonStyle(PrimaryButtonStyle())
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
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
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
        case .completion: return "Add a photo of the finished work. It is required to complete the job and protects you if a question comes up later."
        case .requested: return "Add the photo AssembleAtEase asked for."
        case .damage: return "Add a clear photo of the damage and describe what happened. AssembleAtEase follows up with you and the customer."
        }
    }

    private var noteReady: Bool { note.trimmingCharacters(in: .whitespacesAndNewlines).count >= 10 }
    private var ready: Bool { photo != nil && (mode != .damage || noteReady) }

    var body: some View {
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
                        if done { dismiss() }
                    }
                } label: {
                    if submitting {
                        ProgressView().tint(Brand.ink)
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
                    Text("You will be removed from this job and it will be offered to another Easer.")
                    if let impactText {
                        Text(impactText).foregroundStyle(Brand.attention)
                    } else if let impactProblem {
                        Text(impactProblem).foregroundStyle(.secondary)
                    } else {
                        HStack { ProgressView(); Text("Checking what this means for your reliability").foregroundStyle(.secondary) }
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
    @State private var messages: [JobMessage] = []
    @State private var draft = ""
    @State private var toCustomer = true
    @State private var sending = false
    @State private var problem: String?
    @State private var loaded = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if loaded && messages.isEmpty {
                            Text("No messages yet.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 40)
                        }
                        ForEach(messages) { message in
                            MessageBubble(message: message).id(message.id)
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
                if let problem {
                    Text(problem).font(.footnote).foregroundStyle(Brand.attention)
                }
                Picker("Send to", selection: $toCustomer) {
                    Text("Customer").tag(true)
                    Text("AssembleAtEase").tag(false)
                }
                .pickerStyle(.segmented)
                HStack(alignment: .bottom, spacing: 10) {
                    TextField("Message", text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .padding(10)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Button {
                        Task { await send() }
                    } label: {
                        if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                    }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send message")
                }
            }
            .padding(12)
            .background(.bar)
        }
        .navigationTitle("Messages")
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
            try await store.send(text, about: job, toCustomer: toCustomer)
            draft = ""
            await load()
        } catch {
            problem = error.localizedDescription
        }
    }
}

private struct MessageBubble: View {
    let message: JobMessage
    var body: some View {
        HStack {
            if message.fromMe { Spacer(minLength: 40) }
            VStack(alignment: message.fromMe ? .trailing : .leading, spacing: 4) {
                Text(message.senderLabel).font(.caption2).foregroundStyle(.secondary)
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
    @State private var path: [JobRef] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if store.notices.isEmpty {
                    Text(store.loadedOnce ? "Job updates will appear here." : "Loading")
                        .foregroundStyle(.secondary)
                }
                ForEach(store.notices) { notice in
                    Button {
                        if !notice.read { Task { await store.markRead([notice.id]) } }
                        if let id = notice.bookingID, store.job(id) != nil { path.append(JobRef(id: id)) }
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Circle()
                                .fill(notice.read ? Color.clear : Brand.sky)
                                .frame(width: 8, height: 8)
                                .padding(.top, 6)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(notice.title).font(notice.read ? Font.body : Font.body.weight(.semibold))
                                Text(notice.detail).font(.subheadline).foregroundStyle(.secondary)
                                if let when = Format.relative(notice.createdAt) {
                                    Text(when).font(.caption).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                    .foregroundStyle(.primary)
                }
            }
            .navigationTitle("Inbox")
            .navigationDestination(for: JobRef.self) { JobDetailView(jobID: $0.id) }
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

// MARK: - Account

private struct AccountView: View {
    @EnvironmentObject private var store: EaserStore
    @Environment(\.openURL) private var openURL
    @State private var confirmSignOut = false
    @State private var closing = false
    @State private var changingPhoto = false

    private var online: Bool { store.profile?.isAvailable == true }

    /// Job alerts reach an Easer only while they are online, so the row says so.
    private var alertStatus: String {
        guard online else { return "Paused" }
        switch store.alertsAuthorized {
        case .some(true): return "On"
        case .some(false): return "Off"
        case .none: return "Not set up"
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Avatar(photo: store.profile?.profilePhoto, name: store.profile?.fullName, size: 64)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(store.profile?.fullName ?? "Easer").font(.headline)
                            if let email = store.email {
                                Text(email).font(.subheadline).foregroundStyle(.secondary)
                                    .lineLimit(1).truncationMode(.middle)
                            }
                            Text(store.profile?.levelLabel ?? "Easer").font(.caption.weight(.semibold)).foregroundStyle(Brand.skyDark)
                        }
                    }
                    Button("Change photo") { changingPhoto = true }
                }

                Section {
                    Toggle("Available for jobs", isOn: Binding(
                        get: { online },
                        set: { value in Task { await store.setAvailable(value) } }
                    ))
                    .disabled(store.availabilityBusy || store.profile?.closureHeld == true || store.needsSetup)
                } footer: {
                    Text(store.needsSetup ? "Available once setup on the Today tab is finished."
                         : online ? "New job offers can reach you." : "You won't get job offers until you go online.")
                }

                Section {
                    Button {
                        if store.alertsAuthorized == false {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        } else if store.alertsAuthorized == nil {
                            Task { await store.requestAlertsIfNeeded() }
                        }
                    } label: {
                        LabeledContent {
                            Text(alertStatus)
                        } label: {
                            Label("Job alerts", systemImage: "bell")
                        }
                    }
                    .foregroundStyle(.primary)
                    Toggle(isOn: Binding(
                        get: { store.textAlerts?.enabled == true },
                        set: { value in Task { await store.setTextAlerts(value) } }
                    )) {
                        Label("Text me job offers", systemImage: "message")
                    }
                    .disabled(store.textAlerts == nil || store.textAlerts?.hasPhone == false)
                } header: {
                    Text("Notifications")
                } footer: {
                    if store.textAlerts?.hasPhone == false {
                        Text("Add a phone number in Profile to get job texts.")
                    } else if store.alertsAuthorized == false && online {
                        Text("Job alerts are turned off in iPhone Settings. Tap to open Settings.")
                    } else {
                        Text("Message and data rates may apply. Reply STOP to any text to turn texts off.")
                    }
                }

                Section("Your work") {
                    NavigationLink { ProfileView() } label: { Label("Profile", systemImage: "person.text.rectangle") }
                    NavigationLink { PayoutsView() } label: { Label("Payouts", systemImage: "building.columns") }
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
                Text("Job alerts stop on this phone until you sign in again.")
            }
            .sheet(isPresented: $closing) { CloseAccountSheet().environmentObject(store) }
            .sheet(isPresented: $changingPhoto) { ProfilePhotoSheet().environmentObject(store) }
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
                    Text("You will go offline right away and stop receiving job offers. AssembleAtEase confirms by email. Records the law requires us to keep, such as completed jobs and payouts, are kept.")
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
                    Text("Customers see this photo on their booking so they know who is coming. Use a clear photo of your face.")
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
