import Foundation
import XCTest
@testable import HelmVMHostCore

final class ProvisioningTests: XCTestCase {
    func testProvisioningCreatesFreshSparseInstallationDisk() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("helm-provisioning-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }

        let isoURL = directory.appendingPathComponent("ubuntu-arm64.iso")
        let installationURL = directory.appendingPathComponent("vm/provisioning.img")
        let efiURL = directory.appendingPathComponent("vm/provisioning-efi-vars.bin")
        try Data("official ISO placeholder".utf8).write(to: isoURL)

        let options = try XCTUnwrap(
            ProvisioningOptions.parse(arguments: [
                "--installer-iso", isoURL.path,
                "--installation-image", installationURL.path,
                "--efi-vars", efiURL.path,
                "--cpus", "2",
                "--memory-mib", "2048"
            ])
        )
        try options.prepareStorage()

        let attributes = try fileManager.attributesOfItem(atPath: installationURL.path)
        let size = try XCTUnwrap((attributes[.size] as? NSNumber)?.uint64Value)
        XCTAssertEqual(size, ProvisioningOptions.installationDiskSizeBytes)
        XCTAssertTrue(fileManager.fileExists(atPath: isoURL.path))
        XCTAssertFalse(fileManager.fileExists(atPath: efiURL.path))
    }

    func testProvisioningRefusesExistingDiskWithoutForce() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("helm-provisioning-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }

        let isoURL = directory.appendingPathComponent("ubuntu-arm64.iso")
        let installationURL = directory.appendingPathComponent("provisioning.img")
        let efiURL = directory.appendingPathComponent("provisioning-efi-vars.bin")
        try Data("official ISO placeholder".utf8).write(to: isoURL)
        try Data("existing".utf8).write(to: installationURL)

        let options = try XCTUnwrap(
            ProvisioningOptions.parse(arguments: [
                isoURL.path,
                "--installation-image", installationURL.path,
                "--efi-vars", efiURL.path
            ])
        )

        XCTAssertThrowsError(try options.prepareStorage()) { error in
            let failure = error as? HostFailure
            XCTAssertEqual(failure?.code, "resource_exists")
        }
    }
}
