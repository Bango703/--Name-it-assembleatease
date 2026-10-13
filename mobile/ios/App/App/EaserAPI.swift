import Foundation

/// The Easer app's calls. Sign-in, the session and every request go through
/// the shared client (mobile/ios/Shared/APIClient.swift); the server stays the
/// source of truth for offers, acceptance, job status, completion, earnings and
/// readiness.
typealias EaserError = AppError

@MainActor
final class EaserAPI: APIClient {
    override var passwordMismatchMessage: String { "That email and password do not match an Easer account." }

    /// The signed-in person's own profile row, read under their own permissions.
    func profile() async throws -> EaserProfile {
        try Self.decodeProfile(try await profileData())
    }

    static func decodeProfile(_ data: Data) throws -> EaserProfile {
        let rows = try JSONDecoder().decode([EaserProfile].self, from: data)
        guard let row = rows.first else { throw AppError(message: "Your Easer profile could not be found.", status: 404) }
        return row
    }

    /// The raw profile row, so the store can keep it for the next launch.
    func profileData() async throws -> Data {
        let current = try await validSession()
        var parts = URLComponents(url: Self.supabase.appendingPathComponent("rest/v1/profiles"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [
            URLQueryItem(name: "select", value: "id,role,full_name,phone,city,state,zip,profile_photo,rating,review_count,created_at,tier,is_available,identity_verified,account_closure_status"),
            URLQueryItem(name: "id", value: "eq." + current.userID),
        ]
        return try await supabaseRequest(url: parts.url!, method: "GET", body: nil)
    }

    /// Availability goes through the same protected database function as the
    /// website (update_own_easer_profile_safe), which enforces its own rules.
    func setAvailable(_ available: Bool) async throws {
        try await updateOwnProfile(["is_available": available])
    }

    /// Profile photo, saved the way the website saves it (assembler/profile.html).
    func setProfilePhoto(_ dataURL: String) async throws {
        try await updateOwnProfile(["profile_photo": dataURL])
    }

    /// Contact details, through the same protected function. The server refuses
    /// name and location changes once identity is verified.
    func updateDetails(_ updates: [String: Any]) async throws {
        try await updateOwnProfile(updates)
    }

    private func updateOwnProfile(_ updates: [String: Any]) async throws {
        let url = Self.supabase.appendingPathComponent("rest/v1/rpc/update_own_easer_profile_safe")
        _ = try await supabaseRequest(url: url, method: "POST", body: ["p_updates": updates])
    }

}
