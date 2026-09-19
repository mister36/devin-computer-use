// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DevinComputerUse",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DevinComputerUseHelper",
            path: "Sources/DevinComputerUseHelper"
        )
    ]
)
