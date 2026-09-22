import Foundation
import Darwin
import HelmVMHostCore

@main
struct HelmVMHostMain {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments.first == "--repair-efi-vars" {
                guard arguments.count == 2 else {
                    throw NSError(
                        domain: "HelmVMHost",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Usage: helm-vm-host --repair-efi-vars PATH"]
                    )
                }
                let efiURL = resolveHelmPath(arguments[1])
                let backupURL = try HelmEFIVariableStoreRecovery.repair(at: efiURL)
                print("Replaced EFI variable store: \(efiURL.path)")
                print("Preserved previous EFI state at: \(backupURL.path)")
                return
            }
            if arguments.first == "--provision" || arguments.first == "--interactive-provision" {
                guard let options = try ProvisioningOptions.parse(arguments: Array(arguments.dropFirst())) else {
                    return
                }
                let exitCode = try ProvisioningHost.run(options: options)
                if exitCode != 0 {
                    Darwin.exit(Int32(exitCode))
                }
                return
            }

            guard let options = try HostOptions.parse(arguments: arguments) else {
                return
            }
            VMHost(options: options).run()
        } catch {
            let encodedDetails = encodedHostFailure(from: error)
            FileHandle.standardError.write(Data("helm-vm-host: \(encodedDetails)\n".utf8))
            Darwin.exit(1)
        }
    }
}
