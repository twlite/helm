import Darwin
import Foundation

/// Serialize access to the VM disk, EFI store, and machine identity across
/// normal runtime, maintenance, provisioning, and repair helper processes.
/// `flock` releases the lock automatically if a process crashes, so there is
/// no stale PID file that can block recovery.
final class HelmVMLifecycleLock {
    private let descriptor: Int32

    init(url: URL) throws {
        let parentURL = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: parentURL,
                withIntermediateDirectories: true
            )
        } catch {
            let failure = hostFailure(from: error)
            throw HostFailure(
                code: "storage_error",
                message: "Unable to prepare the VM lock directory \(parentURL.path): \(failure.message)",
                details: failure.details
            )
        }

        let descriptor = open(
            url.path,
            O_RDWR | O_CREAT,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            let failureNumber = errno
            throw HostFailure(
                code: "storage_error",
                message: "Unable to open the VM lifecycle lock at \(url.path) (errno \(failureNumber)).",
                details: .object([
                    "path": .string(url.path),
                    "errno": .number(Double(failureNumber)),
                ])
            )
        }

        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let failureNumber = errno
            close(descriptor)
            if failureNumber == EACCES || failureNumber == EAGAIN || failureNumber == EWOULDBLOCK {
                throw HostFailure(
                    code: "vm_in_use",
                    message: "Another Helm VM host already owns the VM state. Stop it before starting another VM host.",
                    details: .object([
                        "lockPath": .string(url.path),
                        "errno": .number(Double(failureNumber)),
                    ])
                )
            }
            throw HostFailure(
                code: "storage_error",
                message: "Unable to lock the Helm VM state at \(url.path) (errno \(failureNumber)).",
                details: .object([
                    "lockPath": .string(url.path),
                    "errno": .number(Double(failureNumber)),
                ])
            )
        }

        self.descriptor = descriptor
    }

    deinit {
        _ = flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}
