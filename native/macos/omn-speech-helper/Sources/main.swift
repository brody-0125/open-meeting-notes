import Foundation

do {
  let (request, body) = try StdioProtocol.readRequest()
  switch request.op {
  case "probe":
    guard let locale = request.locale else {
      StdioProtocol.write(.failure(id: nil, message: "locale required"))
      exit(1)
    }
    StdioProtocol.write(SpeechBackend.probe(locale: locale))
  case "transcribe":
    guard let locale = request.locale, let bytes = request.bytes, body.count == bytes else {
      StdioProtocol.write(.failure(id: request.id, message: "invalid transcribe request"))
      exit(1)
    }
    let preset = request.preset ?? "offlineTranscription"
    let sampleRate = request.sampleRate ?? 16000
    StdioProtocol.write(SpeechBackend.transcribe(body: body, locale: locale, preset: preset, sampleRate: sampleRate, id: request.id ?? 1))
  default:
    StdioProtocol.write(.failure(id: request.id, message: "unknown op"))
    exit(1)
  }
} catch {
  StdioProtocol.write(.failure(id: nil, message: "protocol error"))
  exit(1)
}
