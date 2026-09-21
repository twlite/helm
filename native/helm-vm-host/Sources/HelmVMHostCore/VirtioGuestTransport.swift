import Foundation
import Virtualization
import Darwin

final class BlockingResult<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storedResult: Result<Value, Error>?

    func resolve(_ result: Result<Value, Error>) {
        lock.lock()
        storedResult = result
        lock.unlock()
    }

    func result() -> Result<Value, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return storedResult
    }
}

struct VirtioGuestTransport {
    let virtualMachine: VZVirtualMachine
    let virtualMachineQueue: DispatchQueue
    let guestPort: UInt32
    let timeoutMilliseconds: Int32

    func request(id: JSONValue, method: String, params: JSONValue) throws -> JSONValue {
        let connection = try connect()
        defer { connection.close() }

        let request = GuestRequestEnvelope(id: id, method: method, params: params)
        var requestData = try JSONEncoder().encode(request)
        requestData.append(0x0A)
        try writeAll(requestData, to: connection.fileDescriptor)

        let responseData = try readLine(from: connection.fileDescriptor)
        do {
            return try JSONDecoder().decode(JSONValue.self, from: responseData)
        } catch {
            throw HostFailure(
                code: "invalid_guest_response",
                message: "The guest returned invalid JSON: \(error.localizedDescription)"
            )
        }
    }

    private func connect() throws -> VZVirtioSocketConnection {
        let semaphore = DispatchSemaphore(value: 0)
        let result = BlockingResult<VZVirtioSocketConnection>()
        let queue = virtualMachineQueue

        queue.async {
            guard let socketDevice = virtualMachine.socketDevices
                .compactMap({ $0 as? VZVirtioSocketDevice })
                .first else {
                result.resolve(
                    .failure(
                        HostFailure(
                            code: "virtio_socket_unavailable",
                            message: "The VM did not expose a Virtio socket device."
                        )
                    )
                )
                semaphore.signal()
                return
            }

            socketDevice.connect(toPort: guestPort) { connectionResult in
                result.resolve(connectionResult)
                semaphore.signal()
            }
        }

        semaphore.wait()
        guard let connectionResult = result.result() else {
            throw HostFailure(
                code: "virtio_socket_error",
                message: "Virtio socket connection completed without a result."
            )
        }
        return try connectionResult.get()
    }

    private func writeAll(_ data: Data, to fileDescriptor: Int32) throws {
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes { buffer -> Int in
                guard let baseAddress = buffer.baseAddress else {
                    return 0
                }
                return Darwin.write(
                    fileDescriptor,
                    baseAddress.advanced(by: offset),
                    data.count - offset
                )
            }

            if count < 0 {
                if errno == EINTR {
                    continue
                }
                throw HostFailure(
                    code: "virtio_socket_write_failed",
                    message: "Unable to write to the guest socket: \(String(cString: strerror(errno)))"
                )
            }
            guard count > 0 else {
                throw HostFailure(
                    code: "virtio_socket_write_failed",
                    message: "The guest socket accepted zero bytes."
                )
            }
            offset += count
        }
    }

    private func readLine(from fileDescriptor: Int32) throws -> Data {
        let maximumResponseBytes = 16 * 1024 * 1024
        var response = Data()

        while response.count < maximumResponseBytes {
            var descriptor = pollfd(
                fd: fileDescriptor,
                events: Int16(POLLIN),
                revents: 0
            )
            let pollResult = Darwin.poll(&descriptor, 1, timeoutMilliseconds)
            if pollResult < 0 {
                if errno == EINTR {
                    continue
                }
                throw HostFailure(
                    code: "virtio_socket_read_failed",
                    message: "Unable to wait for the guest response: \(String(cString: strerror(errno)))"
                )
            }
            if pollResult == 0 {
                throw HostFailure(
                    code: "guest_request_timeout",
                    message: "The guest did not return a response within \(timeoutMilliseconds) ms."
                )
            }

            var byte: UInt8 = 0
            let count = Darwin.read(fileDescriptor, &byte, 1)
            if count < 0 {
                if errno == EINTR {
                    continue
                }
                throw HostFailure(
                    code: "virtio_socket_read_failed",
                    message: "Unable to read the guest response: \(String(cString: strerror(errno)))"
                )
            }
            if count == 0 {
                break
            }
            if byte == 0x0A {
                break
            }
            response.append(byte)
        }

        guard !response.isEmpty else {
            throw HostFailure(
                code: "empty_guest_response",
                message: "The guest closed the Virtio socket without returning a response."
            )
        }
        guard response.count < maximumResponseBytes else {
            throw HostFailure(
                code: "guest_response_too_large",
                message: "The guest response exceeded the 16 MiB limit."
            )
        }
        return response
    }
}
