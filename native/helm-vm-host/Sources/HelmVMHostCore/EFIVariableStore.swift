import Foundation
import Virtualization

/// The EFI variable store is part of the VM's persistent state, but it is a
/// separate file from the guest disk. Keep creation out of the final path
/// until Virtualization.framework has finished writing the new store.
enum HelmEFIVariableStore {
    static func loadExisting(at url: URL, label: String) throws -> VZEFIVariableStore {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw HostFailure(
                code: "missing_efi_store",
                message: "The \(label) is missing: \(url.path)"
            )
        }
        guard !isDirectory.boolValue else {
            throw HostFailure(
                code: "invalid_efi_store",
                message: "The \(label) is a directory, not an EFI variable store: \(url.path)"
            )
        }

        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            throw HostFailure(
                code: "invalid_efi_store",
                message: "The \(label) is empty: \(url.path)"
            )
        }

        // Apple's existing-store initializer does not throw. The framework
        // performs the deeper validation when the VM starts, so leave the
        // original file untouched and preserve that later NSError if it is
        // rejected.
        return VZEFIVariableStore(url: url)
    }

    static func createAtomically(at url: URL) throws -> VZEFIVariableStore {
        let fileManager = FileManager.default
        let parentURL = url.deletingLastPathComponent()
        try fileManager.createDirectory(at: parentURL, withIntermediateDirectories: true)

        guard !fileManager.fileExists(atPath: url.path) else {
            throw HostFailure(
                code: "resource_exists",
                message: "The EFI variable store already exists at \(url.path)."
            )
        }

        let temporaryURL = parentURL.appendingPathComponent(
            ".\(url.lastPathComponent).\(UUID().uuidString).tmp"
        )
        do {
            _ = try VZEFIVariableStore(
                creatingVariableStoreAt: temporaryURL,
                options: []
            )
            try installWithoutReplacing(temporaryURL, at: url)
            return VZEFIVariableStore(url: url)
        } catch let failure as HostFailure {
            try? fileManager.removeItem(at: temporaryURL)
            throw failure
        } catch {
            try? fileManager.removeItem(at: temporaryURL)
            let failure = hostFailure(from: error)
            throw HostFailure(
                code: failure.code,
                message: "Unable to create the EFI variable store at \(url.path): \(failure.message)",
                details: failure.details
            )
        }
    }

    private static func installWithoutReplacing(_ source: URL, at destination: URL) throws {
        do {
            // Both paths are in the VM directory. A hard-link install is
            // atomic and fails if another process won the destination race.
            try FileManager.default.linkItem(at: source, to: destination)
            try FileManager.default.removeItem(at: source)
        } catch {
            let failure = hostFailure(from: error)
            throw HostFailure(
                code: "storage_error",
                message: "Unable to install the EFI variable store at \(destination.path): \(failure.message)",
                details: failure.details
            )
        }
    }
}
