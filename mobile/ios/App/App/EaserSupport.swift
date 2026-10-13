import SwiftUI
import UIKit
import CoreLocation

// Easer-only support. Brand, links, formatting, the session store and photo
// sizing are shared with the customer app: mobile/ios/Shared/AppFoundation.swift.

/// Location is read once, only when the Easer taps "I've arrived". Check-in
/// still works without it: the server accepts an arrival with no position.
@MainActor
final class OneTimeLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?

    func current(timeoutSeconds: Double = 8) async -> CLLocation? {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        return await withCheckedContinuation { (continuation: CheckedContinuation<CLLocation?, Never>) in
            self.continuation = continuation
            switch manager.authorizationStatus {
            case .notDetermined:
                // Time spent reading the prompt does not count against the fix.
                manager.requestWhenInUseAuthorization()
                giveUp(after: 45)
            case .authorizedWhenInUse, .authorizedAlways:
                manager.requestLocation()
                giveUp(after: timeoutSeconds)
            default:
                finish(nil)
            }
        }
    }

    private func giveUp(after seconds: Double) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            self.finish(nil)
        }
    }

    private func finish(_ location: CLLocation?) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(returning: location)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            switch status {
            case .authorizedWhenInUse, .authorizedAlways:
                if self.continuation != nil {
                    self.manager.requestLocation()
                    self.giveUp(after: 8)
                }
            case .denied, .restricted:
                self.finish(nil)
            default:
                break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let location = locations.last
        Task { @MainActor in self.finish(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
