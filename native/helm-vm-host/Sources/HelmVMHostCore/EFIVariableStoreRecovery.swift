import Foundation
import Virtualization
import Darwin

public enum HelmEFIVariableStoreRecovery {
    /// Replace only the EFI variable store, retaining the old file as a .bak.
    /// The guest disk is never opened or modified by this operation.
    public static func repair(at url: URL) throws -> URL {
        let lockURL = url.deletingLastPathComponent()
            .appendingPathComponent(".helm-vm.lock", isDirectory: false)
        let lifecycleLock = try HelmVMLifecycleLock(url: lockURL)
        return try withExtendedLifetime(lifecycleLock) {
            let fileManager = FileManager.default
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
                throw HostFailure(
                    code: "missing_efi_store",
                    message: "The EFI variable store does not exist at \(url.path). Normal VM startup can create it automatically."
                )
            }
            guard !isDirectory.boolValue else {
                throw HostFailure(
                    code: "invalid_efi_store",
                    message: "The EFI variable store is a directory, not a file: \(url.path)"
                )
            }

            let backupURL = url.deletingLastPathComponent().appendingPathComponent(
                ".\(url.lastPathComponent).recovery-\(UUID().uuidString).bak"
            )
            let temporaryURL = url.deletingLastPathComponent().appendingPathComponent(
                ".\(url.lastPathComponent).repair-\(UUID().uuidString).tmp"
            )

            do {
                // Prepare the replacement while the current state is still
                // intact. The temporary path is unique and never exposed as
                // the canonical store.
                let replacementStore = try VZEFIVariableStore(
                    creatingVariableStoreAt: temporaryURL,
                    options: []
                )
                try fileManager.copyItem(at: url, to: backupURL)
                let renameResult = temporaryURL.path.withCString { sourcePath in
                    url.path.withCString { destinationPath in
                        Darwin.rename(sourcePath, destinationPath)
                    }
                }
                guard renameResult == 0 else {
                    let failureNumber = errno
                    throw HostFailure(
                        code: "storage_error",
                        message: "Unable to atomically install the repaired EFI store at \(url.path) (errno \(failureNumber)).",
                        details: .object([
                            "path": .string(url.path),
                            "errno": .number(Double(failureNumber)),
                        ])
                    )
                }
                withExtendedLifetime(replacementStore) {}
                return backupURL
            } catch let failure as HostFailure {
                try? fileManager.removeItem(at: temporaryURL)
                throw failure
            } catch {
                try? fileManager.removeItem(at: temporaryURL)
                let failure = hostFailure(from: error)
                throw HostFailure(
                    code: failure.code,
                    message: "Unable to repair the EFI variable store at \(url.path): \(failure.message)",
                    details: failure.details
                )
            }
        }
    }
}
