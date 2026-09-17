import Foundation

enum SpeechBackend {
  static func probe(locale: String) -> Response {
    guard #available(macOS 26.0, *) else {
      return .probe(available: false, installed: false, error: "requires macOS 26 or later")
    }
    return SpeechEngine.probe(locale: locale)
  }

  static func transcribe(body: Data, locale: String, preset: String, sampleRate: Int, id: Int) -> Response {
    guard #available(macOS 26.0, *) else {
      return .failure(id: id, message: "requires macOS 26 or later")
    }
    guard body.count % 4 == 0 else { return .failure(id: id, message: "invalid pcm length") }
    if body.allSatisfy({ $0 == 0 }) { return .transcribe(id: id, chunks: []) }
    do {
      let chunks = try SpeechEngine.transcribe(pcm: body, locale: locale, preset: preset, sampleRate: sampleRate)
      return .transcribe(id: id, chunks: chunks)
    } catch {
      return .failure(id: id, message: String(describing: error))
    }
  }
}
