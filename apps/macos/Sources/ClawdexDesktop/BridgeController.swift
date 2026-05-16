import AppKit
import Foundation
import Security

@MainActor
final class BridgeController: ObservableObject {
    @Published var configuration: BridgeConfiguration
    @Published private(set) var runState: BridgeRunState = .stopped {
        didSet {
            StatusBarController.shared.updateIcon(systemImage: menuBarSystemImage)
        }
    }
    @Published private(set) var statusSnapshot: BridgeStatusSnapshot?
    @Published private(set) var lastLogLines: [String] = []

    private var process: Process?
    private var logPipe: Pipe?
    private var pollTask: Task<Void, Never>?

    init() {
        self.configuration = BridgeConfiguration.load()
        applyAppearance()
    }

    var menuBarSystemImage: String {
        switch runState {
        case .running:
            "bolt.horizontal.circle.fill"
        case .starting:
            "bolt.horizontal.circle"
        case .failed:
            "exclamationmark.triangle.fill"
        case .stopped:
            "bolt.horizontal.circle"
        }
    }

    var pairingPayload: String {
        let payload: [String: Any] = [
            "type": "clawdex-bridge-pair",
            "bridgeUrl": configuration.bridgeURL,
            "bridgeToken": configuration.token,
            "defaultChatEngine": configuration.activeEngine,
            "enabledEngines": configuration.enabledEngineValues,
            "approvalMode": configuration.approvalMode,
            "showToolCalls": configuration.showToolCalls,
            "appearancePreference": configuration.appearancePreference,
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else {
            return ""
        }
        return text
    }

    func saveConfiguration() {
        configuration.normalize()
        configuration.save()
        applyAppearance()
    }

    func resetToken() {
        configuration.token = BridgeConfiguration.generateToken()
        saveConfiguration()
    }

    func setEngineEnabled(_ engine: BridgeEngine, isEnabled: Bool) {
        if isEnabled {
            if !configuration.enabledEngines.contains(engine.rawValue) {
                configuration.enabledEngines.append(engine.rawValue)
            }
        } else {
            configuration.enabledEngines.removeAll { $0 == engine.rawValue }
            if configuration.activeEngine == engine.rawValue {
                configuration.activeEngine = "codex"
            }
        }
        configuration.normalize()
    }

    func start() {
        guard process == nil else {
            return
        }

        saveConfiguration()
        runState = .starting

        do {
            let binaryPath = try BridgeBinaryResolver.resolveBridgeBinary()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: binaryPath)
            process.currentDirectoryURL = URL(fileURLWithPath: configuration.workdir)
            process.environment = bridgeEnvironment()

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
                    return
                }
                Task { @MainActor [weak self] in
                    self?.appendLog(text)
                }
            }

            process.terminationHandler = { [weak self] process in
                Task { @MainActor [weak self] in
                    self?.handleBridgeExit(status: process.terminationStatus)
                }
            }

            try process.run()
            self.process = process
            self.logPipe = pipe
            startPolling()
        } catch {
            runState = .failed(error.localizedDescription)
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        logPipe?.fileHandleForReading.readabilityHandler = nil
        logPipe = nil

        if let process {
            process.terminate()
        }
        process = nil
        statusSnapshot = nil
        runState = .stopped
    }

    func refreshStatus() async {
        guard let url = URL(string: "\(configuration.bridgeURL)/status") else {
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                if process != nil {
                    runState = .starting
                }
                return
            }

            let snapshot = try JSONDecoder().decode(BridgeStatusSnapshot.self, from: data)
            statusSnapshot = snapshot
            runState = .running
        } catch {
            if process != nil {
                runState = .starting
            }
        }
    }

    private func bridgeEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = [
            environment["PATH"],
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        .compactMap { $0 }
        .joined(separator: ":")
        environment["BRIDGE_HOST"] = configuration.bindHost
        environment["BRIDGE_PORT"] = String(configuration.port)
        environment["BRIDGE_CONNECT_URL"] = configuration.bridgeURL
        environment["BRIDGE_AUTH_TOKEN"] = configuration.token
        environment["BRIDGE_ALLOW_QUERY_TOKEN_AUTH"] = configuration.allowQueryTokenAuth ? "true" : "false"
        environment["BRIDGE_WORKDIR"] = configuration.workdir
        environment["BRIDGE_ACTIVE_ENGINE"] = configuration.activeEngine
        environment["BRIDGE_ENABLED_ENGINES"] = configuration.enabledEngineValues.joined(separator: ",")
        environment["BRIDGE_SHOW_PAIRING_QR"] = "false"
        return environment
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshStatus()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func handleBridgeExit(status: Int32) {
        pollTask?.cancel()
        pollTask = nil
        process = nil
        statusSnapshot = nil
        logPipe?.fileHandleForReading.readabilityHandler = nil
        logPipe = nil
        if status == 0 {
            runState = .stopped
        } else {
            runState = .failed("Bridge exited with status \(status)")
        }
    }

    private func appendLog(_ text: String) {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else {
            return
        }
        lastLogLines.append(contentsOf: lines)
        if lastLogLines.count > 40 {
            lastLogLines.removeFirst(lastLogLines.count - 40)
        }
    }

    private func applyAppearance() {
        switch configuration.appearancePreference {
        case "light":
            NSApplication.shared.appearance = NSAppearance(named: .aqua)
        case "dark":
            NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
        default:
            NSApplication.shared.appearance = nil
        }
    }
}

enum BridgeRunState: Equatable {
    case stopped
    case starting
    case running
    case failed(String)

    var title: String {
        switch self {
        case .stopped:
            "Stopped"
        case .starting:
            "Starting"
        case .running:
            "Running"
        case .failed:
            "Needs attention"
        }
    }

    var detail: String? {
        if case let .failed(message) = self {
            message
        } else {
            nil
        }
    }
}

struct BridgeConfiguration: Codable, Equatable {
    var workdir: String
    var bindHost: String
    var connectHost: String
    var port: Int
    var token: String
    var activeEngine: String
    var enabledEngines: [String]
    var approvalMode: String
    var showToolCalls: Bool
    var appearancePreference: String
    var allowQueryTokenAuth: Bool

    init(
        workdir: String,
        bindHost: String,
        connectHost: String,
        port: Int,
        token: String,
        activeEngine: String,
        enabledEngines: [String] = ["codex"],
        approvalMode: String = "yolo",
        showToolCalls: Bool = true,
        appearancePreference: String = "system",
        allowQueryTokenAuth: Bool = true
    ) {
        self.workdir = workdir
        self.bindHost = bindHost
        self.connectHost = connectHost
        self.port = port
        self.token = token
        self.activeEngine = activeEngine
        self.enabledEngines = enabledEngines
        self.approvalMode = approvalMode
        self.showToolCalls = showToolCalls
        self.appearancePreference = appearancePreference
        self.allowQueryTokenAuth = allowQueryTokenAuth
        normalize()
    }

    var bridgeURL: String {
        "http://\(connectHost):\(port)"
    }

    var enabledEngineValues: [String] {
        let enabled = Set(enabledEngines)
        return BridgeEngine.allCases.map(\.rawValue).filter { enabled.contains($0) }
    }

    var enabledEngineSummary: String {
        enabledEngineValues
            .compactMap { BridgeEngine(rawValue: $0)?.title }
            .joined(separator: ", ")
    }

    mutating func normalize() {
        let supportedEngines = Set(BridgeEngine.allCases.map(\.rawValue))
        activeEngine = supportedEngines.contains(activeEngine) ? activeEngine : "codex"

        let enabledSet = Set(enabledEngines.filter { supportedEngines.contains($0) })
            .union(["codex", activeEngine])
        enabledEngines = BridgeEngine.allCases.map(\.rawValue).filter { enabledSet.contains($0) }

        if approvalMode != "normal" && approvalMode != "yolo" {
            approvalMode = "yolo"
        }
        if appearancePreference != "system" && appearancePreference != "light" && appearancePreference != "dark" {
            appearancePreference = "system"
        }
        if !(1...65535).contains(port) {
            port = 8787
        }
        if workdir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            workdir = FileManager.default.homeDirectoryForCurrentUser.path
        }
        if bindHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            bindHost = "0.0.0.0"
        }
        if connectHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            connectHost = NetworkAddressResolver.localIPv4() ?? "127.0.0.1"
        }
    }

    static func load() -> BridgeConfiguration {
        let defaults = UserDefaults.standard
        if
            let data = defaults.data(forKey: storageKey),
            let configuration = try? JSONDecoder().decode(BridgeConfiguration.self, from: data)
        {
            return configuration
        }
        return .fresh()
    }

    static var hasSavedConfiguration: Bool {
        UserDefaults.standard.data(forKey: storageKey) != nil
    }

    static func fresh() -> BridgeConfiguration {
        BridgeConfiguration(
            workdir: FileManager.default.homeDirectoryForCurrentUser.path,
            bindHost: "0.0.0.0",
            connectHost: NetworkAddressResolver.localIPv4() ?? "127.0.0.1",
            port: 8787,
            token: generateToken(),
            activeEngine: "codex",
            enabledEngines: ["codex"],
            approvalMode: "yolo",
            showToolCalls: true,
            appearancePreference: "system",
            allowQueryTokenAuth: true
        )
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else {
            return
        }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }

    static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if result == errSecSuccess {
            return Data(bytes)
                .base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    private static let storageKey = "BridgeConfiguration"
}

extension BridgeConfiguration {
    private enum CodingKeys: String, CodingKey {
        case workdir
        case bindHost
        case connectHost
        case port
        case token
        case activeEngine
        case enabledEngines
        case approvalMode
        case showToolCalls
        case appearancePreference
        case allowQueryTokenAuth
    }

    init(from decoder: Decoder) throws {
        let fresh = BridgeConfiguration.fresh()
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            workdir: try container.decodeIfPresent(String.self, forKey: .workdir) ?? fresh.workdir,
            bindHost: try container.decodeIfPresent(String.self, forKey: .bindHost) ?? fresh.bindHost,
            connectHost: try container.decodeIfPresent(String.self, forKey: .connectHost) ?? fresh.connectHost,
            port: try container.decodeIfPresent(Int.self, forKey: .port) ?? fresh.port,
            token: try container.decodeIfPresent(String.self, forKey: .token) ?? fresh.token,
            activeEngine: try container.decodeIfPresent(String.self, forKey: .activeEngine) ?? fresh.activeEngine,
            enabledEngines: try container.decodeIfPresent([String].self, forKey: .enabledEngines) ?? [
                try container.decodeIfPresent(String.self, forKey: .activeEngine) ?? fresh.activeEngine
            ],
            approvalMode: try container.decodeIfPresent(String.self, forKey: .approvalMode) ?? fresh.approvalMode,
            showToolCalls: try container.decodeIfPresent(Bool.self, forKey: .showToolCalls) ?? fresh.showToolCalls,
            appearancePreference: try container.decodeIfPresent(String.self, forKey: .appearancePreference) ?? fresh.appearancePreference,
            allowQueryTokenAuth: try container.decodeIfPresent(Bool.self, forKey: .allowQueryTokenAuth) ?? fresh.allowQueryTokenAuth
        )
    }
}

enum BridgeEngine: String, CaseIterable, Identifiable {
    case codex
    case cursor
    case opencode

    var id: String {
        rawValue
    }

    var title: String {
        switch self {
        case .codex:
            "Codex"
        case .cursor:
            "Cursor"
        case .opencode:
            "OpenCode"
        }
    }

    var detail: String {
        switch self {
        case .codex:
            "Built in"
        case .cursor:
            "Uses local Cursor credentials"
        case .opencode:
            "Uses local OpenCode runtime"
        }
    }

    var systemImage: String {
        switch self {
        case .codex:
            "sparkles"
        case .cursor:
            "cursorarrow"
        case .opencode:
            "terminal"
        }
    }

    var brandAsset: BrandAsset {
        switch self {
        case .codex:
            .codex
        case .cursor:
            .cursor
        case .opencode:
            .opencode
        }
    }
}

struct BridgeStatusSnapshot: Decodable, Equatable {
    var status: String
    var at: String
    var uptimeSec: Int
    var connectedClients: Int
    var devices: [BridgeDeviceConnection]
}

struct BridgeDeviceConnection: Decodable, Identifiable, Equatable {
    var clientId: UInt64
    var clientType: String
    var clientName: String
    var connectedAt: String
    var lastSeenAt: String

    var id: UInt64 {
        clientId
    }
}

enum BridgeBinaryResolver {
    static func resolveBridgeBinary() throws -> String {
        let fileManager = FileManager.default
        let candidates = bridgeBinaryCandidates()
        for candidate in candidates where fileManager.isExecutableFile(atPath: candidate) {
            return candidate
        }
        throw BridgeBinaryError.notFound(candidates)
    }

    private static func bridgeBinaryCandidates() -> [String] {
        var candidates: [String] = []
        let environment = ProcessInfo.processInfo.environment
        if let override = environment["CLAWDEX_BRIDGE_BIN"], !override.isEmpty {
            candidates.append(override)
        }
        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("codex-rust-bridge").path)
        }

        let sourceURL = URL(fileURLWithPath: #filePath)
        let repoRoot = sourceURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let runtimeTarget = RuntimeTarget.current
        candidates.append(
            repoRoot
                .appendingPathComponent("vendor/bridge-binaries/\(runtimeTarget)/codex-rust-bridge")
                .path
        )
        candidates.append(
            repoRoot
                .appendingPathComponent("services/rust-bridge/target/release/codex-rust-bridge")
                .path
        )
        candidates.append(
            repoRoot
                .appendingPathComponent("services/rust-bridge/target/debug/codex-rust-bridge")
                .path
        )
        return candidates
    }
}

enum BridgeBinaryError: LocalizedError {
    case notFound([String])

    var errorDescription: String? {
        switch self {
        case let .notFound(candidates):
            "Bridge binary not found. Checked: \(candidates.joined(separator: ", "))"
        }
    }
}

enum RuntimeTarget {
    static var current: String {
        #if arch(arm64)
        "darwin-arm64"
        #else
        "darwin-x64"
        #endif
    }
}

enum NetworkAddressResolver {
    static func localIPv4() -> String? {
        for interface in ["en0", "en1"] {
            if let value = run("/usr/sbin/ipconfig", ["getifaddr", interface]), isIPv4(value) {
                return value
            }
        }
        return nil
    }

    private static func run(_ launchPath: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                return nil
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private static func isIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".")
        guard parts.count == 4 else {
            return false
        }
        return parts.allSatisfy { part in
            guard let number = Int(part) else {
                return false
            }
            return (0...255).contains(number)
        }
    }
}
