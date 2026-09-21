import Foundation

struct HostFailure: LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? {
        message
    }
}

func hostFailure(from error: Error) -> HostFailure {
    if let failure = error as? HostFailure {
        return failure
    }

    let nsError = error as NSError
    return HostFailure(
        code: "host_error",
        message: nsError.localizedDescription
    )
}
