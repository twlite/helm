import Foundation

func resolveHelmPath(_ value: String) -> URL {
    let expanded: String
    if value == "~" {
        expanded = FileManager.default.homeDirectoryForCurrentUser.path
    } else if value.hasPrefix("~/") {
        expanded = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(String(value.dropFirst(2)))
            .path
    } else {
        expanded = value
    }

    if expanded.hasPrefix("/") {
        return URL(fileURLWithPath: expanded).standardizedFileURL
    }
    let currentDirectoryURL = URL(
        fileURLWithPath: FileManager.default.currentDirectoryPath,
        isDirectory: true
    )
    return URL(fileURLWithPath: expanded, relativeTo: currentDirectoryURL)
        .standardizedFileURL
}
