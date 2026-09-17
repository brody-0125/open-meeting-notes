import Foundation

struct Request: Decodable {
  let op: String
  let locale: String?
  let preset: String?
  let id: Int?
  let sampleRate: Int?
  let bytes: Int?
}

struct Chunk: Encodable {
  let text: String
  let start: Double
  let end: Double
}

struct Response: Encodable {
  let id: Int?
  let ok: Bool
  let available: Bool?
  let installed: Bool?
  let chunks: [Chunk]?
  let error: String?

  static func probe(available: Bool, installed: Bool, error: String? = nil) -> Response {
    Response(id: nil, ok: true, available: available, installed: installed, chunks: nil, error: error)
  }

  static func transcribe(id: Int, chunks: [Chunk]) -> Response {
    Response(id: id, ok: true, available: nil, installed: nil, chunks: chunks, error: nil)
  }

  static func failure(id: Int?, message: String) -> Response {
    Response(id: id, ok: false, available: nil, installed: nil, chunks: nil, error: message)
  }
}

enum StdioProtocol {
  static func readRequest() throws -> (Request, Data) {
    let stdin = FileHandle.standardInput
    let all = stdin.readDataToEndOfFile()
    guard let newline = all.firstIndex(of: 0x0A) else { throw ProtocolError.malformed }
    let header = all[..<newline]
    let body = all[(newline + 1)...]
    let request = try JSONDecoder().decode(Request.self, from: Data(header))
    return (request, Data(body))
  }

  static func write(_ response: Response) {
    let data = try! JSONEncoder().encode(response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
}

enum ProtocolError: Error {
  case malformed
  case bodySize
}
