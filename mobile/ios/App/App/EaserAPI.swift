import Foundation

/// A refusal or failure, in words the Easer can act on. When the server gives
/// a reason, that reason is shown as written (Article 16); nothing is invented.
struct EaserError: LocalizedError {
    let message: String
    let status: Int
    var errorDescription: String? { message }

    static let offline = EaserError(message: "No connection. Check your signal and try again.", status: 0)
    static let signedOut = EaserError(message: "Please sign in again.", status: 401)
}

/// Talks to the existing AssembleAtEase server, which stays the source of truth
/// for offers, acceptance, job status, completion, earnings and readiness.
/// Sign-in uses the same Supabase project and public key as the website.
@MainActor
final class EaserAPI {
    static let supabase = URL(string: "https://ukamyqnaukxlmeoncjgr.supabase.co")!
    static let publishableKey = "sb_publishable_VjHBCo8wUahtg31Gb321qA_TG1e_VbN"

    private(set) var session: EaserSession?
    var onSessionEnded: (() -> Void)?
    private var refreshTask: Task<EaserSession, Error>?
    private let http: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    init() {
        SessionVault.clearIfFreshInstall()
        session = SessionVault.load()
    }

    // MARK: Sign-in

    func signIn(email: String, password: String) async throws {
        let body: [String: Any] = ["email": email, "password": password]
        let data = try await authRequest(grant: "password", body: body)
        try store(tokenResponse: data)
    }

    func signOut() {
        refreshTask?.cancel()
        refreshTask = nil
        session = nil
        SessionVault.delete()
    }

    private func authRequest(grant: String, body: [String: Any]) async throws -> Data {
        var parts = URLComponents(url: Self.supabase.appendingPathComponent("auth/v1/token"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "grant_type", value: grant)]
        var request = URLRequest(url: parts.url!)
        request.httpMethod = "POST"
        request.setValue(Self.publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await send(request)
        guard (200..<300).contains(response.statusCode) else {
            if grant == "password" && (response.statusCode == 400 || response.statusCode == 401) {
                throw EaserError(message: "That email and password do not match an Easer account.", status: response.statusCode)
            }
            if grant == "refresh_token" { throw EaserError.signedOut }
            throw EaserError(message: Self.reason(in: data) ?? "Sign in did not go through. Please try again.", status: response.statusCode)
        }
        return data
    }

    private func store(tokenResponse data: Data) throws {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = json["access_token"] as? String,
              let refresh = json["refresh_token"] as? String,
              let user = json["user"] as? [String: Any],
              let userID = user["id"] as? String else {
            throw EaserError(message: "Sign in did not go through. Please try again.", status: 0)
        }
        let expiresIn = (json["expires_in"] as? Double) ?? 3600
        let next = EaserSession(accessToken: access, refreshToken: refresh, userID: userID,
                                expiresAt: Date().addingTimeInterval(expiresIn))
        session = next
        SessionVault.save(next)
    }

    /// One refresh at a time, shared by every request that needs it.
    private func refreshSession() async throws -> EaserSession {
        if let refreshTask { return try await refreshTask.value }
        guard let current = session else { throw EaserError.signedOut }
        let task = Task<EaserSession, Error> { @MainActor in
            defer { self.refreshTask = nil }
            do {
                let data = try await self.authRequest(grant: "refresh_token", body: ["refresh_token": current.refreshToken])
                try self.store(tokenResponse: data)
                guard let fresh = self.session else { throw EaserError.signedOut }
                return fresh
            } catch let error as EaserError where error.status == 401 {
                self.signOut()
                self.onSessionEnded?()
                throw error
            }
        }
        refreshTask = task
        return try await task.value
    }

    private func validSession() async throws -> EaserSession {
        guard let current = session else { throw EaserError.signedOut }
        if current.expiresAt.timeIntervalSinceNow < 120 { return try await refreshSession() }
        return current
    }

    // MARK: Requests

    /// A call to the AssembleAtEase server. Retries once after refreshing an expired session.
    @discardableResult
    func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var token = try await validSession().accessToken
        for attempt in 0..<2 {
            var request = URLRequest(url: URL(string: Site.base.absoluteString + path)!)
            request.httpMethod = method
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await send(request)
            if response.statusCode == 401 && attempt == 0 {
                token = try await refreshSession().accessToken
                continue
            }
            try Self.check(data: data, status: response.statusCode)
            return data
        }
        throw EaserError.signedOut
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let data = try await call("GET", path)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw EaserError(message: "This screen could not be loaded right now. Pull down to try again.", status: 0)
        }
    }

    /// The signed-in person's own profile row, read under their own permissions.
    func profile() async throws -> EaserProfile {
        let current = try await validSession()
        var parts = URLComponents(url: Self.supabase.appendingPathComponent("rest/v1/profiles"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [
            URLQueryItem(name: "select", value: "id,role,full_name,email,is_available,account_closure_status"),
            URLQueryItem(name: "id", value: "eq." + current.userID),
        ]
        let data = try await supabaseRequest(url: parts.url!, method: "GET", body: nil)
        let rows = try JSONDecoder().decode([EaserProfile].self, from: data)
        guard let row = rows.first else { throw EaserError(message: "Your Easer profile could not be found.", status: 404) }
        return row
    }

    /// Availability goes through the same protected database function as the
    /// website (update_own_easer_profile_safe), which enforces its own rules.
    func setAvailable(_ available: Bool) async throws {
        let url = Self.supabase.appendingPathComponent("rest/v1/rpc/update_own_easer_profile_safe")
        _ = try await supabaseRequest(url: url, method: "POST", body: ["p_updates": ["is_available": available]])
    }

    private func supabaseRequest(url: URL, method: String, body: [String: Any]?) async throws -> Data {
        var token = try await validSession().accessToken
        for attempt in 0..<2 {
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.setValue(Self.publishableKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await send(request)
            if response.statusCode == 401 && attempt == 0 {
                token = try await refreshSession().accessToken
                continue
            }
            try Self.check(data: data, status: response.statusCode)
            return data
        }
        throw EaserError.signedOut
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await http.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { throw EaserError.offline }
            return (data, httpResponse)
        } catch let error as EaserError {
            throw error
        } catch {
            throw EaserError.offline
        }
    }

    /// Same rule as the web dashboard: a non-2xx status, or a body carrying an
    /// "error", is a failure, described by the server's own words.
    private static func check(data: Data, status: Int) throws {
        if (200..<300).contains(status) {
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let error = json["error"] as? String,
                  !error.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            throw EaserError(message: error, status: status)
        }
        if status == 401 { throw EaserError.signedOut }
        throw EaserError(message: reason(in: data) ?? fallback(for: status), status: status)
    }

    static func reason(in data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        for key in ["error", "message", "error_description", "msg"] {
            if let text = json[key] as? String, !text.trimmingCharacters(in: .whitespaces).isEmpty { return text }
        }
        return nil
    }

    private static func fallback(for status: Int) -> String {
        switch status {
        case 403: return "This job is not available to your account."
        case 404: return "This job is no longer available."
        case 409: return "This job changed a moment ago. Pull down to see the latest."
        case 429: return "Too many tries. Wait a minute and try again."
        case 500...599: return "AssembleAtEase is not responding right now. Try again in a minute."
        default: return "That did not go through. Try again."
        }
    }

    static func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}
