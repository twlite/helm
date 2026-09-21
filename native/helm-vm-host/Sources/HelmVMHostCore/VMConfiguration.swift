import Foundation
import Virtualization

struct VMConfigurationBuilder {
    let options: HostOptions
    let paths: VMPaths

    func makeConfiguration() throws -> VZVirtualMachineConfiguration {
        #if arch(arm64)
        // Helm's first VM image is an ARM64 Linux image. Do not silently try to
        // boot it through translation on an Intel Mac.
        #else
        throw HostFailure(
            code: "unsupported_architecture",
            message: "The Helm VM host supports Apple Silicon (arm64) only."
        )
        #endif

        guard VZVirtualMachine.isSupported else {
            throw HostFailure(
                code: "virtualization_unavailable",
                message: "Virtualization.framework is not supported on this Mac."
            )
        }

        try paths.prepareHostDirectories()
        try paths.ensureWorkingImage()

        guard options.cpuCount >= VZVirtualMachineConfiguration.minimumAllowedCPUCount,
              options.cpuCount <= VZVirtualMachineConfiguration.maximumAllowedCPUCount else {
            throw HostFailure(
                code: "invalid_configuration",
                message: "CPU count \(options.cpuCount) is outside the framework's allowed range "
                    + "(\(VZVirtualMachineConfiguration.minimumAllowedCPUCount)..."
                    + "\(VZVirtualMachineConfiguration.maximumAllowedCPUCount))."
            )
        }
        guard options.memorySize >= VZVirtualMachineConfiguration.minimumAllowedMemorySize,
              options.memorySize <= VZVirtualMachineConfiguration.maximumAllowedMemorySize else {
            throw HostFailure(
                code: "invalid_configuration",
                message: "Memory size \(options.memorySize) bytes is outside the framework's allowed range "
                    + "(\(VZVirtualMachineConfiguration.minimumAllowedMemorySize)..."
                    + "\(VZVirtualMachineConfiguration.maximumAllowedMemorySize))."
            )
        }

        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = options.cpuCount
        configuration.memorySize = options.memorySize

        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = try loadOrCreateMachineIdentifier()
        configuration.platform = platform

        let bootLoader = VZEFIBootLoader()
        bootLoader.variableStore = try loadOrCreateEFIVariableStore()
        configuration.bootLoader = bootLoader

        let diskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: paths.workingImageURL,
            readOnly: false
        )
        configuration.storageDevices = [
            VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)
        ]

        let graphics = VZVirtioGraphicsDeviceConfiguration()
        graphics.scanouts = [
            VZVirtioGraphicsScanoutConfiguration(
                widthInPixels: options.displayWidth,
                heightInPixels: options.displayHeight
            )
        ]
        configuration.graphicsDevices = [graphics]
        configuration.keyboards = [VZUSBKeyboardConfiguration()]
        configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]

        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]

        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        try VZVirtioFileSystemDeviceConfiguration.validateTag(options.runtimeTag)
        let runtimeDirectory = VZSharedDirectory(url: paths.runtimeShareURL, readOnly: true)
        let runtimeShare = VZSingleDirectoryShare(directory: runtimeDirectory)
        let fileSystem = VZVirtioFileSystemDeviceConfiguration(tag: options.runtimeTag)
        fileSystem.share = runtimeShare
        configuration.directorySharingDevices = [fileSystem]

        // The guest listens on this device using AF_VSOCK. The actual port is
        // selected by the host at request time, so the configuration only needs
        // one Virtio socket device.
        configuration.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        try configuration.validate()
        return configuration
    }

    private func loadOrCreateMachineIdentifier() throws -> VZGenericMachineIdentifier {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: options.machineIdentifierURL.path) {
            let data = try Data(contentsOf: options.machineIdentifierURL)
            guard let identifier = VZGenericMachineIdentifier(dataRepresentation: data) else {
                throw HostFailure(
                    code: "invalid_machine_identifier",
                    message: "The persisted generic machine identifier is invalid: "
                        + options.machineIdentifierURL.path
                )
            }
            return identifier
        }

        let identifier = VZGenericMachineIdentifier()
        try identifier.dataRepresentation.write(to: options.machineIdentifierURL, options: .atomic)
        return identifier
    }

    private func loadOrCreateEFIVariableStore() throws -> VZEFIVariableStore {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: options.efiVariablesURL.path) {
            return VZEFIVariableStore(url: options.efiVariablesURL)
        }
        return try VZEFIVariableStore(creatingVariableStoreAt: options.efiVariablesURL)
    }
}
