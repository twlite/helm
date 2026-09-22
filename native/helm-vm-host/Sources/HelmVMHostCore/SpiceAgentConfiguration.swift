import Virtualization

/// Creates the Virtio console port used by Apple's SPICE guest agent.
///
/// The Linux guest still needs the `spice-vdagent` package running in its
/// graphical session. The host-side attachment advertises clipboard support;
/// it does not provide a guest-side agent by itself.
func makeHelmSpiceAgentConsoleDeviceConfiguration() -> VZVirtioConsoleDeviceConfiguration {
    let consoleDevice = VZVirtioConsoleDeviceConfiguration()

    let spiceAgentPort = VZVirtioConsolePortConfiguration()
    spiceAgentPort.name = VZSpiceAgentPortAttachment.spiceAgentPortName

    let attachment = VZSpiceAgentPortAttachment()
    attachment.sharesClipboard = true
    spiceAgentPort.attachment = attachment

    // A SPICE agent port is not the guest's system console.
    spiceAgentPort.isConsole = false
    consoleDevice.ports[0] = spiceAgentPort

    return consoleDevice
}
