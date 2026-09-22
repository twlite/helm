import AppKit
import Virtualization

/// Applies the display configuration shared by provisioning and maintenance
/// windows. The VM itself remains owned by the caller.
func makeHelmVirtualMachineView(for virtualMachine: VZVirtualMachine) -> VZVirtualMachineView {
    let view = VZVirtualMachineView(frame: .zero)
    view.automaticallyReconfiguresDisplay = true
    if #available(macOS 11.0, *) {
        view.capturesSystemKeys = true
    }
    view.virtualMachine = virtualMachine
    return view
}

/// Small native viewer used by the JSONL maintenance host.
///
/// Closing the window only exits the viewer's AppKit loop through `onClose`.
/// The VM owner decides how and when the VM is stopped, which keeps window
/// lifetime separate from disk and guest-RPC lifecycle.
final class HelmVMViewerWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let virtualMachineView: VZVirtualMachineView

    private let onClose: () -> Void
    private var closeRequested = false

    init(
        title: String,
        width: Int,
        height: Int,
        virtualMachine: VZVirtualMachine,
        onClose: @escaping () -> Void
    ) {
        self.onClose = onClose

        let view = makeHelmVirtualMachineView(for: virtualMachine)
        view.autoresizingMask = [.width, .height]

        let newWindow = NSWindow(
            contentRect: NSRect(
                x: 0,
                y: 0,
                width: CGFloat(max(width, 640)),
                height: CGFloat(max(height, 400))
            ),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        newWindow.title = title
        newWindow.isReleasedWhenClosed = false
        newWindow.minSize = NSSize(width: 640, height: 400)
        newWindow.contentView = view

        self.window = newWindow
        self.virtualMachineView = view
        super.init()

        newWindow.delegate = self
        newWindow.center()
    }

    func attach(to virtualMachine: VZVirtualMachine) {
        virtualMachineView.virtualMachine = virtualMachine
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        guard !closeRequested else { return false }
        closeRequested = true
        onClose()
        return false
    }
}
