// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BtHidBridge",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "BtHidBridge",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("IOBluetooth"),
                .linkedFramework("IOBluetoothUI"),
                .linkedFramework("CoreBluetooth")
            ]
        )
    ]
)
