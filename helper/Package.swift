// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DevinComputerUse",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "DevinComputerUseCore",
            path: "Sources/DevinComputerUseCore"
        ),
        .executableTarget(
            name: "DevinComputerUseHelper",
            dependencies: ["DevinComputerUseCore"],
            path: "Sources/DevinComputerUseHelper"
        ),
        .testTarget(
            name: "DevinComputerUseCoreTests",
            dependencies: ["DevinComputerUseCore"],
            path: "Tests/DevinComputerUseCoreTests"
        ),
    ]
)
