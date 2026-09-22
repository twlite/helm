import Darwin
import Foundation

/// Options for the interactive first-run Ubuntu installer and resumable
/// provisioning sessions.
///
/// Fresh provisioning accepts an official Ubuntu 24.04 LTS ARM64 installer
/// ISO. Resume mode may omit the ISO and reuses the existing provisioning disk
/// and EFI state. The host validates any supplied ISO path and file, but it
/// does not attempt to infer the ISO architecture from its bytes.
public struct ProvisioningOptions {
    public static let installationDiskSizeBytes: UInt64 = 24 * 1024 * 1024 * 1024

    let installerISOURL: URL?
    let installationImageURL: URL
    let efiVariablesURL: URL
    let machineIdentifierURL: URL
    let stateLockURL: URL
    let runtimeShareURL: URL
    let runtimeTag: String
    let cpuCount: Int
    let memorySize: UInt64
    let displayWidth: Int
    let displayHeight: Int
    let force: Bool
    let resume: Bool

    public static func parse(arguments: [String]) throws -> ProvisioningOptions? {
        var installerISOPath: String?
        var installationImagePath: String?
        var efiVariablesPath: String?
        var machineIdentifierPath: String?
        var runtimeSharePath: String?
        var runtimeTag = environmentValue("HELM_VM_RUNTIME_TAG") ?? HelmRuntimeShareConfiguration.defaultTag
        var cpuCount = try parseInt(
            environmentValue("HELM_VM_CPUS") ?? "4",
            option: "HELM_VM_CPUS"
        )
        var memoryMiB = try parseUInt64(
            environmentValue("HELM_VM_MEMORY_MIB") ?? "4096",
            option: "HELM_VM_MEMORY_MIB"
        )
        var displayWidth = 1280
        var displayHeight = 800
        var force = false
        var resume = false
        var positionalISOSeen = false
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            index += 1

            switch argument {
            case "--help", "-h":
                printUsage()
                return nil
            case "--installer-iso", "--iso":
                installerISOPath = try nextArgument(arguments, index: &index, option: argument)
            case "--installation-image", "--provision-disk":
                installationImagePath = try nextArgument(arguments, index: &index, option: argument)
            case "--efi-vars":
                efiVariablesPath = try nextArgument(arguments, index: &index, option: argument)
            case "--machine-id":
                machineIdentifierPath = try nextArgument(arguments, index: &index, option: argument)
            case "--runtime-share":
                runtimeSharePath = try nextArgument(arguments, index: &index, option: argument)
            case "--runtime-tag":
                runtimeTag = try nextArgument(arguments, index: &index, option: argument)
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
            case "--display-width":
                displayWidth = try parseInt(
                    nextArgument(arguments, index: &index, option: argument),
                    option: argument
                )
            case "--display-height":
                displayHeight = try parseInt(
                    nextArgument(arguments, index: &index, option: argument),
                    option: argument
                )
            case "--force":
                force = true
            case "--resume":
                resume = true
            default:
                if argument.hasPrefix("-") || positionalISOSeen {
                    throw HostFailure(code: "invalid_argument", message: "Unknown argument: \(argument)")
                }
                installerISOPath = argument
                positionalISOSeen = true
            }
        }

        if let installerISOPath, installerISOPath.isEmpty {
            throw HostFailure(
                code: "invalid_argument",
                message: "The installer ISO path must not be empty."
            )
        }
        guard resume || (installerISOPath != nil && !installerISOPath!.isEmpty) else {
            throw HostFailure(
                code: "invalid_argument",
                message: "Provisioning requires an Ubuntu 24.04 LTS ARM64 installer ISO path."
            )
        }
        guard !(resume && force) else {
            throw HostFailure(
                code: "invalid_argument",
                message: "Cannot combine --resume with --force. Resume never replaces provisioning state."
            )
        }
        guard cpuCount > 0 else {
            throw HostFailure(code: "invalid_argument", message: "CPU count must be positive.")
        }
        guard memoryMiB > 0, memoryMiB <= UInt64.max / (1024 * 1024) else {
            throw HostFailure(code: "invalid_argument", message: "Memory size must be positive and fit in bytes.")
        }
        guard displayWidth > 0, displayHeight > 0 else {
            throw HostFailure(code: "invalid_argument", message: "Display dimensions must be positive.")
        }
        guard !runtimeTag.isEmpty else {
            throw HostFailure(code: "invalid_argument", message: "Runtime VirtioFS tag must not be empty.")
        }

        let defaultRoot = environmentValue("HELM_VM_HOME")
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Helm", isDirectory: true)
                .path
        let rootURL = resolveHelmPath(defaultRoot)
        let vmDirectoryURL = rootURL.appendingPathComponent("vm", isDirectory: true)
        let resolvedInstallationImageURL = resolveHelmPath(
            installationImagePath ?? environmentValue("HELM_VM_PROVISIONING_IMAGE")
                ?? vmDirectoryURL.appendingPathComponent("provisioning.img").path
        )
        let resolvedEFIURL = resolveHelmPath(
            efiVariablesPath ?? environmentValue("HELM_VM_PROVISIONING_EFI_VARS")
                ?? vmDirectoryURL.appendingPathComponent("provisioning-efi-vars.bin").path
        )
        let resolvedMachineIdentifierURL = resolveHelmPath(
            machineIdentifierPath ?? environmentValue("HELM_VM_MACHINE_ID")
                ?? vmDirectoryURL.appendingPathComponent("machine-id.bin").path
        )

        let resolvedRuntimeURL = resolveHelmPath(
            runtimeSharePath ?? environmentValue("HELM_VM_RUNTIME_SHARE")
                ?? rootURL.appendingPathComponent("runtime", isDirectory: true).path
        )

        let options = ProvisioningOptions(
            installerISOURL: installerISOPath.map(resolveHelmPath),
            installationImageURL: resolvedInstallationImageURL,
            efiVariablesURL: resolvedEFIURL,
            machineIdentifierURL: resolvedMachineIdentifierURL,
            stateLockURL: vmDirectoryURL.appendingPathComponent(".helm-vm.lock", isDirectory: false),
            runtimeShareURL: resolvedRuntimeURL,
            runtimeTag: runtimeTag,
            cpuCount: cpuCount,
            memorySize: memoryMiB * 1024 * 1024,
            displayWidth: displayWidth,
            displayHeight: displayHeight,
            force: force,
            resume: resume
        )
        try options.validatePaths()
        return options
    }

    func prepareStorage() throws {
        guard !resume else {
            throw HostFailure(
                code: "invalid_argument",
                message: "Resume mode does not prepare or replace provisioning storage."
            )
        }
        let fileManager = FileManager.default
        try createParentDirectory(for: installationImageURL, fileManager: fileManager)
        try createParentDirectory(for: efiVariablesURL, fileManager: fileManager)

        if force {
            try removeIfPresent(installationImageURL, fileManager: fileManager)
            try removeIfPresent(efiVariablesURL, fileManager: fileManager)
        } else {
            if fileManager.fileExists(atPath: installationImageURL.path) {
                throw HostFailure(
                    code: "resource_exists",
                    message: "The provisioning disk already exists at \(installationImageURL.path). "
                        + "Use --force only when you intend to replace it."
                )
            }
            if fileManager.fileExists(atPath: efiVariablesURL.path) {
                throw HostFailure(
                    code: "resource_exists",
                    message: "The provisioning EFI store already exists at \(efiVariablesURL.path). "
                        + "Use --force only when you intend to replace it."
                )
            }
        }

        try createSparseRawImage(at: installationImageURL, fileManager: fileManager)
    }

    private func validatePaths() throws {
        let fileManager = FileManager.default
        if let installerISOURL {
            try requireRegularNonEmptyFile(
                installerISOURL,
                label: "Ubuntu 24.04 LTS ARM64 installer ISO",
                fileManager: fileManager
            )
            guard installerISOURL.standardizedFileURL != installationImageURL.standardizedFileURL else {
                throw HostFailure(
                    code: "invalid_storage",
                    message: "The installer ISO and writable installation disk must be different files."
                )
            }
        }
        if resume {
            try requireRegularNonEmptyFile(
                installationImageURL,
                label: "existing provisioning disk",
                fileManager: fileManager
            )
            try requireRegularNonEmptyFile(
                efiVariablesURL,
                label: "existing provisioning EFI store",
                fileManager: fileManager
            )
        }
        try requireDirectory(runtimeShareURL, label: "Helm runtime directory", fileManager: fileManager)
    }

    private func requireDirectory(
        _ url: URL,
        label: String,
        fileManager: FileManager
    ) throws {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw HostFailure(code: "missing_resource", message: "The \(label) is missing: \(url.path)")
        }
        guard isDirectory.boolValue else {
            throw HostFailure(code: "invalid_resource", message: "The \(label) is not a directory: \(url.path)")
        }
    }

    private func createParentDirectory(for url: URL, fileManager: FileManager) throws {
        let parentURL = url.deletingLastPathComponent()
        do {
            try fileManager.createDirectory(at: parentURL, withIntermediateDirectories: true)
        } catch {
            throw HostFailure(
                code: "storage_error",
                message: "Unable to create the VM data directory \(parentURL.path): \(error.localizedDescription)"
            )
        }
    }

    private func createSparseRawImage(at url: URL, fileManager: FileManager) throws {
        let descriptor = open(url.path, O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw HostFailure(
                code: "storage_error",
                message: "Unable to create the sparse installation disk at \(url.path) (errno \(errno))."
            )
        }
        defer { close(descriptor) }

        guard Self.installationDiskSizeBytes <= UInt64(Int64.max) else {
            try? fileManager.removeItem(at: url)
            throw HostFailure(code: "storage_error", message: "Installation disk size is not representable.")
        }
        guard ftruncate(descriptor, off_t(Self.installationDiskSizeBytes)) == 0 else {
            let failureNumber = errno
            try? fileManager.removeItem(at: url)
            throw HostFailure(
                code: "storage_error",
                message: "Unable to size the installation disk at \(url.path) (errno \(failureNumber))."
            )
        }
    }

    private func requireRegularNonEmptyFile(
        _ url: URL,
        label: String,
        fileManager: FileManager
    ) throws {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw HostFailure(code: "missing_resource", message: "The \(label) is missing: \(url.path)")
        }
        guard !isDirectory.boolValue else {
            throw HostFailure(code: "invalid_resource", message: "The \(label) is a directory: \(url.path)")
        }
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            throw HostFailure(code: "invalid_resource", message: "The \(label) is empty: \(url.path)")
        }
    }

    private func removeIfPresent(_ url: URL, fileManager: FileManager) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue {
            throw HostFailure(
                code: "invalid_resource",
                message: "Refusing to remove a provisioning directory as if it were an image: \(url.path)"
            )
        }
        do {
            try fileManager.removeItem(at: url)
        } catch {
            throw HostFailure(
                code: "storage_error",
                message: "Unable to replace \(url.path): \(error.localizedDescription)"
            )
        }
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

    private static func parseUInt64(_ value: String, option: String) throws -> UInt64 {
        guard let parsed = UInt64(value) else {
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

    private static func printUsage() {
        let usage = """
        helm-vm-host --provision: interactive Ubuntu 24.04 LTS ARM64 installer

        Options:
          --installer-iso PATH    Official Ubuntu ARM64 installer ISO (fresh mode or optional resume media)
          --installation-image PATH
                                  New sparse raw installation disk
          --efi-vars PATH         Fresh provisioning EFI variable store
          --machine-id PATH       Persistent provisioning machine identifier
          --runtime-share PATH    Read-only VirtioFS host directory
          --runtime-tag TAG       VirtioFS tag (default: helm-runtime)
          --cpus N                Guest CPU count (default: 4)
          --memory-mib N          Guest memory (default: 4096)
          --display-width N       VM display width (default: 1280)
          --display-height N      VM display height (default: 800)
          --resume                Reuse existing provisioning disk and EFI state
          --force                 Replace an interrupted provisioning attempt

        The ISO architecture is not introspected. Supply the official Ubuntu
        24.04 LTS ARM64 image documented by Helm.
        """
        FileHandle.standardError.write(Data(usage.utf8))
    }
}
