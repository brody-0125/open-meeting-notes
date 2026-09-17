import Foundation

enum AsyncSupport {
  static func run<T>(_ body: @escaping () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let group = DispatchGroup()
    group.enter()
    Task {
      do { box.complete(with: try await body()) }
      catch { box.fail(error) }
      group.leave()
    }
    group.wait()
    return try box.value()
  }
}

private final class ResultBox<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<T, Error>?

  func complete(with value: T) {
    lock.lock()
    defer { lock.unlock() }
    result = .success(value)
  }

  func fail(_ error: Error) {
    lock.lock()
    defer { lock.unlock() }
    result = .failure(error)
  }

  func value() throws -> T {
    lock.lock()
    defer { lock.unlock() }
    guard let result else { throw NSError(domain: "omn.speech", code: 2, userInfo: [NSLocalizedDescriptionKey: "async runner lost result"]) }
    return try result.get()
  }
}
