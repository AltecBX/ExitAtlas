// swift-tools-version:5.9
import PackageDescription

// ExitAtlasCore is the platform independent route, state and exit engine.
// It has no Apple framework dependencies so it builds and tests on macOS, iOS and Linux.
// The iOS app (App/) links this package and adds MapKit, Core Location and SwiftUI.
let package = Package(
    name: "ExitAtlas",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ExitAtlasCore", targets: ["ExitAtlasCore"]),
    ],
    targets: [
        .target(name: "ExitAtlasCore", path: "Sources/ExitAtlasCore"),
        .testTarget(
            name: "ExitAtlasCoreTests",
            dependencies: ["ExitAtlasCore"],
            path: "Tests/ExitAtlasCoreTests",
            exclude: ["Fixtures"]
        ),
    ]
)
