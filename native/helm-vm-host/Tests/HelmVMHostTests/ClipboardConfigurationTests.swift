import Virtualization
import XCTest
@testable import HelmVMHostCore

final class ClipboardConfigurationTests: XCTestCase {
    func testSpiceAgentPortAdvertisesClipboardSharing() throws {
        let consoleDevice = makeHelmSpiceAgentConsoleDeviceConfiguration()
        let port = consoleDevice.ports[0]

        XCTAssertEqual(port.name, VZSpiceAgentPortAttachment.spiceAgentPortName)
        XCTAssertFalse(port.isConsole)

        let attachment = try XCTUnwrap(port.attachment as? VZSpiceAgentPortAttachment)
        XCTAssertTrue(attachment.sharesClipboard)
    }
}
