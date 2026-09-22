import Foundation

public struct HostOptions {
    let rootURL: URL
    let baseImageURL: URL
    let workingImageURL: URL
    let efiVariablesURL: URL
    let machineIdentifierURL: URL
    let runtimeShareURL: URL
    let runtimeTag: String
    let guestPort: UInt32
    let guestRequestTimeoutMilliseconds: Int32
    let cpuCount: Int
    let memorySize: UInt64
    let displayWidth: Int
    let displayHeight: Int
    let showWindow: Bool

    public static func parse(arguments: [String]) throws -> HostOptions? {
        var rootPath: String?
        var baseImagePath: String?
        var workingImagePath: String?
        var efiVariablesPath: String?
        var machineIdentifierPath: String?
        var runtimeSharePath: String?
        var runtimeTag = environmentValue("HELM_VM_RUNTIME_TAG") ?? "helm-runtime"
        var guestPort = try parseUInt32(
            environmentValue("HELM_VM_GUEST_PORT") ?? "4242",
            option: "HELM_VM_GUEST_PORT"
        )
        var timeoutMilliseconds = try parseInt32(
            environmentValue("HELM_VM_GUEST_TIMEOUT_MS") ?? "10000",
            option: "HELM_VM_GUEST_TIMEOUT_MS"
        )
        var cpuCount = try parseInt(
            environmentValue("HELM_VM_CPUS") ?? "4",
            option: "HELM_VM_CPUS"
        )
        var memoryMiB = try parseUInt64(
            environmentValue("HELM_VM_MEMORY_MIB") ?? "4096",
            option: "HELM_VM_MEMORY_MIB"
        )
        var showWindow = false
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            index += 1

            switch argument {
            case "--help", "-h":
                printUsage()
                return nil
            case "--root":
                rootPath = try nextArgument(arguments, index: &index, option: argument)
            case "--base-image":
                baseImagePath = try nextArgument(arguments, index: &index, option: argument)
            case "--working-image":
                workingImagePath = try nextArgument(arguments, index: &index, option: argument)
            case "--efi-vars":
                efiVariablesPath = try nextArgument(arguments, index: &index, option: argument)
            case "--machine-id":
                machineIdentifierPath = try nextArgument(arguments, index: &index, option: argument)
            case "--runtime-share":
                runtimeSharePath = try nextArgument(arguments, index: &index, option: argument)
            case "--runtime-tag":
                runtimeTag = try nextArgument(arguments, index: &index, option: argument)
            case "--guest-port":
                guestPort = try parseUInt32(
                    nextArgument(arguments, index: &index, option: argument),
                    option: argument
                )
            case "--guest-timeout-ms":
                timeoutMilliseconds = try parseInt32(
                    nextArgument(arguments, index: &index, option: argument),
                    option: argument
                )
            case "--cpus":
                cpuCount = try parseInt(
                    nextArgument(arguments, index: &index, option: argument),
                    option: argument
                )
            case "--memory-mib":
                memoryMiB = try parseUInt64(
                    nextArgument(arguments, index: &index, option: argument),
                    option: argument
                )
            case "--show-window":
                showWindow = true
            default:
                throw HostFailure(code: "invalid_argument", message: "Unknown argument: \(argument)")
            }
        }

        guard guestPort > 0 && guestPort <= 65_535 else {
            throw HostFailure(code: "invalid_argument", message: "Guest port must be between 1 and 65535.")
        }
        guard timeoutMilliseconds > 0 else {
            throw HostFailure(code: "invalid_argument", message: "Guest request timeout must be positive.")
        }
        guard cpuCount > 0 else {
            throw HostFailure(code: "invalid_argument", message: "CPU count must be positive.")
        }
        guard memoryMiB > 0 else {
            throw HostFailure(code: "invalid_argument", message: "Memory size must be positive.")
        }
        guard memoryMiB <= UInt64.max / (1024 * 1024) else {
            throw HostFailure(code: "invalid_argument", message: "Memory size is too large.")
        }
        guard !runtimeTag.isEmpty else {
            throw HostFailure(code: "invalid_argument", message: "Runtime VirtioFS tag must not be empty.")
        }

        let defaultRoot = environmentValue("HELM_VM_HOME")
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Helm", isDirectory: true)
                .path
        let rootURL = resolvePath(rootPath ?? defaultRoot)
        let vmDirectoryURL = rootURL.appendingPathComponent("vm", isDirectory: true)
        let resolvedBaseImageURL = resolvePath(
            baseImagePath ?? environmentValue("HELM_VM_BASE_IMAGE")
                ?? vmDirectoryURL.appendingPathComponent("base.img").path
        )
        let resolvedWorkingImageURL = resolvePath(
            workingImagePath ?? environmentValue("HELM_VM_WORKING_IMAGE")
                ?? vmDirectoryURL.appendingPathComponent("disk.img").path
        )
        let resolvedEFIURL = resolvePath(
            efiVariablesPath ?? environmentValue("HELM_VM_EFI_VARS")
                ?? vmDirectoryURL.appendingPathComponent("efi-vars.bin").path
        )
        let resolvedMachineIdentifierURL = resolvePath(
            machineIdentifierPath ?? environmentValue("HELM_VM_MACHINE_ID")
                ?? vmDirectoryURL.appendingPathComponent("machine-id.bin").path
        )
        let resolvedRuntimeURL = resolvePath(
            runtimeSharePath ?? environmentValue("HELM_VM_RUNTIME_SHARE")
                ?? rootURL.appendingPathComponent("runtime", isDirectory: true).path
        )

        return HostOptions(
            rootURL: rootURL,
            baseImageURL: resolvedBaseImageURL,
            workingImageURL: resolvedWorkingImageURL,
            efiVariablesURL: resolvedEFIURL,
            machineIdentifierURL: resolvedMachineIdentifierURL,
            runtimeShareURL: resolvedRuntimeURL,
            runtimeTag: runtimeTag,
            guestPort: guestPort,
            guestRequestTimeoutMilliseconds: timeoutMilliseconds,
            cpuCount: cpuCount,
            memorySize: memoryMiB * 1024 * 1024,
            displayWidth: 1280,
            displayHeight: 800,
            showWindow: showWindow
        )
    }

    private static func environmentValue(_ key: String) -> String? {
        ProcessInfo.processInfo.environment[key]
    }

    private static func nextArgument(
        _ arguments: [String],
        index: inout Int,
        option: String
    ) throws -> String {
        guard index < arguments.count else {
            throw HostFailure(code: "invalid_argument", message: "Missing value for \(option).")
        }
        let value = arguments[index]
        index += 1
        return value
    }

    private static func parseUInt32(_ value: String, option: String) throws -> UInt32 {
        guard let parsed = UInt32(value) else {
            throw HostFailure(code: "invalid_argument", message: "Invalid integer for \(option): \(value).")
        }
        return parsed
    }

    private static func parseUInt64(_ value: String, option: String) throws -> UInt64 {
        guard let parsed = UInt64(value) else {
            throw HostFailure(code: "invalid_argument", message: "Invalid integer for \(option): \(value).")
        }
        return parsed
    }

    private static func parseInt32(_ value: String, option: String) throws -> Int32 {
        guard let parsed = Int32(value) else {
            throw HostFailure(code: "invalid_argument", message: "Invalid integer for \(option): \(value).")
        }
        return parsed
    }

    private static func parseInt(_ value: String, option: String) throws -> Int {
        guard let parsed = Int(value) else {
            throw HostFailure(code: "invalid_argument", message: "Invalid integer for \(option): \(value).")
        }
        return parsed
    }

    private static func resolvePath(_ value: String) -> URL {
        let expanded: String
        if value == "~" {
            expanded = FileManager.default.homeDirectoryForCurrentUser.path
        } else if value.hasPrefix("~/") {
            expanded = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(String(value.dropFirst(2)))
                .path
        } else {
            expanded = value
        }

        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded).standardizedFileURL
        }
        let currentDirectoryURL = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true
        )
        return URL(fileURLWithPath: expanded, relativeTo: currentDirectoryURL)
            .standardizedFileURL
    }

    private static func printUsage() {
        let usage = """
        helm-vm-host: JSON Lines Apple Virtualization.framework host

        Options:
          --root PATH              Helm application-support root
          --base-image PATH       Prepared ARM64 Linux raw image
          --working-image PATH    Mutable working image
          --efi-vars PATH         EFI variable store
          --machine-id PATH       Persistent generic VM machine identifier
          --runtime-share PATH    Read-only VirtioFS host directory
          --runtime-tag TAG       VirtioFS tag (default: helm-runtime)
          --guest-port PORT       Guest AF_VSOCK port (default: 4242)
          --guest-timeout-ms N    Guest RPC read timeout (default: 10000)
          --cpus N                Guest CPU count (default: 4)
          --memory-mib N          Guest memory (default: 4096)
          --show-window           Attach a resizable native VM viewer window

        Commands are JSON objects on stdin. Responses and lifecycle events are JSON objects on stdout.
        """
        FileHandle.standardError.write(Data(usage.utf8))
    }
}
