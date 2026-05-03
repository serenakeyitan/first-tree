// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FirstTreeTray",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "FirstTreeTray", targets: ["FirstTreeTray"])
    ],
    targets: [
        .executableTarget(
            name: "FirstTreeTray",
            path: "Sources/FirstTreeTray",
            resources: [
                .copy("Resources/FirstTreeIcon.png"),
                .copy("Resources/FirstTreeIcon@2x.png")
            ]
        )
    ]
)
