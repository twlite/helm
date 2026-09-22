import Foundation
import CoreFoundation

struct HostFailure: LocalizedError {
    let code: String
    let message: String
    let details: JSONValue?

    init(code: String, message: String, details: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }

    var errorDescription: String? {
        message
    }

    var jsonValue: JSONValue {
        var value: [String: JSONValue] = [
            "code": .string(code),
            "message": .string(message),
        ]
        if let details {
            value["details"] = details
        }
        return .object(value)
    }
}

func hostFailure(from error: Error) -> HostFailure {
    if let failure = error as? HostFailure {
        return failure
    }

    let nsError = error as NSError
    return HostFailure(
        code: "host_error",
        message: nsError.localizedDescription,
        details: errorDetails(for: nsError)
    )
}

/// Encode a host error for the executable target without exposing the
/// internal JSONValue/HostFailure implementation across the target boundary.
public func encodedHostFailure(from error: Error) -> String {
    let failure = hostFailure(from: error)
    return (try? JSONEncoder().encode(failure.jsonValue))
        .flatMap { String(data: $0, encoding: .utf8) }
        ?? failure.message
}

/// Preserve the NSError information that Virtualization.framework often puts
/// on the underlying error. In particular, VZ errors commonly use a generic
/// top-level message and put the useful device/boot-loader detail in the
/// failure reason or underlying error chain.
private func errorDetails(for error: NSError, depth: Int = 0) -> JSONValue {
    var details: [String: JSONValue] = [
        "domain": .string(error.domain),
        "code": .number(Double(error.code)),
        "localizedDescription": .string(error.localizedDescription),
        "userInfo": jsonValue(from: error.userInfo, depth: depth + 1),
    ]

    if let failureReason = error.localizedFailureReason {
        details["failureReason"] = .string(failureReason)
    }
    if let recoverySuggestion = error.localizedRecoverySuggestion {
        details["recoverySuggestion"] = .string(recoverySuggestion)
    }
    if let debugDescription = error.userInfo[NSDebugDescriptionErrorKey] {
        details["debugDescription"] = jsonValue(from: debugDescription, depth: depth + 1)
    }
    if let underlyingError = error.userInfo[NSUnderlyingErrorKey] as? NSError, depth < 4 {
        details["underlyingError"] = errorDetails(for: underlyingError, depth: depth + 1)
    }

    return .object(details)
}

private func jsonValue(from value: Any, depth: Int) -> JSONValue {
    guard depth <= 5 else {
        return .string(String(describing: value))
    }

    if value is NSNull {
        return .null
    }
    if let string = value as? String {
        return .string(string)
    }
    if let url = value as? URL {
        return .string(url.absoluteString)
    }
    if let error = value as? NSError {
        return errorDetails(for: error, depth: depth)
    }
    if let array = value as? [Any] {
        return .array(array.map { jsonValue(from: $0, depth: depth + 1) })
    }
    if let dictionary = value as? [AnyHashable: Any] {
        var object: [String: JSONValue] = [:]
        for (key, entry) in dictionary {
            object[String(describing: key)] = jsonValue(from: entry, depth: depth + 1)
        }
        return .object(object)
    }
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return .boolean(number.boolValue)
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite else {
            return .string(number.stringValue)
        }
        return .number(doubleValue)
    }

    return .string(String(describing: value))
}
