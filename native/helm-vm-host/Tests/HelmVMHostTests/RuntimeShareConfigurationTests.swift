import Foundation
import Virtualization
import XCTest
@testable import HelmVMHostCore

final class RuntimeShareConfigurationTests: XCTestCase {
    func testAppendsReadOnlyRuntimeShareWithoutReplacingExistingDevices() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("helm-runtime-share-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let existing = VZVirtioFileSystemDeviceConfiguration(tag: "existing-share")
        let configuration = VZVirtualMachineConfiguration()
        configuration.directorySharingDevices = [existing]

        let count = try HelmRuntimeShareConfiguration(
            directoryURL: directory,
            tag: HelmRuntimeShareConfiguration.defaultTag
        ).appendDevice(to: configuration)

        XCTAssertEqual(count, 2)
        XCTAssertEqual(configuration.directorySharingDevices.count, 2)
        XCTAssertTrue(configuration.directorySharingDevices[0] === existing)

        let runtimeDevice = try XCTUnwrap(
            configuration.directorySharingDevices[1] as? VZVirtioFileSystemDeviceConfiguration
        )
        XCTAssertEqual(runtimeDevice.tag, HelmRuntimeShareConfiguration.defaultTag)

        let runtimeShare = try XCTUnwrap(runtimeDevice.share as? VZSingleDirectoryShare)
        XCTAssertEqual(runtimeShare.directory.url.standardizedFileURL, directory.standardizedFileURL)
        XCTAssertTrue(runtimeShare.directory.isReadOnly)
    }

    func testMissingRuntimeShareIsRejectedBeforeConfiguration() throws {
        let missingDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("helm-missing-runtime-\(UUID().uuidString)", isDirectory: true)

        XCTAssertThrowsError(try HelmRuntimeShareConfiguration(
            directoryURL: missingDirectory,
            tag: HelmRuntimeShareConfiguration.defaultTag
        ).appendDevice(to: VZVirtualMachineConfiguration())) { error in
            XCTAssertEqual((error as? HostFailure)?.code, "missing_runtime_directory")
        }
    }
}
