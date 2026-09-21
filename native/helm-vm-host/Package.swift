// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "helm-vm-host",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "helm-vm-host",
            targets: ["HelmVMHost"]
        )
    ],
    targets: [
        .target(
            name: "HelmVMHostCore",
            path: "Sources/HelmVMHostCore"
        ),
        .executableTarget(
            name: "HelmVMHost",
            dependencies: ["HelmVMHostCore"],
            path: "Sources/HelmVMHost"
        ),
        .testTarget(
            name: "HelmVMHostTests",
            dependencies: ["HelmVMHostCore"],
            path: "Tests/HelmVMHostTests"
        )
    ]
)
