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
