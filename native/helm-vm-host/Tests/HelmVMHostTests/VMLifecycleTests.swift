import Foundation
import XCTest
@testable import HelmVMHostCore

final class VMLifecycleTests: XCTestCase {
    func testLifecycleLockRejectsASecondOwnerAndCanBeReacquired() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let lockURL = directory.appendingPathComponent(".helm-vm.lock")

        do {
            let first = try HelmVMLifecycleLock(url: lockURL)
            XCTAssertThrowsError(try HelmVMLifecycleLock(url: lockURL)) { error in
                XCTAssertEqual((error as? HostFailure)?.code, "vm_in_use")
            }
            withExtendedLifetime(first) {}
        }

        let second = try HelmVMLifecycleLock(url: lockURL)
        withExtendedLifetime(second) {}
    }
}
