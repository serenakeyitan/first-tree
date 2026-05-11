// Island feature: SSE client, NSPanel popup window, three-button decision
// UI, whitelisted gh dispatcher, ignore tracking, and the dropdown section
// for previously-ignored items.
//
// Lives in a separate file from App.swift so the two-screen MenuBarExtra
// vs floating-NSPanel architectures stay visibly distinct.
//
// Wire contract (matches packages/github-scan/src/.../engine/daemon):
//   GET  /inbox       returns notifications with optional `recommendation`
//   GET  /events      SSE; `event: recommendation\ndata: {id,summary,...}\n`
//   POST /inbox/:id/translate   { text } → { ok, summary, rationale, action }
//
// SECURITY NOTE: every action that shells out to `gh` is dispatched via
// `IslandActionDispatcher.execute`, which constructs an argv array from
// the validated whitelist. We NEVER use `bash -c` or string concatenation.

import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: - Settings

/// Persistent island-feature settings. Backed by UserDefaults so the
/// user's choices survive tray restarts.
///
/// Today the only knob is `enabled` — a global kill switch users can
/// flip from the menu bar dropdown when they don't want the popup
/// (presenting, demo, focus modes, etc.). When `enabled` is false the
/// SSE client still receives events but does NOT pop the panel.
@MainActor
final class IslandSettings: ObservableObject {
    @Published var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        }
    }

    private static let enabledKey = "island.enabled"

    init() {
        // Default to true. If the key has never been set,
        // UserDefaults.bool returns false — so we override with `object(forKey:)`
        // nil check.
        if let stored = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool {
            self.enabled = stored
        } else {
            self.enabled = true
        }
    }
}

// MARK: - SSE client

/// Minimal SSE consumer for the daemon's `/events` endpoint. Reconnects on
/// disconnect with capped exponential backoff. Lives for the lifetime of
/// the tray app.
@MainActor
final class IslandSSEClient: NSObject, ObservableObject, URLSessionDataDelegate {
    /// Most recent recommendation event observed. SwiftUI views observe
    /// this via `@Published` to drive island show/hide.
    @Published var latest: RecommendationEvent? = nil

    struct RecommendationEvent: Hashable {
        let id: String
        let summary: String
        let actionKind: ActionKind
        let receivedAt: Date
    }

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var reconnectAttempt = 0
    private var connecting = false
    /// Set when the app is shutting down so the stream loop stops.
    private var stopped = false

    func start() {
        guard !connecting, task == nil else { return }
        connect()
    }

    func stop() {
        stopped = true
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    private func connect() {
        guard !stopped else { return }
        connecting = true
        let url = URL(string: "\(daemonBaseURL)/events")!
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // SSE servers often respond with `Connection: close` between
        // events; let URLSession reuse the connection regardless.
        req.timeoutInterval = .infinity

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 600
        config.timeoutIntervalForResource = .infinity
        // Don't pollute caches with the event stream.
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        let s = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        let t = s.dataTask(with: req)
        t.resume()
        session = s
        task = t
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        reconnectAttempt = min(reconnectAttempt + 1, 6)
        // 0.5s, 1s, 2s, 4s, 8s, 16s, 30s cap.
        let delay = min(pow(2.0, Double(reconnectAttempt - 1)) * 0.5, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connecting = false
            self?.task = nil
            self?.session = nil
            self?.connect()
        }
    }

    // MARK: URLSessionDataDelegate

    nonisolated func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        // Reset reconnect attempts on a successful 200.
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            DispatchQueue.main.async { [weak self] in self?.reconnectAttempt = 0 }
        }
        completionHandler(.allow)
    }

    nonisolated func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.handleChunk(data)
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.scheduleReconnect()
        }
    }

    // MARK: Frame parsing

    /// Parse SSE frames. The Rust+TS server emits compact frames:
    ///   event: <name>\n
    ///   data: <line>\n
    ///   \n
    /// We accumulate bytes in `buffer`, split on the blank-line frame
    /// terminator, and route by event name.
    private func handleChunk(_ chunk: Data) {
        buffer.append(chunk)
        // SSE frame terminator: \n\n
        while let range = buffer.range(of: Data("\n\n".utf8)) {
            let frameData = buffer.subdata(in: 0..<range.lowerBound)
            buffer.removeSubrange(0..<range.upperBound)
            guard let frame = String(data: frameData, encoding: .utf8) else { continue }
            handleFrame(frame)
        }
    }

    private func handleFrame(_ frame: String) {
        var event: String? = nil
        var dataLines: [String] = []
        for raw in frame.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("event: ") {
                event = String(line.dropFirst("event: ".count))
            } else if line.hasPrefix("data: ") {
                dataLines.append(String(line.dropFirst("data: ".count)))
            } else if line.hasPrefix(":") {
                // comment-only frame (keepalive) — ignore
            }
        }
        guard event == "recommendation",
              let payloadStr = dataLines.joined(separator: "\n").data(using: .utf8)
        else { return }

        struct Payload: Decodable {
            let id: String
            let summary: String
            let action_kind: String
        }
        guard let p = try? JSONDecoder().decode(Payload.self, from: payloadStr),
              let kind = ActionKind(rawValue: p.action_kind)
        else { return }

        let ev = RecommendationEvent(
            id: p.id,
            summary: p.summary,
            actionKind: kind,
            receivedAt: Date()
        )
        latest = ev
        // Show the island. The window manager owns dedup logic — repeated
        // events for the same id within a short window do nothing.
        // Respect the global island-enable toggle the user can flip from
        // the menu bar dropdown; the SSE event is still recorded in
        // `latest` so a "Show latest island" action could re-pop later.
        if let settings = IslandEnvironmentBridge.shared.settings, !settings.enabled {
            return
        }
        IslandWindowManager.shared.present(eventID: ev.id)
    }
}

// MARK: - Ignored items persistence

/// Items the user has clicked Ignore on. Persisted across tray restarts so
/// the menu bar dropdown still shows them (and lets the user revisit).
/// Cleared when the daemon transitions the entry out of `human` (the
/// regular GC in InboxModel takes care of that).
@MainActor
final class IgnoredStore: ObservableObject {
    @Published private(set) var ignored: Set<String> = []

    private let path: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".first-tree/tray-ignored.json")
    }()

    init() { ignored = load() }

    func add(_ id: String) {
        ignored.insert(id)
        save()
    }

    /// Drop ids no longer in the live human-entries set. Called from
    /// InboxModel.refresh's GC path.
    func gc(liveIDs: Set<String>) {
        let next = ignored.intersection(liveIDs)
        if next != ignored {
            ignored = next
            save()
        }
    }

    private func load() -> Set<String> {
        guard let data = try? Data(contentsOf: path),
              let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return Set(arr)
    }

    private func save() {
        let dir = path.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Array(ignored).sorted()) {
            try? data.write(to: path, options: .atomic)
        }
    }
}

// MARK: - Whitelisted action dispatcher

/// Executes a whitelisted Action by shelling out to `gh`. Args are passed
/// as a Process argv array — never string-concatenated into a shell — so
/// even if a `body` contains `; rm -rf` the shell never sees it.
@MainActor
enum IslandActionDispatcher {

    enum Result {
        case ok(stdout: String)
        case failed(message: String)
    }

    static func execute(item: InboxItem, kind: ActionKind, args: [String: AnyCodable]) async -> Result {
        let argv: [String]
        do {
            argv = try buildArgv(kind: kind, args: args)
        } catch {
            return .failed(message: "invalid action args: \(error.localizedDescription)")
        }
        return await runGh(repo: item.repo, args: argv)
    }

    /// Free-text raw `gh` mode (Do other... → toggle to raw). The user
    /// types a literal gh subcommand. We split on whitespace (no shell
    /// expansion) and run it. The user took responsibility by typing it.
    static func executeRaw(rawArgs: [String], repo: String) async -> Result {
        await runGh(repo: repo, args: rawArgs)
    }

    private enum DispatchError: Error, LocalizedError {
        case missingArg(String)
        case wrongType(String)
        case unknownKind

        var errorDescription: String? {
            switch self {
            case .missingArg(let n): return "missing arg: \(n)"
            case .wrongType(let n):  return "wrong type: \(n)"
            case .unknownKind:       return "unknown action kind"
            }
        }
    }

    /// Translate (kind, args) into a gh argv. Per-kind shape pinned here.
    private static func buildArgv(kind: ActionKind, args: [String: AnyCodable]) throws -> [String] {
        switch kind {
        case .approvePr:
            let n = try getInt(args, "pr_number")
            let comment = (try? getString(args, "comment")) ?? ""
            var argv = ["pr", "review", String(n), "--approve"]
            if !comment.isEmpty { argv.append(contentsOf: ["--body", comment]) }
            return argv
        case .comment:
            let n = try getInt(args, "number")
            let target = try getString(args, "target")
            let body = try getString(args, "body")
            switch target {
            case "pr":    return ["pr", "comment", String(n), "--body", body]
            case "issue": return ["issue", "comment", String(n), "--body", body]
            default:      throw DispatchError.wrongType("target")
            }
        case .closeIssue:
            let n = try getInt(args, "issue_number")
            let comment = (try? getString(args, "comment")) ?? ""
            var argv = ["issue", "close", String(n)]
            if !comment.isEmpty { argv.append(contentsOf: ["--comment", comment]) }
            return argv
        case .requestChanges:
            let n = try getInt(args, "pr_number")
            let body = try getString(args, "body")
            return ["pr", "review", String(n), "--request-changes", "--body", body]
        }
    }

    private static func getInt(_ args: [String: AnyCodable], _ key: String) throws -> Int {
        guard let v = args[key] else { throw DispatchError.missingArg(key) }
        if let i = v.value as? Int { return i }
        if let d = v.value as? Double { return Int(d) }
        if let s = v.value as? String, let i = Int(s) { return i }
        throw DispatchError.wrongType(key)
    }

    private static func getString(_ args: [String: AnyCodable], _ key: String) throws -> String {
        guard let v = args[key] else { throw DispatchError.missingArg(key) }
        guard let s = v.value as? String else { throw DispatchError.wrongType(key) }
        return s
    }

    /// Run `gh <argv>` against `repo`. Adds `--repo <owner>/<name>` so the
    /// command works regardless of the user's cwd.
    private static func runGh(repo: String, args: [String]) async -> Result {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["gh"] + args + ["--repo", repo]
        // Inherit env but ensure gh and friends are findable (mirrors the
        // PATH list the daemon uses for first-tree).
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ].joined(separator: ":")
        process.environment = env
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        do {
            try process.run()
        } catch {
            return .failed(message: "spawn gh failed: \(error.localizedDescription)")
        }
        return await withCheckedContinuation { cont in
            DispatchQueue.global().async {
                process.waitUntilExit()
                let stdout = String(data: stdoutPipe.fileHandleForReading.readDataToEndOfFile(),
                                    encoding: .utf8) ?? ""
                let stderr = String(data: stderrPipe.fileHandleForReading.readDataToEndOfFile(),
                                    encoding: .utf8) ?? ""
                if process.terminationStatus == 0 {
                    cont.resume(returning: .ok(stdout: stdout))
                } else {
                    cont.resume(returning: .failed(message: stderr.isEmpty ? "gh exited \(process.terminationStatus)" : stderr))
                }
            }
        }
    }
}

// MARK: - Translate client (Do other...)

/// Calls POST /inbox/:id/translate.
@MainActor
enum IslandTranslateClient {
    struct TranslateOK {
        let summary: String
        let rationale: String
        let actionKind: ActionKind
        let actionArgs: [String: AnyCodable]
    }

    enum Result {
        case ok(TranslateOK)
        case failed(message: String)
    }

    static func translate(entryID: String, userText: String) async -> Result {
        guard let url = URL(string: "\(daemonBaseURL)/inbox/\(entryID)/translate") else {
            return .failed(message: "bad entry id")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 60
        let body = ["text": userText]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                return .failed(message: "no http response")
            }
            if http.statusCode == 501 {
                return .failed(message: "Translate is not enabled on this daemon")
            }
            struct OkWire: Decodable {
                let ok: Bool
                let summary: String?
                let rationale: String?
                let action: InboxActionWireForTranslate?
                let error: String?
            }
            struct InboxActionWireForTranslate: Decodable {
                let kind: String
                let args: [String: AnyCodable]
            }
            let parsed = try JSONDecoder().decode(OkWire.self, from: data)
            if parsed.ok,
               let s = parsed.summary,
               let r = parsed.rationale,
               let a = parsed.action,
               let kind = ActionKind(rawValue: a.kind) {
                return .ok(TranslateOK(
                    summary: s, rationale: r,
                    actionKind: kind, actionArgs: a.args
                ))
            } else {
                return .failed(message: parsed.error ?? "translate returned unexpected shape (status \(http.statusCode))")
            }
        } catch {
            return .failed(message: error.localizedDescription)
        }
    }
}

// MARK: - Island window

/// Owns a single floating NSPanel that hosts the island view. Top-center
/// of the main display by default; degrades gracefully when no notch is
/// reachable. Shared singleton — only one island visible at a time.
@MainActor
final class IslandWindowManager {
    static let shared = IslandWindowManager()
    private init() {}

    private var window: NSPanel?
    /// Last id presented; used to suppress repeated events for the same id.
    private var lastShownID: String? = nil
    private var lastShownAt: Date? = nil
    /// Items the user has explicitly resolved (Execute / Post / Ignore /
    /// dismiss-via-X). Repeated `recommendation` events for these ids do
    /// NOT re-pop the island — only a fresh updated_at on the daemon
    /// side (which becomes a NEW id-or-version) would qualify.
    private var dismissedIDs: Set<String> = []

    /// Show the island for the entry tagged by `eventID`. The view uses
    /// the shared inbox model to look up the full entry context. If the
    /// entry has not yet arrived in /inbox (race between SSE event and
    /// next /inbox poll), we still show the island; the view will
    /// re-render as soon as the entry lands.
    func present(eventID: String) {
        // Don't re-pop something the user has already acted on this
        // session. Without this, a daemon that keeps emitting the same
        // recommendation (e.g. on every poll because the entry is still
        // human-status) would flood the user.
        if dismissedIDs.contains(eventID) { return }
        // Dedup: same id within 5s = no-op (we already showed it).
        if let last = lastShownID, last == eventID,
           let when = lastShownAt, Date().timeIntervalSince(when) < 5 {
            return
        }
        lastShownID = eventID
        lastShownAt = Date()
        ensureWindow()
        positionWindow()
        window?.orderFrontRegardless()
    }

    /// Hide the panel and remember the id so future repeated events
    /// for it don't re-open the panel. Called for every island-side
    /// resolution path: Execute success, Post success, Ignore, X-close,
    /// Cancel from doOther.
    func dismiss(rememberID: String? = nil) {
        if let id = rememberID { dismissedIDs.insert(id) }
        window?.orderOut(nil)
    }

    /// Clear the dismissed-id memory. Useful if we ever want a "show
    /// these to me again" action from the menu bar.
    func forgetDismissed() {
        dismissedIDs.removeAll()
    }

    /// Promote the panel to key window so SwiftUI text fields inside
    /// can receive keyboard input. Called when the user transitions
    /// the island into a mode that has a text input.
    func makePanelKey() {
        window?.makeKeyAndOrderFront(nil)
        // Bring our process forward only minimally — we don't want to
        // steal Cmd-Tab order from the user's main app. Without this
        // call though, the panel can render key but keystrokes still go
        // to the previously frontmost app on some macOS versions.
        NSApp.activate(ignoringOtherApps: false)
    }

    private func ensureWindow() {
        guard window == nil else { return }
        // KeyableIslandPanel: same as a borderless NSPanel but answers
        // YES to canBecomeKey/canBecomeMain so text fields inside the
        // panel actually receive keyboard input. .nonactivatingPanel
        // alone blocks key-window status. Without this, clicking the
        // text field shows the caret but typing does nothing.
        let panel = KeyableIslandPanel(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 130),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // Stay visible across spaces and over fullscreen apps.
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        // Round the panel; the SwiftUI hosting view paints its own bg.
        if let cv = panel.contentView {
            cv.wantsLayer = true
            cv.layer?.cornerRadius = 18
            cv.layer?.masksToBounds = true
        }

        let bridge = IslandEnvironmentBridge.shared
        guard let inbox = bridge.inbox,
              let sse = bridge.sse,
              let ignored = bridge.ignored else {
            // App not fully started yet; this should never happen
            // because we only present after onAppear has fired.
            return
        }
        let root = AnyView(
            IslandRootView(onDismiss: { [weak self] id in self?.dismiss(rememberID: id) })
                .environmentObject(inbox)
                .environmentObject(sse)
                .environmentObject(ignored)
        )
        let host = NSHostingController(rootView: root)
        panel.contentViewController = host
        window = panel
    }

    private func positionWindow() {
        guard let panel = window else { return }
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let frame = screen.visibleFrame
        let panelSize = panel.frame.size

        // Notch detection: NSScreen.safeAreaInsets.top > 0 on notch Macs.
        // We want the island BELOW the notch area, centered horizontally.
        let topInset = screen.safeAreaInsets.top
        let yFromTop: CGFloat = topInset > 0
            ? topInset + 6           // a hair below the notch
            : 6                       // at the very top of the visible frame

        let x = frame.midX - panelSize.width / 2
        // visibleFrame's origin.y is at the bottom; convert "from top" to AppKit y.
        let y = frame.origin.y + frame.height - yFromTop - panelSize.height
        panel.setFrame(NSRect(x: x, y: y, width: panelSize.width, height: panelSize.height),
                       display: true)
    }
}

// MARK: - Island UI

/// SwiftUI root view inside the panel. Reads the latest event from the
/// shared SSE client and the matching item from InboxModel.
struct IslandRootView: View {
    let onDismiss: (String?) -> Void
    @EnvironmentObject var inbox: InboxModel
    @EnvironmentObject var sse: IslandSSEClient
    @EnvironmentObject var ignored: IgnoredStore

    @State private var mode: IslandMode = .compact
    @State private var doOtherText: String = ""
    @State private var doOtherRaw: Bool = false
    @State private var inFlight: Bool = false
    @State private var statusMessage: String? = nil
    @State private var preview: IslandTranslateClient.TranslateOK? = nil
    @FocusState private var commentFieldFocused: Bool

    private var currentItem: InboxItem? {
        guard let ev = sse.latest else { return nil }
        return inbox.allItems.first(where: { $0.id == ev.id })
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18)
                .fill(Color.black.opacity(0.92))
            VStack(alignment: .leading, spacing: 8) {
                if let item = currentItem {
                    titleRow(item: item)
                    Divider().background(Color.white.opacity(0.15))
                    switch mode {
                    case .compact:
                        compactBody(item: item)
                    case .doOther:
                        doOtherBody(item: item)
                    case .preview:
                        previewBody(item: item)
                    }
                } else {
                    Text("Loading entry context…")
                        .foregroundColor(.white.opacity(0.7))
                        .padding()
                }
            }
            .padding(14)
        }
        .frame(width: 480)
    }

    // MARK: header

    private func titleRow(item: InboxItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: item.symbolName)
                .foregroundColor(.white.opacity(0.85))
            Text("\(item.repoShort) #\(item.number)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.white.opacity(0.85))
            Text(item.title)
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.7))
                .lineLimit(1)
            Spacer()
            Button(action: { onDismiss(item.id) }) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.white.opacity(0.5))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: compact

    private func compactBody(item: InboxItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let r = item.recommendation {
                HStack(alignment: .top, spacing: 6) {
                    Text("🤖")
                    Text(r.summary)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white)
                        .lineLimit(2)
                }
            } else {
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.6)
                    Text("Computing recommendation…")
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.7))
                }
            }
            HStack(spacing: 8) {
                if item.recommendation != nil {
                    IslandButton(label: "Execute", systemImage: "checkmark.circle.fill", tint: .green) {
                        Task { await onExecute(item: item) }
                    }
                }
                IslandButton(label: "Do other…", systemImage: "pencil", tint: .blue) {
                    mode = .doOther
                    // Make the panel key + focus the text field so the
                    // user can type immediately, no extra click required.
                    IslandWindowManager.shared.makePanelKey()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        commentFieldFocused = true
                    }
                }
                IslandButton(label: "Ignore", systemImage: "xmark.circle", tint: .gray) {
                    onIgnore(item: item)
                }
                Spacer()
                if let msg = statusMessage {
                    Text(msg).font(.system(size: 11)).foregroundColor(.yellow.opacity(0.85))
                }
                if inFlight { ProgressView().scaleEffect(0.5) }
            }
        }
    }

    // MARK: do other

    private func doOtherBody(item: InboxItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(doOtherRaw
                 ? "Advanced — type a raw `gh` command (runs as you typed it):"
                 : "Post a comment on this \(item.type == "Issue" ? "issue" : "PR"):")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            TextField("", text: $doOtherText, prompt: Text(doOtherRaw
                                                            ? "pr review 4 --request-changes --body \"need tests\""
                                                            : "type your comment here"),
                      axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(3, reservesSpace: true)
                .padding(8)
                .background(Color.white.opacity(0.08))
                .cornerRadius(6)
                .foregroundColor(.white)
                .focused($commentFieldFocused)
                .onSubmit {
                    if !doOtherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Task { await onDoOtherSubmit(item: item) }
                    }
                }
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Toggle("", isOn: $doOtherRaw)
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                        .labelsHidden()
                    Text(doOtherRaw ? "raw gh" : "comment")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(doOtherRaw ? .orange.opacity(0.9) : .white.opacity(0.55))
                }
                Spacer()
                IslandButton(label: "Cancel", systemImage: "arrow.uturn.backward", tint: .gray) {
                    mode = .compact
                    doOtherText = ""
                }
                let canSubmit = !doOtherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                IslandButton(label: doOtherRaw ? "Run" : "Post",
                             systemImage: doOtherRaw ? "play.fill" : "paperplane.fill",
                             tint: canSubmit ? .blue : .gray) {
                    if canSubmit { Task { await onDoOtherSubmit(item: item) } }
                }
                .opacity(canSubmit ? 1.0 : 0.5)
                if inFlight { ProgressView().scaleEffect(0.5) }
            }
        }
    }

    // MARK: preview (after Translate)

    private func previewBody(item: InboxItem) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let p = preview {
                Text("🤖 \(p.summary)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white)
                Text("kind: \(p.actionKind.rawValue)")
                    .font(.system(size: 11))
                    .foregroundColor(.white.opacity(0.6))
            }
            HStack(spacing: 8) {
                Spacer()
                IslandButton(label: "Cancel", systemImage: "arrow.uturn.backward", tint: .gray) {
                    mode = .compact
                    preview = nil
                }
                IslandButton(label: "Confirm", systemImage: "checkmark.circle.fill", tint: .green) {
                    Task { await onConfirmPreview(item: item) }
                }
                if inFlight { ProgressView().scaleEffect(0.5) }
            }
        }
    }

    // MARK: actions

    private func onExecute(item: InboxItem) async {
        guard let r = item.recommendation else { return }
        inFlight = true
        defer { inFlight = false }
        let result = await IslandActionDispatcher.execute(item: item, kind: r.actionKind, args: r.actionArgs)
        switch result {
        case .ok:
            // Mark seen so the tray dropdown dims it. The daemon will
            // transition the entry to `done` on the next poll.
            inbox.markSeen(item.id)
            onDismiss(item.id)
        case .failed(let msg):
            statusMessage = "Execute failed: \(String(msg.prefix(80)))"
        }
    }

    private func onIgnore(item: InboxItem) {
        ignored.add(item.id)
        onDismiss(item.id)
    }

    private func onDoOtherSubmit(item: InboxItem) async {
        let text = doOtherText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inFlight = true
        defer { inFlight = false }
        if doOtherRaw {
            // Raw mode: shell-split the user's input naively. We DO NOT
            // pipe through `bash -c`. We split on whitespace and pass to
            // gh as argv. This means quoting won't behave like a shell —
            // documented in the placeholder.
            let parts = text.split(separator: " ").map(String.init)
            let cleaned = parts.first == "gh" ? Array(parts.dropFirst()) : parts
            let result = await IslandActionDispatcher.executeRaw(rawArgs: cleaned, repo: item.repo)
            switch result {
            case .ok:
                inbox.markSeen(item.id)
                onDismiss(item.id)
            case .failed(let msg):
                statusMessage = "Run failed: \(String(msg.prefix(80)))"
            }
        } else {
            // Comment mode: skip the LLM round-trip. The user typed the
            // literal comment they want — post it directly. The whitelist
            // dispatcher's `comment` kind handles target=pr vs issue and
            // passes the body to gh as an argv element (no shell, no
            // injection risk).
            let target = (item.type == "Issue") ? "issue" : "pr"
            let args: [String: AnyCodable] = [
                "number": AnyCodable(item.number as AnyHashable),
                "target": AnyCodable(target as AnyHashable),
                "body": AnyCodable(text as AnyHashable),
            ]
            let result = await IslandActionDispatcher.execute(
                item: item, kind: .comment, args: args
            )
            switch result {
            case .ok:
                inbox.markSeen(item.id)
                onDismiss(item.id)
            case .failed(let msg):
                statusMessage = "Post failed: \(String(msg.prefix(120)))"
            }
        }
    }

    private func onConfirmPreview(item: InboxItem) async {
        guard let p = preview else { return }
        inFlight = true
        defer { inFlight = false }
        let result = await IslandActionDispatcher.execute(item: item, kind: p.actionKind, args: p.actionArgs)
        switch result {
        case .ok:
            inbox.markSeen(item.id)
            onDismiss(item.id)
        case .failed(let msg):
            statusMessage = "Execute failed: \(String(msg.prefix(80)))"
            mode = .doOther // back to text input so user can retry
        }
    }
}

private enum IslandMode {
    case compact
    case doOther
    case preview
}

// MARK: - Island button

struct IslandButton: View {
    let label: String
    let systemImage: String
    let tint: Color
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
        .foregroundColor(.white)
        .padding(.vertical, 4)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(tint.opacity(hover ? 0.5 : 0.3))
        )
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture(perform: action)
    }
}

// MARK: - Keyable island panel

/// A borderless NSPanel that can become the key window so SwiftUI text
/// fields inside it actually receive keyboard input. The default
/// borderless + nonactivatingPanel combo returns NO for both, leaving
/// the text field visually focusable but inert. We override here.
final class KeyableIslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
