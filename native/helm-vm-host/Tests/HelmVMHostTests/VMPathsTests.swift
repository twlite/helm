import Foundation
import XCTest
@testable import HelmVMHostCore

final class VMPathsTests: XCTestCase {
    func testResetReplacesWorkingDiskWithoutRemovingMachineIdentity() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let vmDirectory = directory.appendingPathComponent("vm", isDirectory: true)
        let runtimeDirectory = directory.appendingPathComponent("runtime", isDirectory: true)
        try FileManager.default.createDirectory(at: vmDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
        let baseURL = vmDirectory.appendingPathComponent("base.img")
        let workingURL = vmDirectory.appendingPathComponent("disk.img")
        let efiURL = vmDirectory.appendingPathComponent("efi-vars.bin")
        let machineIDURL = vmDirectory.appendingPathComponent("machine-id.bin")
        try Data("sealed base".utf8).write(to: baseURL)
        try Data("stale working state".utf8).write(to: workingURL)
        try Data("persistent identity".utf8).write(to: machineIDURL)

        let paths = VMPaths(
            rootURL: directory,
            baseImageURL: baseURL,
            workingImageURL: workingURL,
            efiVariablesURL: efiURL,
            machineIdentifierURL: machineIDURL,
            runtimeShareURL: runtimeDirectory
        )
        try paths.resetWorkingState()

        XCTAssertEqual(try Data(contentsOf: workingURL), Data("sealed base".utf8))
        XCTAssertEqual(try Data(contentsOf: machineIDURL), Data("persistent identity".utf8))
    }
}
