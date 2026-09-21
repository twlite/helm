import XCTest
@testable import HelmVMHostCore

final class ProtocolTests: XCTestCase {
    func testHostCommandDefaultsMissingParamsToObject() throws {
        let data = Data(#"{"id":"one","method":"vm.status"}"#.utf8)
        let command = try JSONDecoder().decode(HostCommand.self, from: data)

        XCTAssertEqual(command.id, .string("one"))
        XCTAssertEqual(command.method, "vm.status")
        XCTAssertEqual(command.params, .object([:]))
    }

    func testJSONValueRoundTripsNestedGuestRequest() throws {
        let value: JSONValue = .object([
            "method": .string("filesystem.readText"),
            "params": .object([
                "path": .string("/home/helm/workspace/example.txt"),
                "limit": .number(512)
            ])
        ])

        let encoded = try JSONEncoder().encode(value)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: encoded)

        XCTAssertEqual(decoded, value)
    }
}
