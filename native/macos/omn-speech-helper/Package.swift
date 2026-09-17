// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "omn-speech-helper",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "omn-speech-helper", targets: ["omnSpeechHelper"])
  ],
  targets: [
    .executableTarget(
      name: "omnSpeechHelper",
      path: "Sources",
      linkerSettings: [
        .linkedFramework("AVFoundation"),
        .linkedFramework("Speech")
      ]
    )
  ]
)
