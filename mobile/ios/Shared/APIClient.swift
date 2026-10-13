import Foundation

// Shared by both iPhone apps (mobile/ios/App and mobile/ios/Customer).

/// A refusal or failure, in words the person can act on. When the server gives
/// a reason, that reason is shown as written (Article 16); nothing is invented.
struct AppError: LocalizedError {
    let message: String
    let status: Int
    var errorDescription: String? { message }

    static let offline = AppError(message: "No connection. Check your signal and try again.", status: 0)
    static let unreachable = AppError(message: "AssembleAtEase could not be reached. Pull down to try again.", status: 0)
    /// A request the app itself cancelled (a newer refresh replaced it). Never shown.
    static let cancelled = AppError(message: "", status: -1)
    var isCancelled: Bool { status == -1 }
    static let signedOut = AppError(message: "Please sign in again.", status: 401)
}

/// Talks to the existing AssembleAtEase server, which stays the source of truth.
/// Sign-in uses the same Supabase project and public key as the website. Each
/// app adds its own calls in a subclass (EaserAPI, CustomerAPI).
@MainActor
class APIClient {
    static let supabase = URL(string: "https://ukamyqnaukxlmeoncjgr.supabase.co")!
    static let publishableKey = "sb_publishable_VjHBCo8wUahtg31Gb321qA_TG1e_VbN"

    private(set) var session: AppSession?
    var onSessionEnded: (() -> Void)?
    private var refreshTask: Task<AppSession, Error>?
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

    /// The words when an email and password do not match.
    var passwordMismatchMessage: String { "That email and password do not match an account." }

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
                throw AppError(message: passwordMismatchMessage, status: response.statusCode)
            }
            if grant == "refresh_token" { throw AppError.signedOut }
            throw AppError(message: Self.reason(in: data) ?? "Sign in did not go through. Please try again.", status: response.statusCode)
        }
        return data
    }

    /// Keeps a session the server issued in Supabase's token shape (the
    /// customer app's code sign-in, api/customer/sign-in.js).
    func adopt(tokenResponse data: Data) throws {
        try store(tokenResponse: data)
    }

    private func store(tokenResponse data: Data) throws {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let access = json["access_token"] as? String,
              let refresh = json["refresh_token"] as? String,
              let user = json["user"] as? [String: Any],
              let userID = user["id"] as? String else {
            throw AppError(message: "Sign in did not go through. Please try again.", status: 0)
        }
        let expiresIn = (json["expires_in"] as? Double) ?? 3600
        let next = AppSession(accessToken: access, refreshToken: refresh, userID: userID,
                                expiresAt: Date().addingTimeInterval(expiresIn),
                                email: (user["email"] as? String) ?? session?.email)
        session = next
        SessionVault.save(next)
    }

    /// One refresh at a time, shared by every request that needs it.
    private func refreshSession() async throws -> AppSession {
        if let refreshTask { return try await refreshTask.value }
        guard let current = session else { throw AppError.signedOut }
        let task = Task<AppSession, Error> { @MainActor in
            defer { self.refreshTask = nil }
            do {
                let data = try await self.authRequest(grant: "refresh_token", body: ["refresh_token": current.refreshToken])
                try self.store(tokenResponse: data)
                guard let fresh = self.session else { throw AppError.signedOut }
                return fresh
            } catch let error as AppError where error.status == 401 {
                self.signOut()
                self.onSessionEnded?()
                throw error
            }
        }
        refreshTask = task
        return try await task.value
    }

    func validSession() async throws -> AppSession {
        guard let current = session else { throw AppError.signedOut }
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
        throw AppError.signedOut
    }

    /// A call that needs no session (the customer app's code sign-in).
    @discardableResult
    func publicCall(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: URL(string: Site.base.absoluteString + path)!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await send(request)
        try Self.check(data: data, status: response.statusCode)
        return data
    }

    /// The raw answer to a read. A dropped read is retried once, quietly, before anything is shown.
    func getData(_ path: String) async throws -> Data {
        do {
            return try await call("GET", path)
        } catch let error as AppError where error.status == 0 {
            try await Task.sleep(nanoseconds: 1_200_000_000)
            return try await call("GET", path)
        }
    }

    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let data = try await getData(path)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AppError(message: "This screen could not be loaded right now. Pull down to try again.", status: 0)
        }
    }

    /// Sends the same password reset email as the website's Forgot password page.
    func sendPasswordReset(to email: String) async throws {
        var parts = URLComponents(url: Self.supabase.appendingPathComponent("auth/v1/recover"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "redirect_to", value: Site.base.absoluteString + "/auth/set-password")]
        var request = URLRequest(url: parts.url!)
        request.httpMethod = "POST"
        request.setValue(Self.publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email])
        let (data, response) = try await send(request)
        guard (200..<300).contains(response.statusCode) else {
            throw AppError(message: Self.reason(in: data) ?? "The reset email could not be sent. Try again in a minute.", status: response.statusCode)
        }
    }

    func supabaseRequest(url: URL, method: String, body: [String: Any]?) async throws -> Data {
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
        throw AppError.signedOut
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await http.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { throw AppError.offline }
            return (data, httpResponse)
        } catch let error as AppError {
            throw error
        } catch let error as URLError {
            // Only a real network loss is called one; anything else is named honestly.
            switch error.code {
            case .cancelled:
                throw AppError.cancelled
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                throw AppError.offline
            default:
                throw AppError.unreachable
            }
        } catch is CancellationError {
            throw AppError.cancelled
        } catch {
            throw AppError.unreachable
        }
    }

    /// Same rule as the web dashboard: a non-2xx status, or a body carrying an
    /// "error", is a failure, described by the server's own words.
    private static func check(data: Data, status: Int) throws {
        if (200..<300).contains(status) {
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let error = json["error"] as? String,
                  !error.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            throw AppError(message: error, status: status)
        }
        if status == 401 { throw AppError.signedOut }
        throw AppError(message: reason(in: data) ?? fallback(for: status), status: status)
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
        case 403: return "Your account can't do that."
        case 404: return "That is no longer available. Pull down to refresh."
        case 409: return "That changed a moment ago. Pull down to see the latest."
        case 429: return "Too many tries. Wait a minute and try again."
        case 500...599: return "AssembleAtEase is not responding right now. Try again in a minute."
        default: return "That did not go through. Try again."
        }
    }

    static func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}
