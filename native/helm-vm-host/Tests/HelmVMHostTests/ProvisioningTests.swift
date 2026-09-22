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
        let runtimeURL = directory.appendingPathComponent("runtime", isDirectory: true)
        let installationURL = directory.appendingPathComponent("vm/provisioning.img")
        let efiURL = directory.appendingPathComponent("vm/provisioning-efi-vars.bin")
        let machineIDURL = directory.appendingPathComponent("vm/machine-id.bin")
        try Data("official ISO placeholder".utf8).write(to: isoURL)
        try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true)

        let options = try XCTUnwrap(
            ProvisioningOptions.parse(arguments: [
                "--installer-iso", isoURL.path,
                "--installation-image", installationURL.path,
                "--efi-vars", efiURL.path,
                "--machine-id", machineIDURL.path,
                "--runtime-share", runtimeURL.path,
                "--cpus", "2",
                "--memory-mib", "2048"
            ])
        )
        try options.prepareStorage()

        XCTAssertEqual(options.runtimeShareURL, runtimeURL)
        XCTAssertEqual(options.runtimeTag, HelmRuntimeShareConfiguration.defaultTag)
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
        let runtimeURL = directory.appendingPathComponent("runtime", isDirectory: true)
        let installationURL = directory.appendingPathComponent("provisioning.img")
        let efiURL = directory.appendingPathComponent("provisioning-efi-vars.bin")
        let machineIDURL = directory.appendingPathComponent("machine-id.bin")
        try Data("official ISO placeholder".utf8).write(to: isoURL)
        try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true)
        try Data("existing".utf8).write(to: installationURL)

        let options = try XCTUnwrap(
            ProvisioningOptions.parse(arguments: [
                isoURL.path,
                "--installation-image", installationURL.path,
                "--efi-vars", efiURL.path,
                "--machine-id", machineIDURL.path,
                "--runtime-share", runtimeURL.path
            ])
        )

        XCTAssertThrowsError(try options.prepareStorage()) { error in
            let failure = error as? HostFailure
            XCTAssertEqual(failure?.code, "resource_exists")
        }
    }

    func testResumeRequiresExistingDiskAndEFIAndDoesNotPrepareStorage() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("helm-provisioning-resume-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }

        let runtimeURL = directory.appendingPathComponent("runtime", isDirectory: true)
        let installationURL = directory.appendingPathComponent("provisioning.img")
        let efiURL = directory.appendingPathComponent("provisioning-efi-vars.bin")
        let machineIDURL = directory.appendingPathComponent("machine-id.bin")
        try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true)
        try Data("existing disk bytes".utf8).write(to: installationURL)
        try Data("existing EFI bytes".utf8).write(to: efiURL)

        let options = try XCTUnwrap(
            ProvisioningOptions.parse(arguments: [
                "--resume",
                "--installation-image", installationURL.path,
                "--efi-vars", efiURL.path,
                "--machine-id", machineIDURL.path,
                "--runtime-share", runtimeURL.path
            ])
        )

        XCTAssertTrue(options.resume)
        XCTAssertNil(options.installerISOURL)
        XCTAssertEqual(options.machineIdentifierURL, machineIDURL)

        XCTAssertThrowsError(try options.prepareStorage()) { error in
            XCTAssertEqual((error as? HostFailure)?.code, "invalid_argument")
        }
        XCTAssertEqual(try Data(contentsOf: installationURL), Data("existing disk bytes".utf8))
        XCTAssertEqual(try Data(contentsOf: efiURL), Data("existing EFI bytes".utf8))
    }

    func testResumeCanAttachAnExplicitInstallerISO() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("helm-provisioning-resume-iso-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }

        let isoURL = directory.appendingPathComponent("ubuntu-arm64.iso")
        let runtimeURL = directory.appendingPathComponent("runtime", isDirectory: true)
        let installationURL = directory.appendingPathComponent("provisioning.img")
        let efiURL = directory.appendingPathComponent("provisioning-efi-vars.bin")
        try Data("ISO".utf8).write(to: isoURL)
        try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true)
        try Data("disk".utf8).write(to: installationURL)
        try Data("efi".utf8).write(to: efiURL)

        let options = try XCTUnwrap(
            ProvisioningOptions.parse(arguments: [
                "--resume",
                "--iso", isoURL.path,
                "--installation-image", installationURL.path,
                "--efi-vars", efiURL.path,
                "--runtime-share", runtimeURL.path
            ])
        )

        XCTAssertEqual(options.installerISOURL, isoURL)
    }

    func testResumeFailsClearlyWhenProvisioningDiskIsMissing() throws {
        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("helm-provisioning-missing-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: directory) }

        let runtimeURL = directory.appendingPathComponent("runtime", isDirectory: true)
        let installationURL = directory.appendingPathComponent("provisioning.img")
        let efiURL = directory.appendingPathComponent("provisioning-efi-vars.bin")
        try fileManager.createDirectory(at: runtimeURL, withIntermediateDirectories: true)
        try Data("existing EFI bytes".utf8).write(to: efiURL)

        XCTAssertThrowsError(try ProvisioningOptions.parse(arguments: [
            "--resume",
            "--installation-image", installationURL.path,
            "--efi-vars", efiURL.path,
            "--runtime-share", runtimeURL.path
        ])) { error in
            let failure = error as? HostFailure
            XCTAssertEqual(failure?.code, "missing_resource")
            XCTAssertTrue(failure?.message.contains("existing provisioning disk") == true)
        }
    }
}
