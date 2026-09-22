import Foundation
import Virtualization

struct HelmRuntimeShareConfiguration {
    static let defaultTag = "helm-runtime"
    static let isReadOnly = true

    let directoryURL: URL
    let tag: String
    let readOnly = HelmRuntimeShareConfiguration.isReadOnly

    func appendDevice(to configuration: VZVirtualMachineConfiguration) throws -> Int {
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: directoryURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw HostFailure(
                code: "missing_runtime_directory",
                message: "The Helm runtime directory is missing or is not a directory: \(directoryURL.path)"
            )
        }

        try VZVirtioFileSystemDeviceConfiguration.validateTag(tag)

        let sharedDirectory = VZSharedDirectory(url: directoryURL, readOnly: readOnly)
        let share = VZSingleDirectoryShare(directory: sharedDirectory)
        let fileSystem = VZVirtioFileSystemDeviceConfiguration(tag: tag)
        fileSystem.share = share

        var directorySharingDevices = configuration.directorySharingDevices
        directorySharingDevices.append(fileSystem)
        configuration.directorySharingDevices = directorySharingDevices
        return directorySharingDevices.count
    }
}
