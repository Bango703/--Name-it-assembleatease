import ActivityKit
import Foundation

/// The lock-screen tracker for one booking. Compiled into the app (which starts
/// it) and the widget extension (which draws it). The server moves it with
/// pushes whose content-state keys match ContentState exactly
/// (api/_customer-push.js liveActivityState).
struct BookingActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// The server's words, the same as the app and the booking page.
        var status: String
        /// Booked 0, Pro confirmed 1, On the way 2, Arrived 3, Done 4.
        var step: Int
        var stepCount: Int
        var proName: String
        var window: String
    }

    var ref: String
    var service: String
}
