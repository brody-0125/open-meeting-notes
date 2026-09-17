import Foundation

// Default for macOS < 26 SDKs. build-apple-stt-helper.mjs replaces this file from SpeechEngine.live.swift on macOS 26+.
@available(macOS 26.0, *)
enum SpeechEngine {
  static func probe(locale: String) -> Response {
    guard #available(macOS 26.0, *) else {
      return .probe(available: false, installed: false, error: "requires macOS 26 or later")
    }
    return .probe(available: false, installed: false, error: "speech engine requires macOS 26 SDK build")
  }

  static func transcribe(pcm: Data, locale: String, preset: String, sampleRate: Int) throws -> [Chunk] {
    guard #available(macOS 26.0, *) else {
      throw NSError(domain: "omn.speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "requires macOS 26 or later"])
    }
    throw NSError(domain: "omn.speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "speech engine requires macOS 26 SDK build"])
  }
}
