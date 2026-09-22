import Foundation
import XCTest
@testable import HelmVMHostCore

final class ErrorTests: XCTestCase {
    func testHostFailurePreservesNSErrorDiagnostics() throws {
        let underlying = NSError(
            domain: "UnderlyingDomain",
            code: 7,
            userInfo: [NSLocalizedDescriptionKey: "underlying detail"]
        )
        let error = NSError(
            domain: "VirtualizationTestDomain",
            code: 42,
            userInfo: [
                NSLocalizedDescriptionKey: "Invalid virtual machine configuration.",
                NSLocalizedFailureReasonErrorKey: "The boot loader is invalid.",
                NSLocalizedRecoverySuggestionErrorKey: "Repair the EFI state.",
                NSDebugDescriptionErrorKey: "debug boot-loader detail",
                NSUnderlyingErrorKey: underlying,
                "custom": ["key": "value"]
            ]
        )

        let failure = hostFailure(from: error)
        XCTAssertEqual(failure.code, "host_error")
        XCTAssertEqual(failure.message, "Invalid virtual machine configuration.")
        let details = try XCTUnwrap(failure.details?.objectValue)
        XCTAssertEqual(details["domain"], .string("VirtualizationTestDomain"))
        XCTAssertEqual(details["code"], .number(42))
        XCTAssertEqual(details["failureReason"], .string("The boot loader is invalid."))
        XCTAssertEqual(details["recoverySuggestion"], .string("Repair the EFI state."))
        XCTAssertEqual(details["debugDescription"], .string("debug boot-loader detail"))
        XCTAssertNotNil(details["userInfo"])
        XCTAssertNotNil(details["underlyingError"])
    }
}
