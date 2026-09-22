import AppKit
import Foundation
import Virtualization

/// Owns the AppKit event loop used for the manual Ubuntu installation.
///
/// This mode is deliberately separate from `VMHost`: the normal host is a
/// JSONL service used by Bun, while provisioning needs a real interactive
/// `VZVirtualMachineView` and must never mix human-readable UI output into the
/// JSONL stream.
public final class ProvisioningHost: NSObject, NSApplicationDelegate, NSWindowDelegate, VZVirtualMachineDelegate {
    private static var activeHost: ProvisioningHost?

    private let options: ProvisioningOptions
    private let configuration: VZVirtualMachineConfiguration
    private var virtualMachine: VZVirtualMachine?
    private var window: NSWindow?
    private var virtualMachineView: VZVirtualMachineView?
    private var statusField: NSTextField?
    private var isTerminating = false
    private var terminationReplyPending = false
    private(set) var exitCode = 0

    private init(options: ProvisioningOptions, configuration: VZVirtualMachineConfiguration) {
        self.options = options
        self.configuration = configuration
        super.init()
    }

    public static func run(options: ProvisioningOptions) throws -> Int {
        // Validate and prepare all host-side resources before entering the
        // AppKit event loop. CLI failures must return normally even when no
        // window can be created.
        let configuration = try ProvisioningConfigurationBuilder(options: options).makeConfiguration()
        let application = NSApplication.shared
        let host = ProvisioningHost(options: options, configuration: configuration)
        activeHost = host
        host.writeDiagnostic("resolved runtime directory: \(options.runtimeShareURL.path)")
        host.writeDiagnostic("VirtioFS tag: \(options.runtimeTag)")
        host.writeDiagnostic("readOnly=\(HelmRuntimeShareConfiguration.isReadOnly)")
        host.writeDiagnostic("directorySharingDevices=\(configuration.directorySharingDevices.count)")
        application.setActivationPolicy(.regular)
        application.delegate = host
        application.run()
        application.delegate = nil
        activeHost = nil
        return host.exitCode
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        let newVM = VZVirtualMachine(configuration: configuration)
        newVM.delegate = self
        virtualMachine = newVM
        makeWindow(for: newVM)

        statusField?.stringValue = options.resume
            ? "Resuming the existing Ubuntu provisioning disk…"
            : "Starting Ubuntu 24.04 LTS installer…"
        writeDiagnostic(options.resume
            ? "Resume mode started. The existing provisioning disk and EFI state will be retained."
            : "Provisioning mode started. Install Ubuntu into the empty 24 GiB disk.")
        newVM.start { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .failure(let error) = result {
                    self.finishWithError(
                        HostFailure(code: "vm_start_failed", message: error.localizedDescription)
                    )
                    return
                }
                self.statusField?.stringValue = self.options.resume
                    ? "Running. Continue the Ubuntu installation in this window."
                    : "Running. Complete the Ubuntu installation in this window."
                self.writeDiagnostic("The VM is running. Shut it down from Ubuntu, close this window, then run `bun run vm:seal`.")
            }
        }
    }

    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    public func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let existingVM = virtualMachine else {
            isTerminating = true
            return .terminateNow
        }
        if isTerminating {
            return existingVM.state == .stopped || existingVM.state == .error
                ? .terminateNow
                : .terminateCancel
        }
        guard existingVM.canRequestStop || existingVM.canStop else {
            statusField?.stringValue = "The VM is still starting; wait a moment before closing."
            return .terminateCancel
        }
        let canTerminateNow = beginTermination(for: existingVM)
        if !canTerminateNow {
            terminationReplyPending = true
            return .terminateLater
        }
        return .terminateNow
    }

    public func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let existingVM = virtualMachine else {
            isTerminating = true
            return true
        }
        if isTerminating {
            return existingVM.state == .stopped || existingVM.state == .error
        }
        guard existingVM.canRequestStop || existingVM.canStop else {
            statusField?.stringValue = "The VM is still starting; wait a moment before closing."
            return false
        }
        return beginTermination(for: existingVM)
    }

    public func windowWillClose(_ notification: Notification) {
        guard !isTerminating else {
            NSApp.terminate(nil)
            return
        }
        isTerminating = true
        NSApp.terminate(nil)
    }

    // MARK: VZVirtualMachineDelegate

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        if isTerminating {
            completeTermination()
            return
        }
        statusField?.stringValue = "VM stopped. Disk retained. Close this window, then run `bun run vm:seal`."
        writeDiagnostic("The guest stopped normally. Installation disk retained at \(options.installationImageURL.path).")
    }

    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        exitCode = 1
        statusField?.stringValue = "VM stopped with an error. The installation disk was retained."
        writeDiagnostic("The provisioning VM stopped with an error: \(error.localizedDescription)")
        if isTerminating {
            completeTermination()
        }
    }

    private func makeWindow(for virtualMachine: VZVirtualMachine) {
        let title = NSTextField(labelWithString: "HELM PROVISIONING")
        title.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        title.textColor = .secondaryLabelColor

        let subtitle = NSTextField(
            labelWithString: options.resume
                ? "Resume Ubuntu 24.04 LTS provisioning"
                : "Ubuntu 24.04 LTS ARM64 installer"
        )
        subtitle.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        subtitle.textColor = .labelColor

        let instructionsText = options.resume
            ? "Continue the existing Ubuntu installation. When finished, shut down the guest, close this window, and run bun run vm:seal."
            : "Install Ubuntu into the empty Helm disk. When installation is complete, shut down the guest, close this window, and run bun run vm:seal."
        let instructions = NSTextField(wrappingLabelWithString: instructionsText)
        instructions.font = NSFont.systemFont(ofSize: 13)
        instructions.textColor = .secondaryLabelColor

        let status = NSTextField(labelWithString: "Preparing…")
        status.font = NSFont.systemFont(ofSize: 13)
        status.textColor = .secondaryLabelColor
        statusField = status

        let view = makeHelmVirtualMachineView(for: virtualMachine)
        view.translatesAutoresizingMaskIntoConstraints = false
        virtualMachineView = view

        let stack = NSStackView(views: [title, subtitle, instructions, view, status])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false

        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        view.widthAnchor.constraint(greaterThanOrEqualToConstant: 960).isActive = true
        view.heightAnchor.constraint(greaterThanOrEqualToConstant: 600).isActive = true
        instructions.widthAnchor.constraint(equalToConstant: 960).isActive = true
        status.widthAnchor.constraint(equalToConstant: 960).isActive = true

        let newWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        newWindow.title = "Helm VM Provisioning"
        newWindow.isReleasedWhenClosed = false
        newWindow.delegate = self
        newWindow.contentView = stack
        newWindow.center()
        newWindow.makeKeyAndOrderFront(nil)
        window = newWindow

        NSApp.activate(ignoringOtherApps: true)
    }

    private func finishWithError(_ failure: HostFailure) {
        exitCode = 1
        writeDiagnostic(failure.message)
        statusField?.stringValue = "Provisioning failed: \(failure.message)"
        DispatchQueue.main.async {
            NSApp.terminate(nil)
        }
    }

    private func beginTermination(for virtualMachine: VZVirtualMachine) -> Bool {
        switch virtualMachine.state {
        case .stopped, .error:
            isTerminating = true
            return true
        default:
            break
        }

        isTerminating = true
        if virtualMachine.canRequestStop {
            do {
                try virtualMachine.requestStop()
                statusField?.stringValue = "Asking Ubuntu to shut down. The provisioning disk will be retained."
                return false
            } catch {
                writeDiagnostic("Graceful guest shutdown was unavailable; stopping the VM directly: \(error.localizedDescription)")
            }
        }

        guard virtualMachine.canStop else {
            exitCode = 1
            statusField?.stringValue = "The VM cannot be stopped safely right now."
            return false
        }

        statusField?.stringValue = "Stopping. The provisioning disk will be retained."
        virtualMachine.stop { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.exitCode = 1
                    self.writeDiagnostic("Unable to stop the provisioning VM: \(error.localizedDescription)")
                }
                self.completeTermination()
            }
        }
        return false
    }

    private func completeTermination() {
        if terminationReplyPending {
            terminationReplyPending = false
            NSApp.reply(toApplicationShouldTerminate: true)
        } else {
            NSApp.terminate(nil)
        }
    }

    private func writeDiagnostic(_ message: String) {
        let output = "helm-vm-host provisioning: \(message)\n"
        FileHandle.standardError.write(Data(output.utf8))
    }
}
