import Foundation
import Darwin
import HelmVMHostCore

@main
struct HelmVMHostMain {
    static func main() {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
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
            let failure = error as NSError
            let message = "helm-vm-host: \(failure.localizedDescription)\n"
            FileHandle.standardError.write(Data(message.utf8))
            Darwin.exit(1)
        }
    }
}
