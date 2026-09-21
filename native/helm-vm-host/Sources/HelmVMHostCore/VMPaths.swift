import Foundation

struct VMPaths {
    let rootURL: URL
    let baseImageURL: URL
    let workingImageURL: URL
    let efiVariablesURL: URL
    let machineIdentifierURL: URL
    let runtimeShareURL: URL

    func prepareHostDirectories() throws {
        let fileManager = FileManager.default
        try createDirectory(rootURL, fileManager: fileManager)
        try createDirectory(rootURL.appendingPathComponent("vm", isDirectory: true), fileManager: fileManager)
        try createDirectory(runtimeShareURL, fileManager: fileManager)
    }

    func requireBaseImage() throws {
        try requireRegularNonEmptyFile(baseImageURL, label: "base image")
    }

    func ensureWorkingImage() throws {
        try requireBaseImage()
        guard baseImageURL.standardizedFileURL != workingImageURL.standardizedFileURL else {
            throw HostFailure(
                code: "invalid_storage",
                message: "Base and working image paths must be different."
            )
        }

        if FileManager.default.fileExists(atPath: workingImageURL.path) {
            try requireRegularNonEmptyFile(workingImageURL, label: "working image")
            return
        }

        try copyFileAtomically(from: baseImageURL, to: workingImageURL)
    }

    func resetWorkingState() throws {
        try requireBaseImage()
        guard baseImageURL.standardizedFileURL != workingImageURL.standardizedFileURL else {
            throw HostFailure(
                code: "invalid_storage",
                message: "Base and working image paths must be different."
            )
        }

        try copyFileAtomically(from: baseImageURL, to: workingImageURL)
        try removeIfPresent(efiVariablesURL)
        try removeIfPresent(machineIdentifierURL)
    }

    func fileInfo(for url: URL) -> [String: JSONValue] {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: url.path) else {
            return [
                "path": .string(url.path),
                "exists": .boolean(false)
            ]
        }

        do {
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            let type = (attributes[.type] as? FileAttributeType)?.rawValue ?? "unknown"
            let size = (attributes[.size] as? NSNumber)?.doubleValue ?? 0
            return [
                "path": .string(url.path),
                "exists": .boolean(true),
                "type": .string(type),
                "sizeBytes": .number(size)
            ]
        } catch {
            return [
                "path": .string(url.path),
                "exists": .boolean(true),
                "error": .string(error.localizedDescription)
            ]
        }
    }

    private func createDirectory(_ url: URL, fileManager: FileManager) throws {
        if fileManager.fileExists(atPath: url.path) {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                throw HostFailure(
                    code: "invalid_path",
                    message: "Expected a directory at \(url.path)."
                )
            }
            return
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    }

    private func requireRegularNonEmptyFile(_ url: URL, label: String) throws {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw HostFailure(
                code: "missing_resource",
                message: "The \(label) is missing: \(url.path)"
            )
        }
        guard !isDirectory.boolValue else {
            throw HostFailure(
                code: "invalid_resource",
                message: "The \(label) is a directory, not a file: \(url.path)"
            )
        }

        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            throw HostFailure(
                code: "invalid_resource",
                message: "The \(label) is empty: \(url.path)"
            )
        }
    }

    private func copyFileAtomically(from source: URL, to destination: URL) throws {
        let fileManager = FileManager.default
        let temporaryURL = destination.deletingLastPathComponent()
            .appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).tmp")

        do {
            try fileManager.copyItem(at: source, to: temporaryURL)
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: temporaryURL, to: destination)
        } catch {
            if fileManager.fileExists(atPath: temporaryURL.path) {
                try? fileManager.removeItem(at: temporaryURL)
            }
            throw HostFailure(
                code: "storage_error",
                message: "Unable to copy \(source.path) to \(destination.path): \(error.localizedDescription)"
            )
        }
    }

    private func removeIfPresent(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }
}
