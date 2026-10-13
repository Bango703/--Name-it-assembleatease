import SwiftUI

/// AssembleAtEase for customers: book, follow, change and message about a booking.
/// Native SwiftUI over the existing AssembleAtEase server, like the Easer app.
@main
struct CustomerApp: App {
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
                case .signedOut:
                    CustomerSignInView()
                case .signedIn:
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
            BookingsView()
                .tabItem { Label("Bookings", systemImage: "calendar") }
                .tag(CustomerTab.bookings)
            BookView()
                .tabItem { Label("Book", systemImage: "plus.circle") }
                .tag(CustomerTab.book)
            CustomerAccountView()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(CustomerTab.account)
        }
    }
}
