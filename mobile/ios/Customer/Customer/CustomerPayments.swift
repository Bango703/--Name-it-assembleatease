import UIKit
import Stripe
import StripePaymentSheet

/// Stripe's own card sheet, over a client secret the server created. Card
/// details go from the sheet to Stripe; the app never sees them. Card scanning
/// comes with the sheet (camera permission in Info.plist).
enum CardSheetIntent {
    /// Hold the total now (api booking create returned a PaymentIntent).
    case payment(String)
    /// Save the card for later (api/booking/setup-intent.js returned a SetupIntent).
    case setup(String)
}

enum CardSheetOutcome {
    case done
    case cancelled
    case failed(String)
}

@MainActor
enum CardSheet {
    /// Registered under CFBundleURLTypes so a bank's verification page can return here.
    static let returnURL = "assembleatease-customer://stripe-redirect"

    static func present(_ intent: CardSheetIntent, publishableKey: String, name: String, email: String, phone: String) async -> CardSheetOutcome {
        STPAPIClient.shared.publishableKey = publishableKey
        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = "AssembleAtEase"
        configuration.returnURL = returnURL
        configuration.allowsDelayedPaymentMethods = false
        configuration.defaultBillingDetails.name = name
        configuration.defaultBillingDetails.email = email
        configuration.defaultBillingDetails.phone = phone
        if let merchantID = applePayMerchantID {
            configuration.applePay = .init(merchantId: merchantID, merchantCountryCode: "US")
        }

        let sheet: PaymentSheet
        switch intent {
        case .payment(let secret):
            sheet = PaymentSheet(paymentIntentClientSecret: secret, configuration: configuration)
        case .setup(let secret):
            sheet = PaymentSheet(setupIntentClientSecret: secret, configuration: configuration)
        }

        guard let host = topController() else { return .failed("The card screen could not open. Try again.") }
        return await withCheckedContinuation { continuation in
            sheet.present(from: host) { result in
                switch result {
                case .completed:
                    continuation.resume(returning: .done)
                case .canceled:
                    continuation.resume(returning: .cancelled)
                case .failed(let error):
                    continuation.resume(returning: .failed(error.localizedDescription))
                }
            }
        }
    }

    /// A return from a bank's verification page.
    static func handle(_ url: URL) {
        _ = StripeAPI.handleURLCallback(with: url)
    }

    /// Apple Pay turns on when the Merchant ID is set in Info.plist (AAEApplePayMerchantID)
    /// and the Apple Pay capability is on the App ID and its profile.
    private static var applePayMerchantID: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "AAEApplePayMerchantID") as? String,
              !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}
