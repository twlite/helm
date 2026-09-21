import Foundation
import Darwin
import HelmVMHostCore

@main
struct HelmVMHostMain {
    static func main() {
        do {
            guard let options = try HostOptions.parse(arguments: Array(CommandLine.arguments.dropFirst())) else {
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
