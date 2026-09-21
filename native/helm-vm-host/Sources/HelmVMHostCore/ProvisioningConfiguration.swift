import Foundation
import Virtualization

struct ProvisioningConfigurationBuilder {
    let options: ProvisioningOptions

    func makeConfiguration() throws -> VZVirtualMachineConfiguration {
        #if arch(arm64)
        // Ubuntu's installer and the Helm guest target Apple Silicon. Do not
        // silently attempt to translate an x86 image on an Intel Mac.
        #else
        throw HostFailure(
            code: "unsupported_architecture",
            message: "Helm provisioning supports Apple Silicon (arm64) only."
        )
        #endif

        guard VZVirtualMachine.isSupported else {
            throw HostFailure(
                code: "virtualization_unavailable",
                message: "Virtualization.framework is not supported on this Mac."
            )
        }

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

        try options.prepareStorage()

        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = options.cpuCount
        configuration.memorySize = options.memorySize

        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = VZGenericMachineIdentifier()
        configuration.platform = platform

        // A fresh EFI store is created specifically for this installer run.
        // It is intentionally separate from Helm's normal runtime EFI state.
        let bootLoader = VZEFIBootLoader()
        bootLoader.variableStore = try VZEFIVariableStore(
            creatingVariableStoreAt: options.efiVariablesURL,
            options: []
        )
        configuration.bootLoader = bootLoader

        let installationDiskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: options.installationImageURL,
            readOnly: false
        )
        // Apple exposes installer media to a GUI Linux VM as a read-only USB
        // mass-storage device alongside the writable Virtio disk.
        let installerAttachment = try VZDiskImageStorageDeviceAttachment(
            url: options.installerISOURL,
            readOnly: true
        )
        let installerMedia = VZUSBMassStorageDeviceConfiguration(attachment: installerAttachment)
        configuration.storageDevices = [
            VZVirtioBlockDeviceConfiguration(attachment: installationDiskAttachment),
            installerMedia
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

        try configuration.validate()
        return configuration
    }
}
