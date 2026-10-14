import ActivityKit
import FirebaseCore
import FirebaseMessaging
import UIKit
import UserNotifications

// Notifications for the customer app (Firebase Cloud Messaging over APNs, the
// same as the Easer app) and the lock-screen tracker. The server decides what
// is sent and when (api/_customer-push.js); this file registers the phone,
// shows notifications while the app is open, and opens the booking a tap is about.

final class CustomerAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate, MessagingDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // GoogleService-Info.plist is added by the Codemagic build. Without it the
        // app runs normally and simply registers for no notifications.
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            Messaging.messaging().delegate = self
        }
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard FirebaseApp.app() != nil else { return }
        Messaging.messaging().apnsToken = deviceToken
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken, !fcmToken.isEmpty else { return }
        Task { @MainActor in CustomerPush.shared.fcmToken = fcmToken }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
        Task { @MainActor in CustomerPush.shared.received += 1 }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let ref = response.notification.request.content.userInfo["ref"] as? String
        Task { @MainActor in
            if let ref, !ref.isEmpty { CustomerPush.shared.openedRef = ref }
        }
        completionHandler()
    }
}

@MainActor
final class CustomerPush: ObservableObject {
    static let shared = CustomerPush()

    @Published var fcmToken: String?
    /// A booking a tapped notification is about.
    @Published var openedRef: String?
    /// Bumps when a notification arrives while the app is open, so screens refresh.
    @Published var received = 0
    @Published var status: UNAuthorizationStatus = .notDetermined

    var isOn: Bool { status == .authorized || status == .provisional || status == .ephemeral }

    func refreshStatus() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if isOn { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// Apple's permission prompt. Asked when there is a booking to follow.
    @discardableResult
    func request() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await refreshStatus()
        return granted
    }
}

/// Starts the lock-screen tracker on the day of a visit once a pro is confirmed,
/// hands its push token to the server, and ends trackers for visits that are over.
@MainActor
enum LiveTracker {
    private static let chicagoDay: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "America/Chicago")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func sync(bookings: [BookingSummary], api: CustomerAPI, fcmToken: String?) async {
        let live = bookings.filter { !$0.isPast }
        for activity in Activity<BookingActivityAttributes>.activities where !live.contains(where: { $0.ref == activity.attributes.ref }) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }

        guard ActivityAuthorizationInfo().areActivitiesEnabled, let fcmToken else { return }
        let today = chicagoDay.string(from: Date())
        guard let next = live.first(where: { String(($0.date ?? "").prefix(10)) == today && ($0.progress?.step ?? 0) >= 1 }),
              !Activity<BookingActivityAttributes>.activities.contains(where: { $0.attributes.ref == next.ref }) else { return }

        let state = BookingActivityAttributes.ContentState(
            status: next.statusLabel,
            step: next.progress?.step ?? 0,
            stepCount: next.progress?.steps.count ?? 5,
            proName: next.proFirstName ?? "",
            window: next.time ?? ""
        )
        do {
            let activity = try Activity.request(
                attributes: BookingActivityAttributes(ref: next.ref, service: next.service),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: .token
            )
            let ref = next.ref
            Task {
                for await data in activity.pushTokenUpdates {
                    let token = data.map { String(format: "%02x", $0) }.joined()
                    try? await api.registerTracker(ref: ref, activityToken: token, fcmToken: fcmToken)
                }
            }
        } catch {
            // Live Activities off for this app, or too many running: the notifications still arrive.
        }
    }
}
