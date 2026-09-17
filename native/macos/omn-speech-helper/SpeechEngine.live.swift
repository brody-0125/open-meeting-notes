import AVFoundation
import CoreMedia
import Foundation
import Speech

// Copied to SpeechEngine.swift before `swift build` on macOS 26+ hosts (see build-apple-stt-helper.mjs).
@available(macOS 26.0, *)
enum SpeechEngine {
  static func probe(locale identifier: String) -> Response {
    let locale = Locale(identifier: identifier)
    guard let speechLocale = SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      return .probe(available: false, installed: false, error: "locale not supported")
    }
    let installedIds = Set(SpeechTranscriber.installedLocales.map(\.identifier))
    let installed = installedIds.contains(speechLocale.identifier)
    return .probe(available: SpeechTranscriber.isAvailable, installed: installed,
      error: installed ? nil : "speech locale model not installed")
  }

  static func transcribe(pcm: Data, locale identifier: String, preset name: String, sampleRate: Int) throws -> [Chunk] {
    try AsyncSupport.run {
      try await transcribeAsync(pcm: pcm, localeIdentifier: identifier, presetName: name, sampleRate: sampleRate)
    }
  }

  private static func transcribeAsync(pcm: Data, localeIdentifier: String, presetName: String, sampleRate: Int) async throws -> [Chunk] {
    let locale = Locale(identifier: localeIdentifier)
    guard let speechLocale = SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
      throw NSError(domain: "omn.speech", code: 3, userInfo: [NSLocalizedDescriptionKey: "locale not supported"])
    }
    let preset: SpeechTranscriber.Preset = presetName == "offlineTranscription" ? .offlineTranscription : .transcription
    let transcriber = SpeechTranscriber(locale: speechLocale, preset: preset)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw NSError(domain: "omn.speech", code: 4, userInfo: [NSLocalizedDescriptionKey: "no compatible analyzer audio format"])
    }
    let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    try await analyzer.start(inputSequence: inputSequence)

    let reader = Task { () throws -> [Chunk] in
      var chunks: [Chunk] = []
      let duration = Double(pcm.count / MemoryLayout<Float>.size) / Double(sampleRate)
      for try await result in transcriber.results where result.isFinal {
        chunks.append(contentsOf: chunks(from: result.text, fallbackDuration: duration))
      }
      return chunks
    }

    let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate), channels: 1, interleaved: false)!
    let buffer = try makePCMBuffer(pcm: pcm, format: sourceFormat)
    let converter = AnalyzerInputConverter(analyzerFormat: analyzerFormat)
    for input in try converter.convert(buffer, at: nil) { inputBuilder.yield(input) }
    for input in try converter.flush() { inputBuilder.yield(input) }
    inputBuilder.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()

    let chunks = try await reader.value
    return chunks.isEmpty ? [] : chunks
  }

  private static func makePCMBuffer(pcm: Data, format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let frames = pcm.count / MemoryLayout<Float>.size
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
      throw NSError(domain: "omn.speech", code: 5, userInfo: [NSLocalizedDescriptionKey: "invalid pcm buffer"])
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    try pcm.withUnsafeBytes { raw in
      guard let base = raw.bindMemory(to: Float.self).baseAddress, let channel = buffer.floatChannelData?[0] else {
        throw NSError(domain: "omn.speech", code: 5, userInfo: [NSLocalizedDescriptionKey: "invalid pcm buffer"])
      }
      channel.update(from: base, count: frames)
    }
    return buffer
  }

  private static func chunks(from text: AttributedString, fallbackDuration: Double) -> [Chunk] {
    var chunks: [Chunk] = []
    for run in text.runs {
      let slice = String(text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !slice.isEmpty else { continue }
      if let time = run.audioTimeRange {
        let start = CMTimeGetSeconds(time.start)
        let end = start + CMTimeGetSeconds(time.duration)
        chunks.append(Chunk(text: slice, start: start, end: max(start, end)))
      }
    }
    if chunks.isEmpty {
      let plain = String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if !plain.isEmpty { chunks.append(Chunk(text: plain, start: 0, end: fallbackDuration)) }
    }
    return chunks
  }
}
