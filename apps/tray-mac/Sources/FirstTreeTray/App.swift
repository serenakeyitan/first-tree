import SwiftUI
import AppKit
import UserNotifications

/// Resolve the daemon's HTTP port from `~/.first-tree/github-scan/config.yaml`.
/// Falls back to 7878 (the daemon default) if the file is missing, unreadable,
/// or doesn't contain a port. Cached for the lifetime of the app — restart the
/// tray after changing config.
let daemonHTTPPort: Int = {
    let configPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".first-tree/github-scan/config.yaml")
    guard let raw = try? String(contentsOf: configPath, encoding: .utf8) else { return 7878 }
    for line in raw.split(separator: "\n") {
        // Match `http_port: 12345`. Tolerate inline comments + leading whitespace.
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("http_port:") {
            let value = trimmed.dropFirst("http_port:".count)
                .split(separator: "#").first.map(String.init) ?? ""
            if let port = Int(value.trimmingCharacters(in: .whitespaces)), port > 0, port < 65_536 {
                return port
            }
        }
    }
    return 7878
}()

/// Base URL the tray should use to talk to the daemon.
let daemonBaseURL = "http://127.0.0.1:\(daemonHTTPPort)"

/// Send a non-blocking macOS notification (corner banner). Used for state
/// drifts the user should know about but shouldn't be modal-interrupted by.
@MainActor
func postUserNotification(title: String, body: String) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert]) { granted, _ in
        guard granted else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        center.add(req)
    }
}

// MARK: - Model

/// One of the four whitelisted action kinds the daemon's enrichment worker
/// is allowed to produce. Mirrors the TS-side `Action` discriminated union.
/// The tray validates this AGAIN before dispatching, so even if the daemon
/// were compromised the tray's whitelist holds.
enum ActionKind: String, Codable, Hashable {
    case approvePr = "approve_pr"
    case comment = "comment"
    case closeIssue = "close_issue"
    case requestChanges = "request_changes"
}

/// LLM-produced action recommendation for a `human` inbox entry.
/// `args` is an opaque dictionary because the per-kind shape varies; the
/// dispatcher decodes it per-kind under a strict whitelist.
struct InboxRecommendation: Hashable {
    let summary: String
    let rationale: String
    let actionKind: ActionKind
    let actionArgs: [String: AnyCodable]
}

struct InboxItem: Identifiable, Hashable {
    let id: String
    let number: Int
    let type: String
    let repo: String
    let title: String
    let htmlURL: URL
    let recommendation: InboxRecommendation?

    var repoShort: String {
        repo.split(separator: "/").last.map(String.init) ?? repo
    }

    var symbolName: String {
        switch type {
        case "PullRequest": return "arrow.triangle.pull"
        case "Issue":       return "smallcircle.filled.circle"
        case "Discussion":  return "bubble.left"
        case "Release":     return "shippingbox"
        default:            return "bell"
        }
    }
}

/// Type-erased Codable value for action.args so we can serialize back to
/// the daemon (or shell out) without knowing every action kind's shape
/// at this layer. Strictly limited to JSON primitives.
struct AnyCodable: Hashable, Codable {
    let value: AnyHashable

    init(_ value: AnyHashable) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s; return }
        if let i = try? c.decode(Int.self) { value = i; return }
        if let d = try? c.decode(Double.self) { value = d; return }
        if let b = try? c.decode(Bool.self) { value = b; return }
        if c.decodeNil() { value = "" as AnyHashable; return }
        throw DecodingError.dataCorruptedError(
            in: c,
            debugDescription: "AnyCodable: unsupported value"
        )
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let s as String: try c.encode(s)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let b as Bool: try c.encode(b)
        default: try c.encodeNil()
        }
    }
}

enum DaemonState {
    case loading
    case offline
    case paused
    case idle           // online, 0 unseen human items
    case working        // online, ≥1 unseen human item
}

// MARK: - Inbox client

@MainActor
final class InboxModel: ObservableObject {
    @Published var allItems: [InboxItem] = []
    @Published var seen: Set<String> = []
    @Published var state: DaemonState = .loading
    @Published var lastError: String? = nil

    private var timer: Timer?
    private let endpoint = URL(string: "\(daemonBaseURL)/inbox")!
    private let pollInterval: TimeInterval = 5
    private let offlineThreshold = 3
    private var consecutiveFailures = 0
    private(set) var pausedByUser = false
    /// Set when user pauses; used to suppress "daemon still alive" notifications
    /// for the first 30s (give pauseDaemon time to actually take effect).
    private var pausedAt: Date? = nil
    /// Track whether we've already notified about this paused-but-running drift,
    /// so we don't spam every 5s.
    private var notifiedDriftWhilePaused = false

    /// File where the seen set is persisted. Survives tray restarts so users don't
    /// see clicked rows reappear as unread.
    private let seenFile: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".first-tree/tray-seen.json")
    }()

    init() {
        seen = loadSeen()
    }

    var unseenItems: [InboxItem] { allItems.filter { !seen.contains($0.id) } }
    var unseenCount: Int { unseenItems.count }

    func start() {
        Task { await self.refresh() }
        let t = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { await self?.refresh() }
        }
        // Run in common mode so the timer keeps firing while the menu bar
        // dropdown is open (default mode is paused during menu tracking).
        RunLoop.main.add(t, forMode: .common)
        timer = t

        // Listen for macOS wake events. After a sleep, daemon data is stale
        // and we should re-poll immediately rather than waiting up to 5s for
        // the next tick. NSWorkspace publishes this on .didWakeNotification.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                // Reset failure counter so a single immediate failure post-wake
                // doesn't tip us over the offline threshold.
                self.consecutiveFailures = 0
                await self.refresh()
            }
        }
    }

    private func loadSeen() -> Set<String> {
        guard let data = try? Data(contentsOf: seenFile),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return Set(arr)
    }

    private func saveSeen() {
        let dir = seenFile.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Array(seen).sorted()) {
            try? data.write(to: seenFile, options: .atomic)
        }
    }

    func markSeen(_ id: String) {
        seen.insert(id)
        saveSeen()
        recomputeState()
    }

    func markPaused(_ paused: Bool) {
        pausedByUser = paused
        if paused {
            state = .paused
            pausedAt = Date()
            notifiedDriftWhilePaused = false
        } else {
            state = .loading
            pausedAt = nil
            notifiedDriftWhilePaused = false
            Task { await self.refresh() }
        }
    }

    func refresh() async {
        // While paused, we don't poll for inbox data — but we DO check whether
        // the daemon is actually still alive, so we can warn the user via a
        // macOS notification if pause silently failed (or the daemon was
        // resumed externally). We never silently flip state out of paused;
        // the user has to click Resume to acknowledge.
        if pausedByUser {
            // Skip detection for the first 30s after pause — gives pauseDaemon
            // time to actually take effect.
            let recentlyPaused = pausedAt.map { Date().timeIntervalSince($0) < 30 } ?? false
            if !recentlyPaused, !notifiedDriftWhilePaused {
                var req = URLRequest(url: endpoint)
                req.timeoutInterval = 2
                if let (_, resp) = try? await URLSession.shared.data(for: req),
                   let http = resp as? HTTPURLResponse,
                   http.statusCode == 200 {
                    notifiedDriftWhilePaused = true
                    postUserNotification(
                        title: "Daemon is still running",
                        body: "first-tree daemon is alive even though the menu bar shows Paused. Click Resume in the menu to sync, or run `first-tree github scan stop` in a terminal."
                    )
                }
            }
            return
        }
        do {
            var req = URLRequest(url: endpoint)
            req.timeoutInterval = 4
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                handleFailure("HTTP \(((resp as? HTTPURLResponse)?.statusCode).map(String.init) ?? "?")")
                return
            }
            let parsed = try JSONDecoder().decode(InboxResponse.self, from: data)
            let items: [InboxItem] = parsed.notifications
                .filter { $0.github_scan_status == "human" }
                .compactMap { n in
                    guard let url = URL(string: n.html_url) else { return nil }
                    let rec: InboxRecommendation? = {
                        guard let r = n.recommendation,
                              let kind = ActionKind(rawValue: r.action.kind)
                        else { return nil }
                        return InboxRecommendation(
                            summary: r.summary,
                            rationale: r.rationale,
                            actionKind: kind,
                            actionArgs: r.action.args
                        )
                    }()
                    return InboxItem(
                        id: n.id, number: n.number ?? 0, type: n.type,
                        repo: n.repo, title: n.title, htmlURL: url,
                        recommendation: rec
                    )
                }
            // GC: drop seen IDs the daemon no longer tracks (item resolved/removed).
            // Only persist if the set actually changed, to avoid unnecessary writes.
            let liveIDs = Set(items.map(\.id))
            let newSeen = seen.intersection(liveIDs)
            if newSeen != seen {
                seen = newSeen
                saveSeen()
            }
            allItems = items
            consecutiveFailures = 0
            lastError = nil
            recomputeState()
        } catch {
            handleFailure(error.localizedDescription)
        }
    }

    private func handleFailure(_ msg: String) {
        consecutiveFailures += 1
        lastError = msg
        if consecutiveFailures >= offlineThreshold {
            state = .offline
            allItems = []
        }
    }

    private func recomputeState() {
        if pausedByUser { state = .paused; return }
        state = unseenCount > 0 ? .working : .idle
    }
}

// MARK: - Daemon controller

/// What the daemon controller is currently doing. Used by UI to show a live
/// "Starting… 3s" indicator instead of blocking on the click handler.
struct DaemonOperation {
    enum Phase {
        case starting
        case stopping
    }
    let phase: Phase
    let startedAt: Date
}

@MainActor
final class DaemonController: ObservableObject {
    @Published var isWorking = false   // true while a CLI shell-out is in flight
    @Published var operation: DaemonOperation? = nil
    @Published var elapsedSeconds: Int = 0

    private var elapsedTimer: Timer?

    private let stateFile: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".first-tree/tray-state.json")
    }()

    /// Fire-and-forget: kick off Resume/Start in the background. UI watches `operation`
    /// to render a live progress indicator. Errors surface via WindowManager alerts.
    func startResumeInBackground(inbox: InboxModel) {
        beginOperation(.starting)
        Task {
            defer { self.endOperation() }
            do {
                try await self.resumeDaemon()
                inbox.markPaused(false)
                // Trigger an immediate refresh so the inbox list populates the
                // moment Resume succeeds — without waiting for the next 5s tick.
                await inbox.refresh()
            } catch {
                WindowManager.shared.showError(
                    title: "Could not resume daemon",
                    message: "The daemon could not be resumed. Check that you have a tree-bound repo and a previously saved repo scope. You can also restart manually via `first-tree github scan start --allow-repo <owner/repo>` in a terminal.",
                    error: error
                )
            }
        }
    }

    func startPauseInBackground(inbox: InboxModel) {
        beginOperation(.stopping)
        Task {
            defer { self.endOperation() }
            do {
                try await self.pauseDaemon()
                inbox.markPaused(true)
            } catch {
                WindowManager.shared.showError(
                    title: "Could not pause daemon",
                    message: "The daemon failed to stop. It may already be stopped, or another process may be holding the lock. You can verify with `first-tree github scan status` in a terminal.",
                    error: error
                )
            }
        }
    }

    private func beginOperation(_ phase: DaemonOperation.Phase) {
        operation = DaemonOperation(phase: phase, startedAt: Date())
        elapsedSeconds = 0
        elapsedTimer?.invalidate()
        // Timer fires on the main run loop; we're already @MainActor-isolated.
        // Mutate @Published synchronously so SwiftUI sees the change immediately.
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self = self, let op = self.operation else { return }
                self.elapsedSeconds = Int(Date().timeIntervalSince(op.startedAt))
            }
        }
        // Make sure the timer fires even if the run loop is in a tracking mode
        // (e.g., menu open).
        if let t = elapsedTimer {
            RunLoop.main.add(t, forMode: .common)
        }
    }

    private func endOperation() {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        operation = nil
        elapsedSeconds = 0
    }

    /// Run a CLI command. Returns trimmed stdout on success, or throws.
    /// `cwd` defaults to the user's home; pass an explicit path for commands that
    /// need a tree-bound directory (e.g., `first-tree github scan start`).
    ///
    /// Performance note: this calls `first-tree` directly (not via `zsh -l`),
    /// which avoids ~900ms of shell startup overhead per call.
    @discardableResult
    func runCLI(_ args: [String], cwd: String? = nil) async throws -> String {
        isWorking = true
        defer { isWorking = false }
        let process = Process()
        let pipe = Pipe()
        let argv = Self.firstTreeInvocation(args: args)
        process.executableURL = URL(fileURLWithPath: argv.executable)
        process.arguments = argv.arguments
        if let cwd = cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        // Provide a minimal env so first-tree can find Node and the user's home.
        // We don't inherit the full login-shell env (~/.zshrc, etc.) because
        // first-tree only needs PATH for Node + HOME for ~/.first-tree state.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Self.runtimePath
        process.environment = env

        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            throw NSError(domain: "DaemonController", code: Int(process.terminationStatus),
                          userInfo: [NSLocalizedDescriptionKey: output])
        }
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Build a (executable, args) pair to invoke `first-tree`.
    /// Tries common install paths first; if none are executable, falls back to
    /// `/usr/bin/env first-tree …` which lets `env` resolve `first-tree` against
    /// our `runtimePath`. This handles non-default install locations (e.g.,
    /// pnpm/yarn global bins) without us hardcoding every possible path.
    private static func firstTreeInvocation(args: [String]) -> (executable: String, arguments: [String]) {
        let candidates = [
            "\(FileManager.default.homeDirectoryForCurrentUser.path)/.local/bin/first-tree",
            "/usr/local/bin/first-tree",
            "/opt/homebrew/bin/first-tree",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return (executable: path, arguments: args)
        }
        return (executable: "/usr/bin/env", arguments: ["first-tree"] + args)
    }

    /// PATH to provide to first-tree so it can find `node`, `gh`, and other deps.
    /// Includes nvm path (Node), Homebrew, /usr/local/bin, system bins.
    private static let runtimePath: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "\(home)/.local/bin",
            "\(home)/.nvm/versions/node/v22.22.1/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ].joined(separator: ":")
    }()

    /// Snapshot the daemon's full start configuration (allow-list, tree-repo,
    /// working directory) by reading the live launchd plist, then stop it.
    /// Persisted to `~/.first-tree/tray-state.json` so Resume can replay the exact
    /// same start command — no guessing, no missing flags.
    func pauseDaemon() async throws {
        if let snapshot = readDaemonPlistConfig() {
            saveState(
                allowedRepos: snapshot.allowedRepos,
                boundDir: snapshot.workingDirectory ?? findBoundDirectory(),
                treeRepo: snapshot.treeRepo
            )
        } else {
            // Fallback: if we can't read the plist (daemon never started or plist missing),
            // try the old path-based discovery so a partial save is still possible.
            let repos = (try? await fetchAllowedRepos()) ?? []
            let cwd = findBoundDirectory()
            if !repos.isEmpty || cwd != nil {
                saveState(allowedRepos: repos, boundDir: cwd, treeRepo: nil)
            }
        }
        try await runCLI(["github", "scan", "stop"])
    }

    /// Snapshot of the daemon's configuration as captured from its launchd plist.
    private struct DaemonPlistConfig {
        let allowedRepos: [String]
        let treeRepo: String?
        let workingDirectory: String?
    }

    /// Read the daemon's launchd plist and pull out the parameters it was started with.
    /// Returns nil if the plist doesn't exist or can't be parsed.
    ///
    /// The plist filename is `com.first-tree.github-scan.runner.<gh-identity>.default.plist`,
    /// where `<gh-identity>` is the user's GitHub login (NOT the macOS user). We don't know
    /// it ahead of time — glob the launchd dir and pick the first matching plist.
    private func readDaemonPlistConfig() -> DaemonPlistConfig? {
        let launchdDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".first-tree/github-scan/runner/launchd")

        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: launchdDir.path)
        else { return nil }

        // Find any "com.first-tree.github-scan.runner.<X>.default.plist". Skip .bak files.
        let plistName = entries.first(where: {
            $0.hasPrefix("com.first-tree.github-scan.runner.")
                && $0.hasSuffix(".default.plist")
        })
        guard let plistName = plistName else { return nil }
        let plistURL = launchdDir.appendingPathComponent(plistName)

        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }

        let workingDirectory = plist["WorkingDirectory"] as? String
        let args = (plist["ProgramArguments"] as? [String]) ?? []

        // Walk the args to find --allow-repo and --tree-repo values.
        var allowedRepos: [String] = []
        var treeRepo: String? = nil
        var i = 0
        while i < args.count {
            let arg = args[i]
            if arg == "--allow-repo", i + 1 < args.count {
                let csv = args[i + 1]
                allowedRepos = csv.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
                i += 2
            } else if arg == "--tree-repo", i + 1 < args.count {
                treeRepo = args[i + 1]
                i += 2
            } else {
                i += 1
            }
        }

        return DaemonPlistConfig(
            allowedRepos: allowedRepos,
            treeRepo: treeRepo,
            workingDirectory: workingDirectory
        )
    }

    /// Start the daemon using the allow-list + bound dir + tree-repo captured at the last pause.
    /// After issuing `start` (which only generates the launchd plist and returns immediately),
    /// poll the dashboard HTTP endpoint to verify the daemon actually came up. If it doesn't
    /// respond within ~20s, fetch the daemon log tail and throw with the real failure reason.
    func resumeDaemon() async throws {
        guard let state = loadState(), !state.allowedRepos.isEmpty else {
            throw NSError(domain: "DaemonController", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "No saved repo scope. Run `first-tree github scan start --allow-repo …` once to set it."
            ])
        }
        let cwd = state.boundDir ?? findBoundDirectory()
        guard let cwd = cwd else {
            throw NSError(domain: "DaemonController", code: -2, userInfo: [
                NSLocalizedDescriptionKey: "Could not find a tree-bound directory to start the daemon from. cd into your bound source repo and run `first-tree github scan start --allow-repo …` once."
            ])
        }
        // Build args: include --tree-repo if it was captured at pause time.
        var args = ["github", "scan", "start", "--allow-repo", state.allowedRepos.joined(separator: ",")]
        if let treeRepo = state.treeRepo, !treeRepo.isEmpty {
            args.append(contentsOf: ["--tree-repo", treeRepo])
        }
        try await runCLI(args, cwd: cwd)

        // `start` returns 0 once the launchd plist is generated, but the daemon may die
        // seconds later (e.g., the WorkingDirectory bug fixed in #381). Verify it actually
        // came up by probing the dashboard HTTP endpoint. Cold start can take 10-15s
        // (Node startup + first GitHub API call + dispatcher init), so wait generously.
        let healthy = await waitForDaemonHealth(timeoutSec: 20)
        if !healthy {
            let logTail = readLatestDaemonLogTail(lines: 12)
            throw NSError(domain: "DaemonController", code: -3, userInfo: [
                NSLocalizedDescriptionKey: """
                The `start` command returned success, but the daemon did not come up within 20 seconds. \
                Last lines of the daemon log:

                \(logTail.isEmpty ? "(no log found)" : logTail)
                """
            ])
        }
    }

    /// Probe the dashboard until it returns 200 or the timeout elapses.
    private func waitForDaemonHealth(timeoutSec: Int) async -> Bool {
        let url = URL(string: "\(daemonBaseURL)/inbox")!
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSec))
        while Date() < deadline {
            var req = URLRequest(url: url)
            req.timeoutInterval = 1.5
            if let (_, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse,
               http.statusCode == 200 {
                return true
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        return false
    }

    /// Read the tail of the most recent daemon log file. Used to surface real failure reasons.
    /// Uses `tail` via shell because reading sandbox-protected dirs from Swift can be flaky.
    private func readLatestDaemonLogTail(lines: Int) -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [
            "-l", "-c",
            "ls -t ~/.first-tree/github-scan/runner/logs/github-scan-daemon-*.log 2>/dev/null | head -1 | xargs tail -n \(lines) 2>/dev/null"
        ]
        process.standardOutput = pipe
        process.standardError = Pipe()  // discard stderr
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return ""
        }
    }

    /// Walk a small set of likely paths to find one with a `.first-tree/source.json` binding.
    /// Used as fallback if pause didn't capture a cwd.
    private func findBoundDirectory() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            home.appendingPathComponent("first-tree-website"),
            home.appendingPathComponent("first-tree-context"),
            home.appendingPathComponent("first-tree"),
        ]
        for url in candidates {
            let binding = url.appendingPathComponent(".first-tree/source.json")
            if FileManager.default.fileExists(atPath: binding.path) {
                return url.path
            }
        }
        return nil
    }

    /// Stop the daemon. Throws on failure so callers (e.g. the Quit flow) can
    /// surface the error instead of silently leaving the daemon running.
    func stop() async throws {
        try await runCLI(["github", "scan", "stop"])
    }

    /// Parse `first-tree github scan status` output and pull out the repo list.
    /// Output line example: `allowed repos: agent-team-foundation/first-tree, agent-team-foundation/foo`
    private func fetchAllowedRepos() async throws -> [String] {
        let output = try await runCLI(["github", "scan", "status"])
        for line in output.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("allowed repos:") {
                let value = trimmed.dropFirst("allowed repos:".count).trimmingCharacters(in: .whitespaces)
                if value == "all" { return [] }   // unsupported edge case for now
                return value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            }
        }
        return []
    }

    private struct PersistedState: Codable {
        let allowedRepos: [String]
        let boundDir: String?
        let treeRepo: String?
        let savedAt: Date
    }

    private func saveState(allowedRepos: [String], boundDir: String?, treeRepo: String?) {
        let dir = stateFile.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let payload = PersistedState(allowedRepos: allowedRepos, boundDir: boundDir, treeRepo: treeRepo, savedAt: Date())
        if let data = try? JSONEncoder().encode(payload) {
            try? data.write(to: stateFile, options: .atomic)
        }
    }

    private func loadState() -> PersistedState? {
        guard let data = try? Data(contentsOf: stateFile) else { return nil }
        return try? JSONDecoder().decode(PersistedState.self, from: data)
    }
}

// MARK: - JSON shape

private struct InboxResponse: Decodable {
    let notifications: [InboxNotification]
}

private struct InboxNotification: Decodable {
    let id: String
    let type: String
    let repo: String
    let title: String
    let html_url: String
    let number: Int?
    let github_scan_status: String?
    /// Island feature: present when the daemon's enrichment worker has
    /// produced an LLM action recommendation for this entry. Absent
    /// when the entry is not `human`-status, or when the LLM call
    /// failed / hadn't completed yet.
    let recommendation: InboxRecommendationWire?
}

/// Wire shape of the recommendation field. The daemon validates the
/// action shape at parse time, so by the time we get here it's
/// guaranteed to be one of the four whitelisted kinds. We re-validate
/// here anyway (defense in depth) before constructing InboxRecommendation.
private struct InboxRecommendationWire: Decodable {
    let summary: String
    let rationale: String
    let action: InboxActionWire
}

private struct InboxActionWire: Decodable {
    let kind: String
    let args: [String: AnyCodable]
}

// MARK: - App

@main
struct FirstTreeTrayApp: App {
    @StateObject private var inbox = InboxModel()
    @StateObject private var daemon = DaemonController()
    // Island feature.
    @StateObject private var sse = IslandSSEClient()
    @StateObject private var ignored = IgnoredStore()
    @StateObject private var islandSettings = IslandSettings()

    var body: some Scene {
        MenuBarExtra {
            DropdownView()
                .environmentObject(inbox)
                .environmentObject(daemon)
                .environmentObject(ignored)
                .environmentObject(islandSettings)
        } label: {
            TrayLabel()
                .environmentObject(inbox)
                .environmentObject(sse)
                .environmentObject(ignored)
                .environmentObject(islandSettings)
                .onAppear {
                    // Inject the env objects into the island root view's
                    // hosting controller. The NSPanel is created lazily
                    // by IslandWindowManager.present(), so this onAppear
                    // is just a safe place to start the SSE stream.
                    sse.start()
                    IslandEnvironmentBridge.shared.attach(
                        inbox: inbox, sse: sse, ignored: ignored,
                        settings: islandSettings
                    )
                }
        }
        .menuBarExtraStyle(.window)
    }
}

/// Bridges the SwiftUI app-scene env objects into the IslandRootView
/// that lives inside the NSPanel hosted by IslandWindowManager. We can't
/// just write `.environmentObject(...)` on the panel's hosting view
/// because the panel is created in AppKit-land outside the App scene's
/// view tree.
@MainActor
final class IslandEnvironmentBridge {
    static let shared = IslandEnvironmentBridge()
    private init() {}

    private(set) var inbox: InboxModel?
    private(set) var sse: IslandSSEClient?
    private(set) var ignored: IgnoredStore?
    private(set) var settings: IslandSettings?

    func attach(
        inbox: InboxModel,
        sse: IslandSSEClient,
        ignored: IgnoredStore,
        settings: IslandSettings
    ) {
        self.inbox = inbox
        self.sse = sse
        self.ignored = ignored
        self.settings = settings
    }
}

// MARK: - Tray icon

struct TrayLabel: View {
    @EnvironmentObject var inbox: InboxModel

    var body: some View {
        HStack(spacing: 3) {
            iconImage
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 10, height: 12)
                .opacity(iconOpacity)
            if inbox.unseenCount > 0 {
                Text("\(inbox.unseenCount)")
                    .font(.system(size: 12, weight: .semibold))
            }
        }
        .onAppear { inbox.start() }
    }

    private var iconImage: Image {
        if let url = Bundle.module.url(forResource: "FirstTreeIcon", withExtension: "png"),
           let nsImage = NSImage(contentsOf: url) {
            nsImage.isTemplate = true
            return Image(nsImage: nsImage)
        }
        return Image(systemName: "tree.fill")
    }

    private var iconOpacity: Double {
        switch inbox.state {
        case .loading: return 0.5
        case .offline: return 0.4
        case .paused:  return 0.5
        case .idle:    return 0.7
        case .working: return 1.0
        }
    }
}

// MARK: - Dropdown

struct DropdownView: View {
    @EnvironmentObject var inbox: InboxModel
    @EnvironmentObject var daemon: DaemonController
    @EnvironmentObject var ignored: IgnoredStore
    @EnvironmentObject var islandSettings: IslandSettings
    @Environment(\.openURL) var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StatusRow()
                .environmentObject(inbox)
                .environmentObject(daemon)
            Divider().padding(.horizontal, 4).padding(.vertical, 2)
            content
            ignoredSection
            islandSection
            Divider().padding(.horizontal, 4).padding(.vertical, 2)
            FooterButton(title: "Open dashboard", systemImage: "rectangle.on.rectangle") {
                openURL(URL(string: "\(daemonBaseURL)/")!)
            }
            FooterButton(title: "Preferences…", systemImage: "gearshape") {
                WindowManager.shared.openPreferences(daemon: daemon)
            }
            FooterButton(title: "Quit", systemImage: "power") {
                WindowManager.shared.openQuitConfirm(inbox: inbox, daemon: daemon)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 4)
        .frame(minWidth: 240, idealWidth: 260, maxWidth: 320)
    }

    /// Items the user has clicked Ignore on (island feature). They stay
    /// in the dropdown so the user can revisit them. They count toward
    /// the unseen badge until the daemon transitions them out of `human`.
    @ViewBuilder
    private var ignoredSection: some View {
        let ignoredItems = inbox.allItems.filter { ignored.ignored.contains($0.id) }
        if !ignoredItems.isEmpty {
            Divider().padding(.horizontal, 4).padding(.vertical, 2)
            HStack(spacing: 6) {
                Image(systemName: "tray.full")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                Text("Ignored (\(ignoredItems.count))")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal, 6).padding(.vertical, 3)
            ForEach(ignoredItems) { item in
                InboxRow(item: item, seen: false)
                    .onTapGesture { openURL(item.htmlURL) }
            }
        }
    }

    /// Island controls section:
    ///   - On/Off toggle (global kill switch for the popup)
    ///   - "Show ignored as islands again" — clears the dismissed-IDs set
    ///     so next time the daemon emits recommendation events for those
    ///     items, they re-pop. Useful when the user changes their mind
    ///     after dismissing.
    private var islandSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider().padding(.horizontal, 4).padding(.vertical, 2)
            HStack(spacing: 8) {
                Image(systemName: "rectangle.on.rectangle.angled")
                    .frame(width: 16)
                Text("Island popups")
                    .font(.system(size: 13))
                Spacer()
                Toggle("", isOn: $islandSettings.enabled)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 6)
            FooterButton(title: "Show ignored items again", systemImage: "arrow.uturn.backward.circle") {
                IslandWindowManager.shared.forgetDismissed()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch inbox.state {
        case .loading:
            statusLine(systemImage: "ellipsis.circle", text: "Loading…")
        case .offline:
            statusLine(systemImage: "exclamationmark.triangle", text: "Daemon offline")
        case .paused:
            // Frozen snapshot at moment of pause; clicks still work.
            if inbox.allItems.isEmpty {
                statusLine(systemImage: "checkmark.circle", text: "All clear")
            } else {
                itemsList
            }
        case .idle:
            if inbox.allItems.isEmpty {
                statusLine(systemImage: "checkmark.circle", text: "All clear")
            } else {
                itemsList
            }
        case .working:
            itemsList
        }
    }

    private var itemsList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(inbox.allItems) { item in
                InboxRow(item: item, seen: inbox.seen.contains(item.id))
                    .onTapGesture {
                        inbox.markSeen(item.id)
                        openURL(item.htmlURL)
                    }
            }
        }
    }

    private func statusLine(systemImage: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .frame(width: 16)
                .foregroundStyle(.primary)
            Text(text).font(.system(size: 13))
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 6)
    }
}

// MARK: - Status row (top of dropdown)

struct StatusRow: View {
    @EnvironmentObject var inbox: InboxModel
    @EnvironmentObject var daemon: DaemonController

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.system(size: 13, weight: .medium))
            Spacer(minLength: 12)
            actionButton
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
    }

    private var dotColor: Color {
        switch inbox.state {
        case .loading: return .gray
        case .offline: return .red
        case .paused:  return .yellow
        case .idle, .working: return .green
        }
    }

    private var label: String {
        switch inbox.state {
        case .loading: return "Starting…"
        case .offline: return "Offline"
        case .paused:  return "Paused"
        case .idle, .working: return "Online"
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        if let op = daemon.operation {
            // In-progress indicator. Starting shows live counter (cold start can take 10-15s).
            // Stopping just shows a spinner — it's usually < 1s so a counter is noise.
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.5).frame(width: 14, height: 14)
                Text(op.phase == .starting
                     ? "Starting… \(daemon.elapsedSeconds)s"
                     : "Stopping…")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .fixedSize()
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6)
        } else {
            switch inbox.state {
            case .loading:
                EmptyView()
            case .offline:
                ControlButton(label: "Start", systemImage: "play.fill") {
                    daemon.startResumeInBackground(inbox: inbox)
                }
            case .paused:
                ControlButton(label: "Resume", systemImage: "play.fill") {
                    daemon.startResumeInBackground(inbox: inbox)
                }
            case .idle, .working:
                ControlButton(label: "Pause", systemImage: "pause.fill") {
                    daemon.startPauseInBackground(inbox: inbox)
                }
            }
        }
    }
}

struct ControlButton: View {
    let label: String
    let systemImage: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(hover ? Color.primary.opacity(0.16) : Color.primary.opacity(0.08))
        )
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: action)
    }
}

// MARK: - Footer button

struct FooterButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .frame(width: 16)
            Text(title).font(.system(size: 13))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .padding(.vertical, 5)
        .padding(.horizontal, 6)
        .background(hover ? Color.primary.opacity(0.08) : .clear)
        .cornerRadius(4)
        .onHover { hover = $0 }
        .onTapGesture(perform: action)
    }
}

// MARK: - Inbox row

struct InboxRow: View {
    let item: InboxItem
    let seen: Bool
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: item.symbolName)
                .frame(width: 16, height: 16)
                .foregroundStyle(.primary)
            Text("\(item.repoShort) · #\(item.number)")
                .font(.system(size: 13))
                .strikethrough(seen, color: .secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(seen ? 0.45 : 1.0)
        .contentShape(Rectangle())
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(hover ? Color.primary.opacity(0.08) : .clear)
        .cornerRadius(4)
        .onHover { hover = $0 }
    }
}

// MARK: - Window manager (standalone NSWindows so MenuBarExtra dropdown stays clean)

@MainActor
final class WindowManager {
    static let shared = WindowManager()

    private var preferencesWindow: NSWindow?
    private var quitConfirmWindow: NSWindow?

    func openPreferences(daemon: DaemonController) {
        if let w = preferencesWindow {
            centerOnMainScreen(w)
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let view = PreferencesView(daemon: daemon, onClose: { [weak self] in
            self?.preferencesWindow?.close()
        })
        let host = NSHostingController(rootView: view)
        let w = NSWindow(contentViewController: host)
        w.title = "first-tree preferences"
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.setContentSize(NSSize(width: 460, height: 360))
        centerOnMainScreen(w)
        w.delegate = WindowCloseObserver.shared
        preferencesWindow = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func openQuitConfirm(inbox: InboxModel, daemon: DaemonController) {
        if let w = quitConfirmWindow {
            centerOnMainScreen(w)
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let view = QuitConfirmView(
            onPauseInstead: { [weak self] in
                // Actually stop the daemon — markPaused alone leaves the daemon
                // running, which would (a) trigger the self-heal drift notification
                // 30s later and (b) make a subsequent Resume fail with "already
                // running". Reuses the same fire-and-forget path as the menu
                // bar's Pause button.
                daemon.startPauseInBackground(inbox: inbox)
                self?.quitConfirmWindow?.close()
            },
            onCancel: { [weak self] in
                self?.quitConfirmWindow?.close()
            },
            onQuit: { [weak self] in
                Task {
                    do {
                        try await daemon.stop()
                        NSApp.terminate(nil)
                    } catch {
                        // Daemon couldn't be stopped — DON'T quit. Show the user the
                        // real error and let them decide whether to force-quit anyway
                        // (which would leave the daemon running) or stay open.
                        self?.quitConfirmWindow?.close()
                        WindowManager.shared.showQuitFailed(daemon: daemon, error: error)
                    }
                }
            }
        )
        let host = NSHostingController(rootView: view)
        let w = NSWindow(contentViewController: host)
        w.title = "Quit first-tree?"
        w.styleMask = [.titled, .closable]
        w.isReleasedWhenClosed = false
        w.setContentSize(NSSize(width: 420, height: 220))
        centerOnMainScreen(w)
        w.delegate = WindowCloseObserver.shared
        quitConfirmWindow = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Center on the screen where the cursor currently is — better than `NSWindow.center()`
    /// which uses the focused screen and can stick to the wrong display in multi-monitor setups.
    private func centerOnMainScreen(_ window: NSWindow) {
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { return }
        let size = window.frame.size
        let x = visible.midX - size.width / 2
        let y = visible.midY - size.height / 2
        window.setFrameOrigin(NSPoint(x: x, y: y))
    }

    func didClose(_ window: NSWindow) {
        if window === preferencesWindow { preferencesWindow = nil }
        if window === quitConfirmWindow { quitConfirmWindow = nil }
    }

    /// Display an error to the user as a modal alert with a Copy details button.
    /// Use for any failure the user should know about: daemon control errors, network issues, etc.
    func showError(title: String, message: String, error: Error? = nil) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let detailsBody: String = {
            var lines: [String] = [
                title,
                "",
                message,
            ]
            if let error = error {
                lines.append("")
                lines.append("Error: \(error.localizedDescription)")
                let nsError = error as NSError
                if nsError.code != 0 {
                    lines.append("Code: \(nsError.code)")
                }
                if !nsError.domain.isEmpty {
                    lines.append("Domain: \(nsError.domain)")
                }
            }
            lines.append("")
            lines.append("Time: \(timestamp)")
            lines.append("App: first-tree tray 0.1")
            lines.append("macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)")
            return lines.joined(separator: "\n")
        }()

        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Copy details")

        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()

        if response == .alertSecondButtonReturn {
            // User clicked "Copy details"
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(detailsBody, forType: .string)

            // Confirm via brief follow-up notification
            let confirm = NSAlert()
            confirm.messageText = "Copied to clipboard"
            confirm.informativeText = "Paste it into your bug report or send it to the team."
            confirm.alertStyle = .informational
            confirm.addButton(withTitle: "OK")
            confirm.runModal()
        }
    }

    /// Specialized alert when Quit's stop call fails. Lets the user choose
    /// between "force quit anyway" (daemon stays running in background) or
    /// "cancel" (stay open and let them try again).
    func showQuitFailed(daemon: DaemonController, error: Error) {
        let alert = NSAlert()
        alert.messageText = "Could not stop daemon"
        alert.informativeText = """
            The daemon failed to stop, so the menu bar will stay open. \
            You can try Quit again, or force quit anyway — but then the daemon \
            will keep running in the background until you stop it manually with \
            `first-tree github scan stop`.

            Error: \(error.localizedDescription)
            """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Stay open")
        alert.addButton(withTitle: "Force quit anyway")

        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        if response == .alertSecondButtonReturn {
            NSApp.terminate(nil)
        }
        // else: stay open, user can retry Quit
    }
}

final class WindowCloseObserver: NSObject, NSWindowDelegate {
    static let shared = WindowCloseObserver()
    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow else { return }
        Task { @MainActor in WindowManager.shared.didClose(window) }
    }
}

// MARK: - Quit confirmation view

struct QuitConfirmView: View {
    let onPauseInstead: () -> Void
    let onCancel: () -> Void
    let onQuit: () -> Void
    @State private var copied = false

    private let restartCommand = "first-tree github scan start"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Quit first-tree?")
                .font(.system(size: 15, weight: .semibold))

            VStack(alignment: .leading, spacing: 8) {
                Text("This will stop the daemon. To resume agent monitoring, run this in a terminal, or relaunch the app:")
                    .font(.system(size: 12))

                HStack(spacing: 6) {
                    Text(restartCommand)
                        .font(.system(size: 12, design: .monospaced))
                        .padding(.vertical, 5)
                        .padding(.horizontal, 8)
                        .background(Color.primary.opacity(0.08))
                        .cornerRadius(4)
                    Button(copied ? "Copied" : "Copy") {
                        let pb = NSPasteboard.general
                        pb.clearContents()
                        pb.setString(restartCommand, forType: .string)
                        copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            copied = false
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.system(size: 11, weight: .medium))
                }

                Text("Pause instead — keeps the daemon alive so you can resume instantly from the menu.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }

            HStack(spacing: 8) {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Quit", role: .destructive, action: onQuit)
                Button("Pause Instead", action: onPauseInstead)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

// MARK: - Preferences view

struct PreferencesView: View {
    let daemon: DaemonController
    let onClose: () -> Void

    @State private var copiedScope = false
    @State private var copiedUpgrade = false
    @State private var latestVersion: String? = nil
    @State private var checkingUpdates = false

    private let currentVersion = "0.3.1-alpha"

    private let scopePrompt = "I want to change the first-tree github scan repo scope. Current allow-list: <FILL IN — run `first-tree github scan status` to see>. Update to: <FILL IN — comma-separated list of owner/repo>. After updating, restart the daemon and confirm the new scope is live."

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Preferences")
                .font(.system(size: 16, weight: .semibold))

            // Repo scope section
            VStack(alignment: .leading, spacing: 6) {
                Text("Repo scope")
                    .font(.system(size: 13, weight: .semibold))
                Text("Change which repos the daemon polls. Click Copy and paste in Claude Code or Codex — the agent will guide the update.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                CopyableBlock(
                    text: scopePrompt,
                    label: copiedScope ? "Copied" : "Copy prompt"
                ) {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString(scopePrompt, forType: .string)
                    copiedScope = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        copiedScope = false
                    }
                }
            }

            Divider()

            // Version + updates section
            VStack(alignment: .leading, spacing: 6) {
                Text("Version")
                    .font(.system(size: 13, weight: .semibold))
                HStack(spacing: 4) {
                    Text("Current:")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    Text("v\(currentVersion)")
                        .font(.system(size: 12, design: .monospaced))
                    Spacer()
                    if checkingUpdates {
                        ProgressView().scaleEffect(0.6).frame(width: 16, height: 16)
                    } else if let latest = latestVersion {
                        if latest == currentVersion {
                            Text("Up to date")
                                .font(.system(size: 11))
                                .foregroundStyle(.green)
                        } else {
                            Text("v\(latest) available")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.orange)
                        }
                    } else {
                        Button("Check for updates") {
                            Task { await self.checkUpdates() }
                        }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11))
                    }
                }

                if let latest = latestVersion, latest != currentVersion {
                    Text("To upgrade, paste this in Claude Code or Codex:")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                    let prompt = "Upgrade my first-tree from v\(currentVersion) to v\(latest). After upgrading, restart the daemon and confirm the new version is running."
                    CopyableBlock(
                        text: prompt,
                        label: copiedUpgrade ? "Copied" : "Copy upgrade prompt"
                    ) {
                        let pb = NSPasteboard.general
                        pb.clearContents()
                        pb.setString(prompt, forType: .string)
                        copiedUpgrade = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            copiedUpgrade = false
                        }
                    }
                }
            }

            Spacer(minLength: 4)

            HStack {
                Spacer()
                Button("Close", action: onClose)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { Task { await self.checkUpdates() } }
    }

    private func checkUpdates() async {
        checkingUpdates = true
        defer { checkingUpdates = false }
        guard let url = URL(string: "https://api.github.com/repos/agent-team-foundation/first-tree/releases/latest") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            if let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let tag = obj["tag_name"] as? String {
                latestVersion = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            }
        } catch {
            // Silent — no network or rate-limited; user can retry.
        }
    }
}

struct CopyableBlock: View {
    let text: String
    let label: String
    let onCopy: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(text)
                .font(.system(size: 11, design: .monospaced))
                .lineSpacing(2)
                .padding(.vertical, 8)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.06))
                .cornerRadius(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Button(label, action: onCopy)
                .buttonStyle(.borderless)
                .font(.system(size: 11, weight: .medium))
        }
    }
}
