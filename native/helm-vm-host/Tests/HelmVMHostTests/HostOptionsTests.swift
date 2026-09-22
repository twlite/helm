import XCTest
@testable import HelmVMHostCore

final class HostOptionsTests: XCTestCase {
    func testShowWindowDefaultsToHeadlessAndCanBeEnabled() throws {
        let headless = try XCTUnwrap(HostOptions.parse(arguments: []))
        XCTAssertFalse(headless.showWindow)

        let withViewer = try XCTUnwrap(HostOptions.parse(arguments: ["--show-window"]))
        XCTAssertTrue(withViewer.showWindow)
    }
}
