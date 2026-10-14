import Foundation
import UIKit

/// The customer app's calls. Sign-in, the session and every request go through
/// the shared client (mobile/ios/Shared/APIClient.swift). The server is the
/// source of truth for every booking, status, price and rule shown here; the
/// app only renders its answers.
@MainActor
final class CustomerAPI: APIClient {

    // MARK: Sign-in by email code (api/customer/sign-in.js)

    func sendCode(to email: String) async throws {
        try await publicCall("POST", "/api/customer/sign-in", body: ["action": "send", "email": email])
    }

    func verify(email: String, code: String) async throws {
        let data = try await publicCall("POST", "/api/customer/sign-in", body: ["action": "verify", "email": email, "code": code])
        try adopt(tokenResponse: data)
    }

    func deleteAccount() async throws {
        try await call("DELETE", "/api/customer/account")
    }

    // MARK: Bookings

    func bookings() async throws -> [BookingSummary] {
        try await get("/api/booking/customer-bookings", as: BookingsEnvelope.self).bookings
    }

    func booking(ref: String) async throws -> BookingDetail {
        let data = try await call("POST", "/api/booking/track", body: ["ref": ref])
        do {
            return try JSONDecoder().decode(BookingEnvelope.self, from: data).booking
        } catch {
            throw AppError(message: "This booking could not be loaded right now. Pull down to try again.", status: 0)
        }
    }

    func reschedule(ref: String, date: String, time: String, proposalID: String? = nil) async throws {
        var body: [String: Any] = ["ref": ref, "date": date, "time": time]
        if let proposalID { body["proposalId"] = proposalID }
        try await call("POST", "/api/booking/reschedule", body: body)
    }

    func keepBookedTime(ref: String, proposalID: String) async throws {
        try await call("POST", "/api/booking/time-proposal", body: ["action": "decline", "ref": ref, "proposalId": proposalID])
    }

    func cancel(ref: String) async throws {
        try await call("POST", "/api/booking/guest-cancel", body: ["ref": ref])
    }

    // MARK: Booking (the same endpoints the website's booking page uses)

    func catalog() async throws -> BookingCatalog {
        let data = try await publicCall("GET", "/api/booking/catalog")
        do {
            return try JSONDecoder().decode(BookingCatalog.self, from: data)
        } catch {
            throw AppError(message: "Services could not be loaded right now. Pull down to try again.", status: 0)
        }
    }

    /// The server's total and payment plan for an order. Nothing is booked.
    func preview(_ order: [String: Any]) async throws -> CheckoutPreview {
        let data = try await publicCall("POST", "/api/booking/promo-preview", body: order)
        do {
            return try JSONDecoder().decode(CheckoutPreview.self, from: data)
        } catch {
            throw AppError(message: "The total could not be loaded right now. Try again.", status: 0)
        }
    }

    func addressSuggestions(for text: String) async throws -> [AddressSuggestion] {
        let data = try await publicCall("GET", "/api/address/autocomplete?q=" + Self.query(text))
        return (try? JSONDecoder().decode(AddressSuggestionsEnvelope.self, from: data))?.suggestions ?? []
    }

    func stripeKey() async throws -> String {
        let data = try await publicCall("GET", "/api/config/public-key")
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let key = object["publishableKey"] as? String, !key.isEmpty else {
            throw AppError(message: "Card payments are not available right now. Try again in a minute.", status: 0)
        }
        return key
    }

    /// A card saved for later: future appointments and custom quotes.
    func cardSetup(name: String, email: String, purpose: String, date: String) async throws -> String {
        let data = try await publicCall("POST", "/api/booking/setup-intent", body: [
            "name": name, "email": email, "purpose": purpose, "date": date,
        ])
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let secret = object["clientSecret"] as? String, !secret.isEmpty else {
            throw AppError(message: "The card screen could not open. Try again.", status: 0)
        }
        return secret
    }

    func createBooking(_ order: [String: Any]) async throws -> CreatedBooking {
        let data = try await publicCall("POST", "/api/booking", body: order)
        guard let created = try? JSONDecoder().decode(CreatedBooking.self, from: data), !created.ref.isEmpty else {
            throw AppError(message: "The booking could not be confirmed. Check Bookings before trying again.", status: 0)
        }
        return created
    }

    /// Tells the server the card hold went through, so the booking confirms and dispatches.
    func confirmBooking(_ created: CreatedBooking) async throws {
        try await publicCall("POST", "/api/booking-confirmed", body: [
            "bookingId": created.bookingID, "guestMutationToken": created.guestToken,
        ])
    }

    // MARK: Messages

    func messages(ref: String) async throws -> [CustomerMessage] {
        try await get("/api/booking/message?as=customer&ref=" + Self.query(ref), as: CustomerMessagesEnvelope.self).messages
    }

    func send(_ text: String, ref: String) async throws {
        try await call("POST", "/api/booking/message", body: ["ref": ref, "body": text])
    }

    // MARK: Photos for the pro (api/booking/customer-photos.js)

    func photos(ref: String) async throws -> [BookingPhoto] {
        try await get("/api/booking/customer-photos?ref=" + Self.query(ref), as: BookingPhotosEnvelope.self).photos
    }

    func upload(_ image: UIImage, ref: String) async throws {
        guard let jpeg = PhotoPrep.jpeg(from: image) else {
            throw AppError(message: "That photo is too large. Choose another.", status: 0)
        }
        try await call("POST", "/api/booking/customer-photos", body: [
            "ref": ref,
            "mimeType": "image/jpeg",
            "fileBase64": jpeg.base64EncodedString(),
        ])
    }
}
