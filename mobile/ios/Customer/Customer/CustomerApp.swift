import SwiftUI
import Combine

/// AssembleAtEase for customers: find a service, book it, follow it, change it and message about it.
/// Native SwiftUI over the existing AssembleAtEase server, like the Easer app.
@main
struct CustomerApp: App {
    @UIApplicationDelegateAdaptor(CustomerAppDelegate.self) private var appDelegate
    @StateObject private var store = CustomerStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ZStack(alignment: .top) {
                switch store.phase {
                case .launching:
                    VStack(spacing: 14) {
                        BrandLogo(size: 88)
                        ProgressView()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(uiColor: .systemBackground))
                case .signedOut, .signedIn:
                    // Home, services and prices are open to everyone; signing in is asked
                    // for at booking, and on Activity and Account.
                    CustomerTabsView()
                }
                if let banner = store.banner {
                    CustomerBannerView(banner: banner)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .onTapGesture { store.banner = nil }
                }
            }
            .animation(.easeInOut(duration: 0.2), value: store.banner)
            .environmentObject(store)
            .environmentObject(store.flow)
            .onOpenURL { url in CardSheet.handle(url) }
            .onReceive(CustomerPush.shared.$fcmToken) { token in
                Task { await store.pushTokenChanged(token) }
            }
            .onReceive(CustomerPush.shared.$openedRef) { ref in
                guard let ref else { return }
                CustomerPush.shared.openedRef = nil
                store.open(ref: ref)
                Task { await store.refresh() }
            }
            .onReceive(CustomerPush.shared.$received.dropFirst()) { _ in
                Task { await store.refresh() }
            }
            .environment(\.openURL, InAppBrowser.action {
                store.browserCloses += 1
                Task { await store.refresh() }
            })
            .tint(Brand.skyDark)
            .task { await store.start() }
            .task(id: store.banner?.id) {
                guard store.banner != nil else { return }
                try? await Task.sleep(nanoseconds: 4_500_000_000)
                store.banner = nil
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && store.phase == .signedIn { Task { await store.refresh() } }
            }
        }
    }
}

private struct CustomerBannerView: View {
    let banner: CustomerBanner
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: banner.kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(banner.kind == .success ? Brand.skyDark : Brand.attention)
            Text(banner.text)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
    }
}

struct CustomerTabsView: View {
    @EnvironmentObject private var store: CustomerStore

    var body: some View {
        TabView(selection: $store.tab) {
            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(CustomerTab.home)
            Group {
                if store.phase == .signedIn {
                    ActivityView()
                } else {
                    CustomerSignInView(message: "Sign in to see your bookings and messages.", autoFocus: false)
                }
            }
                .tabItem { Label("Activity", systemImage: "list.bullet.rectangle.fill") }
                .badge(store.unreadCount)
                .tag(CustomerTab.activity)
            Group {
                if store.phase == .signedIn {
                    CustomerAccountView()
                } else {
                    CustomerSignInView(autoFocus: false)
                }
            }
                .tabItem { Label("Account", systemImage: "person.crop.circle.fill") }
                .tag(CustomerTab.account)
        }
    }
}
