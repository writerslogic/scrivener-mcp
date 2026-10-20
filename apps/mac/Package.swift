// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ScrivenerMCP",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ScrivenerMCP", targets: ["ScrivenerMCP"]),
    ],
    targets: [
        .target(name: "ScrivenerMCPCore", path: "Sources/Core"),
        .executableTarget(
            name: "ScrivenerMCP",
            dependencies: ["ScrivenerMCPCore"],
            path: "Sources/App"
        ),
        .testTarget(
            name: "ScrivenerMCPCoreTests",
            dependencies: ["ScrivenerMCPCore"],
            path: "Tests/CoreTests"
        ),
    ]
)
