import UIKit
import SwiftUI

/// The Easer app is native SwiftUI. It does not load the website: every screen
/// is drawn here and reads the existing AssembleAtEase server for its data.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingController(rootView: EaserRootView())
        self.window = window
        window.makeKeyAndVisible()

        // Opened by tapping a job notification while the app was closed.
        if let response = connectionOptions.notificationResponse {
            let info = response.notification.request.content.userInfo
            Task { @MainActor in
                if let id = PushRelay.shared.jobID(from: info) { PushRelay.shared.openJobID = id }
            }
        }
    }
}
