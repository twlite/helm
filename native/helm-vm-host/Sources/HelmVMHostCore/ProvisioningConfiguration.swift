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

        if !options.resume {
            try options.prepareStorage()
        }

        let configuration = VZVirtualMachineConfiguration()
        configuration.cpuCount = options.cpuCount
        configuration.memorySize = options.memorySize

        let platform = VZGenericPlatformConfiguration()
        platform.machineIdentifier = try loadOrCreateMachineIdentifier()
        configuration.platform = platform

        // A fresh EFI store is created specifically for this installer run.
        let bootLoader = VZEFIBootLoader()
        if options.resume {
            bootLoader.variableStore = VZEFIVariableStore(url: options.efiVariablesURL)
        } else {
            // A fresh EFI store is created specifically for this installer run.
            // It is intentionally separate from Helm's normal runtime EFI state.
            bootLoader.variableStore = try VZEFIVariableStore(
                creatingVariableStoreAt: options.efiVariablesURL,
                options: []
            )
        }
        configuration.bootLoader = bootLoader

        let installationDiskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: options.installationImageURL,
            readOnly: false
        )
        var storageDevices: [VZStorageDeviceConfiguration] = [
            VZVirtioBlockDeviceConfiguration(attachment: installationDiskAttachment)
        ]
        if let installerISOURL = options.installerISOURL {
            // Apple exposes installer media to a GUI Linux VM as a read-only
            // USB mass-storage device alongside the writable Virtio disk.
            let installerAttachment = try VZDiskImageStorageDeviceAttachment(
                url: installerISOURL,
                readOnly: true
            )
            storageDevices.append(VZUSBMassStorageDeviceConfiguration(attachment: installerAttachment))
        }
        configuration.storageDevices = storageDevices

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
        configuration.consoleDevices = [makeHelmSpiceAgentConsoleDeviceConfiguration()]

        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]

        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        _ = try HelmRuntimeShareConfiguration(
            directoryURL: options.runtimeShareURL,
            tag: options.runtimeTag
        ).appendDevice(to: configuration)

        try configuration.validate()
        return configuration
    }

    private func loadOrCreateMachineIdentifier() throws -> VZGenericMachineIdentifier {
        let fileManager = FileManager.default
        let parentURL = options.machineIdentifierURL.deletingLastPathComponent()
        do {
            try fileManager.createDirectory(at: parentURL, withIntermediateDirectories: true)
        } catch {
            throw HostFailure(
                code: "storage_error",
                message: "Unable to prepare the machine identifier directory \(parentURL.path): \(error.localizedDescription)"
            )
        }

        if fileManager.fileExists(atPath: options.machineIdentifierURL.path) {
            do {
                let data = try Data(contentsOf: options.machineIdentifierURL)
                guard let identifier = VZGenericMachineIdentifier(dataRepresentation: data) else {
                    throw HostFailure(
                        code: "invalid_machine_identifier",
                        message: "The provisioning machine identifier is invalid: \(options.machineIdentifierURL.path)"
                    )
                }
                return identifier
            } catch let failure as HostFailure {
                throw failure
            } catch {
                throw HostFailure(
                    code: "invalid_machine_identifier",
                    message: "Unable to read the provisioning machine identifier at \(options.machineIdentifierURL.path): \(error.localizedDescription)"
                )
            }
        }

        let identifier = VZGenericMachineIdentifier()
        do {
            try identifier.dataRepresentation.write(to: options.machineIdentifierURL, options: .atomic)
        } catch {
            throw HostFailure(
                code: "storage_error",
                message: "Unable to persist the provisioning machine identifier at \(options.machineIdentifierURL.path): \(error.localizedDescription)"
            )
        }
        return identifier
    }
}
