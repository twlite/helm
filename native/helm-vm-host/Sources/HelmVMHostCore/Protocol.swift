import Foundation

struct HostCommand: Decodable {
    let id: JSONValue
    let method: String
    let params: JSONValue

    private enum CodingKeys: String, CodingKey {
        case id
        case method
        case params
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(JSONValue.self, forKey: .id) ?? .null
        method = try container.decode(String.self, forKey: .method)
        params = try container.decodeIfPresent(JSONValue.self, forKey: .params) ?? .object([:])
    }
}

struct GuestRequestEnvelope: Encodable {
    let id: JSONValue
    let method: String
    let params: JSONValue
}

struct HostErrorPayload: Encodable {
    let code: String
    let message: String
    let details: JSONValue?
}

struct HostResponse: Encodable {
    let type = "response"
    let id: JSONValue
    let ok: Bool
    let result: JSONValue?
    let error: HostErrorPayload?
}

struct LifecycleEvent: Encodable {
    let type = "event"
    let event = "vm.lifecycle"
    let sequence: UInt64
    let timestamp: String
    let state: String
    let reason: String
    let data: JSONValue
}

final class JSONLWriter {
    private let lock = NSLock()
    private let encoder: JSONEncoder

    init() {
        encoder = JSONEncoder()
        encoder.outputFormatting = []
    }

    func write<T: Encodable>(_ value: T) {
        lock.lock()
        defer { lock.unlock() }

        do {
            var data = try encoder.encode(value)
            data.append(0x0A)
            FileHandle.standardOutput.write(data)
        } catch {
            let message = "Unable to encode host response: \(error.localizedDescription)\n"
            if let data = message.data(using: .utf8) {
                FileHandle.standardError.write(data)
            }
        }
    }

    func response(id: JSONValue, result: JSONValue) {
        write(HostResponse(id: id, ok: true, result: result, error: nil))
    }

    func error(id: JSONValue, failure: HostFailure) {
        write(
            HostResponse(
                id: id,
                ok: false,
                result: nil,
                error: HostErrorPayload(
                    code: failure.code,
                    message: failure.message,
                    details: failure.details
                )
            )
        )
    }

    func lifecycle(
        sequence: UInt64,
        state: String,
        reason: String,
        data: JSONValue = .object([:])
    ) {
        let formatter = ISO8601DateFormatter()
        write(
            LifecycleEvent(
                sequence: sequence,
                timestamp: formatter.string(from: Date()),
                state: state,
                reason: reason,
                data: data
            )
        )
    }
}
