import AppKit
import Foundation
import Virtualization
import Darwin

public final class VMHost: NSObject, VZVirtualMachineDelegate {
    private let options: HostOptions
    private let paths: VMPaths
    private let writer: JSONLWriter
    private let vmQueue = DispatchQueue(label: "com.helm.vm-host.virtual-machine")
    private let eventLock = NSLock()
    private let errorLock = NSLock()
    private let operationLock = NSLock()
    private let shutdownStateLock = NSLock()

    private var virtualMachine: VZVirtualMachine?
    private var lifecycleLock: HelmVMLifecycleLock?
    private var eventSequence: UInt64 = 0
    private var configurationValidated = false
    private var lastError: HostFailure?
    private var viewerWindow: HelmVMViewerWindow?
    private var inputReader: VMHostInputReader?
    private var signalSources: [(number: Int32, source: DispatchSourceSignal)] = []
    private var headlessCompletion: DispatchSemaphore?
    private var acceptingOperations = true
    private var terminationRequested = false
    private var uncleanShutdownDetected = false

    public init(options: HostOptions) {
        self.options = options
        self.paths = VMPaths(
            rootURL: options.rootURL,
            baseImageURL: options.baseImageURL,
            workingImageURL: options.workingImageURL,
            efiVariablesURL: options.efiVariablesURL,
            machineIdentifierURL: options.machineIdentifierURL,
            runtimeShareURL: options.runtimeShareURL
        )
        self.writer = JSONLWriter()
        super.init()
    }

    static func requireStoppedForDiskMutation(state: VZVirtualMachine.State) throws {
        guard state == .stopped else {
            throw HostFailure(
                code: "vm_running",
                message: "VM is running. Shut it down before modifying disk images."
            )
        }
    }

    public func run() {
        installSignalHandlers()
        defer { removeSignalHandlers() }

        if options.showWindow {
            runWithViewer()
        } else {
            runHeadless()
        }
    }

    private func runHeadless() {
        let completion = DispatchSemaphore(value: 0)
        headlessCompletion = completion
        let reader = VMHostInputReader(
            onLine: { [weak self] line in
                self?.handle(line: line)
            },
            onEnd: { [weak self] in
                self?.handleInputEnd()
            }
        )
        inputReader = reader
        reader.start()
        completion.wait()
        reader.stop()
        inputReader = nil
        headlessCompletion = nil
    }

    private func runWithViewer() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)

        let reader = VMHostInputReader(
            onLine: { [weak self] line in
                self?.handle(line: line)
            },
            onEnd: { [weak self] in
                self?.handleInputEnd()
            }
        )
        inputReader = reader
        reader.start()

        application.run()

        reader.stop()
        inputReader = nil
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGINT, SIGTERM] {
            _ = Darwin.signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(
                signal: signalNumber,
                queue: DispatchQueue.global(qos: .userInitiated)
            )
            source.setEventHandler { [weak self] in
                self?.handleTerminationSignal(signalNumber)
            }
            source.resume()
            signalSources.append((number: signalNumber, source: source))
        }
    }

    private func removeSignalHandlers() {
        for entry in signalSources {
            entry.source.cancel()
            _ = Darwin.signal(entry.number, SIG_DFL)
        }
        signalSources.removeAll()
    }

    private func handleTerminationSignal(_ signalNumber: Int32) {
        beginTermination(reason: "signal \(signalNumber)")
    }

    private func handleInputEnd() {
        beginTermination(reason: "stdin closed")
    }

    private func beginTermination(reason: String) {
        shutdownStateLock.lock()
        if terminationRequested {
            shutdownStateLock.unlock()
            return
        }
        terminationRequested = true
        acceptingOperations = false
        shutdownStateLock.unlock()

        operationLock.lock()
        var shutdownConfirmed = virtualMachine == nil
        defer {
            operationLock.unlock()
            if shutdownConfirmed {
                headlessCompletion?.signal()
                if options.showWindow {
                    DispatchQueue.main.async { [weak self] in
                        self?.stopViewerRunLoop()
                    }
                }
            }
        }

        do {
            _ = try stopVM(emitEvents: true, reason: reason)
            shutdownConfirmed = true
        } catch {
            let failure = hostFailure(from: error)
            logDiagnostic("Graceful VM shutdown failed (\(reason)): \(failure.message)")
            do {
                _ = try forceStopVM(reason: reason)
                shutdownConfirmed = true
            } catch {
                let forceFailure = hostFailure(from: error)
                logDiagnostic("Emergency VM stop failed; the VM host could not confirm shutdown: \(forceFailure.message)")
            }
        }
    }

    private func stopViewerRunLoop() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?.stopViewerRunLoop()
            }
            return
        }
        NSApp.stop(nil)
    }

    private func handle(line: String) {
        let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLine.isEmpty else {
            return
        }

        let command: HostCommand
        do {
            guard let data = trimmedLine.data(using: .utf8) else {
                throw HostFailure(code: "invalid_json", message: "Input was not valid UTF-8.")
            }
            command = try JSONDecoder().decode(HostCommand.self, from: data)
        } catch {
            let failure = error as? HostFailure
                ?? HostFailure(code: "invalid_json", message: error.localizedDescription)
            writer.error(id: .null, failure: failure)
            return
        }

        do {
            let result: JSONValue = try withOperationLock {
                if !acceptsOperations && command.method != "vm.status" {
                    throw HostFailure(
                        code: "host_shutting_down",
                        message: "The VM host is shutting down and no new VM operations are accepted."
                    )
                }
                switch command.method {
                case "vm.start":
                    return try startVM()
                case "vm.stop":
                    return try stopVM(emitEvents: true, reason: "vm.stop")
                case "vm.force-stop":
                    return try forceStopVM(reason: "vm.force-stop")
                case "vm.status":
                    return statusJSON()
                case "vm.reset":
                    return try resetVM()
                case "vm.guestRequest":
                    return try guestRequest(params: command.params)
                default:
                    throw HostFailure(
                        code: "unknown_method",
                        message: "Unknown host method: \(command.method)"
                    )
                }
            }
            writer.response(id: command.id, result: result)
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            writer.error(id: command.id, failure: failure)
        }
    }

    private func startVM() throws -> JSONValue {
        if let existingVM = virtualMachine {
            let existingState = vmQueue.sync { existingVM.state }
            switch existingState {
            case .running:
                return statusJSON()
            case .stopped:
                // Drop the stopped framework object before reopening the
                // working image. This makes the ownership boundary explicit.
                virtualMachine = nil
            case .error:
                // A VM in the error state cannot be reused safely. The
                // framework requires the failed object to be discarded.
                virtualMachine = nil
            default:
                throw HostFailure(
                    code: "vm_busy",
                    message: "The VM is currently in the \(stateName(existingState)) state."
                )
            }
        }

        if lifecycleLock == nil {
            lifecycleLock = try HelmVMLifecycleLock(url: paths.stateLockURL)
            if let previousState = paths.previousLifecycleState(),
               ["running", "starting", "stopping", "force-stopping", "forced-stop", "error"].contains(previousState) {
                uncleanShutdownDetected = true
                logDiagnostic(
                    "Warning: previous VM shutdown was unclean (last lifecycle state: \(previousState)). "
                        + "The guest filesystem may need recovery."
                )
            }
        }

        configurationValidated = false
        try? paths.writeLifecycleMarker(state: "starting", clean: false, reason: "vm.start")
        emitLifecycle(state: "starting", reason: "vm.start")

        do {
            let configuration = try VMConfigurationBuilder(options: options, paths: paths)
                .makeConfiguration()
            configurationValidated = true
            emitLifecycle(state: "starting", reason: "configurationValidated")

            let newVM = VZVirtualMachine(configuration: configuration, queue: vmQueue)
            newVM.delegate = self
            virtualMachine = newVM
            showViewer(for: newVM)
            try start(newVM)
            setLastError(nil)
            try paths.writeLifecycleMarker(state: "running", clean: false, reason: "vm.start")
            emitLifecycle(state: "running", reason: "vm.start")
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            let currentState = virtualMachine.map { vm in
                vmQueue.sync { vm.state }
            }
            if virtualMachine != nil {
                try? paths.writeLifecycleMarker(state: "error", clean: false, reason: "vm.start")
            }
            if currentState == nil || currentState == .stopped || currentState == .error {
                virtualMachine = nil
                try? paths.writeLifecycleMarker(state: "stopped", clean: true, reason: "vm.start.failed")
            }
            emitLifecycle(
                state: "error",
                reason: "vm.start",
                data: failure.jsonValue
            )
            throw failure
        }
    }

    private func stopVM(
        emitEvents: Bool,
        reason: String
    ) throws -> JSONValue {
        guard let existingVM = virtualMachine else {
            return statusJSON()
        }

        let snapshot = vmQueue.sync {
            (
                state: existingVM.state,
                canRequestStop: existingVM.canRequestStop
            )
        }

        switch snapshot.state {
        case .stopped:
            markCleanStop(reason: reason)
            return statusJSON()
        case .error:
            throw HostFailure(
                code: "vm_not_stoppable",
                message: "The VM is in an error state and cannot be confirmed stopped safely."
            )
        case .stopping:
            guard waitUntilStopped(existingVM) else {
                throw HostFailure(
                    code: "vm_graceful_stop_timeout",
                    message: "The VM did not reach the stopped state within \(options.stopTimeoutMilliseconds) ms."
                )
            }
            markCleanStop(reason: reason)
            if emitEvents {
                emitLifecycle(state: "stopped", reason: reason)
            }
            return statusJSON()
        default:
            guard snapshot.canRequestStop else {
                throw HostFailure(
                    code: "vm_graceful_stop_unavailable",
                    message: "The VM cannot request a graceful guest shutdown from the \(stateName(snapshot.state)) state."
                )
            }
        }

        if emitEvents {
            emitLifecycle(state: "stopping", reason: reason)
        }

        do {
            try requestStop(existingVM)
            guard waitUntilStopped(existingVM) else {
                throw HostFailure(
                    code: "vm_graceful_stop_timeout",
                    message: "The VM did not reach the stopped state within \(options.stopTimeoutMilliseconds) ms."
                )
            }
            try paths.writeLifecycleMarker(state: "stopped", clean: true, reason: reason)
            if emitEvents {
                emitLifecycle(state: "stopped", reason: reason)
            }
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            emitLifecycle(
                state: "error",
                reason: reason,
                data: failure.jsonValue
            )
            throw failure
        }
    }

    private func forceStopVM(reason: String) throws -> JSONValue {
        guard let existingVM = virtualMachine else {
            return statusJSON()
        }

        let snapshot = vmQueue.sync {
            (state: existingVM.state, canStop: existingVM.canStop)
        }
        if snapshot.state == .stopped {
            markCleanStop(reason: reason)
            return statusJSON()
        }
        guard snapshot.canStop else {
            throw HostFailure(
                code: "vm_force_stop_unavailable",
                message: "The VM cannot be force-stopped from the \(stateName(snapshot.state)) state."
            )
        }

        logDiagnostic("Forcing VM termination after graceful shutdown was not confirmed.")
        emitLifecycle(state: "force-stopping", reason: reason)
        do {
            try forceStop(existingVM)
            guard waitUntilStopped(existingVM) else {
                throw HostFailure(
                    code: "vm_force_stop_timeout",
                    message: "The VM did not reach the stopped state after emergency termination."
                )
            }
            try paths.writeLifecycleMarker(state: "forced-stop", clean: false, reason: reason)
            uncleanShutdownDetected = true
            emitLifecycle(
                state: "stopped",
                reason: reason,
                data: .object(["forced": .boolean(true)])
            )
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            emitLifecycle(state: "error", reason: reason, data: failure.jsonValue)
            throw failure
        }
    }

    private func resetVM() throws -> JSONValue {
        do {
            if lifecycleLock == nil {
                lifecycleLock = try HelmVMLifecycleLock(url: paths.stateLockURL)
            }
            if let existingVM = virtualMachine {
                let state = vmQueue.sync { existingVM.state }
                try Self.requireStoppedForDiskMutation(state: state)
                // Release the stopped framework object before replacing the
                // working image so no native helper retains the attachment.
                virtualMachine = nil
            }
            emitLifecycle(state: "resetting", reason: "vm.reset")
            virtualMachine = nil
            configurationValidated = false
            try paths.prepareHostDirectories()
            try paths.resetWorkingState()
            try paths.writeLifecycleMarker(state: "stopped", clean: true, reason: "vm.reset")
            setLastError(nil)
            emitLifecycle(state: "stopped", reason: "vm.reset")
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            emitLifecycle(
                state: "error",
                reason: "vm.reset",
                data: failure.jsonValue
            )
            throw failure
        }
    }

    private func guestRequest(params: JSONValue) throws -> JSONValue {
        guard let object = params.objectValue,
              let method = object["method"]?.stringValue,
              !method.isEmpty else {
            throw HostFailure(
                code: "invalid_guest_request",
                message: "vm.guestRequest requires params.method."
            )
        }

        guard let existingVM = virtualMachine else {
            throw HostFailure(code: "vm_not_running", message: "Start the VM before making a guest request.")
        }

        let state = vmQueue.sync { existingVM.state }
        guard state == .running else {
            throw HostFailure(
                code: "vm_not_running",
                message: "Guest requests require a running VM; current state is \(stateName(state))."
            )
        }

        let requestID = object["id"] ?? .string(UUID().uuidString)
        let requestParams = object["params"] ?? .object([:])
        return try VirtioGuestTransport(
            virtualMachine: existingVM,
            virtualMachineQueue: vmQueue,
            guestPort: options.guestPort,
            timeoutMilliseconds: options.guestRequestTimeoutMilliseconds
        ).request(id: requestID, method: method, params: requestParams)
    }

    private func showViewer(for virtualMachine: VZVirtualMachine) {
        guard options.showWindow else { return }

        let attach = { [weak self] in
            guard let self else { return }
            if let viewerWindow {
                viewerWindow.attach(to: virtualMachine)
                viewerWindow.show()
                return
            }

            let newViewerWindow = HelmVMViewerWindow(
                title: "Helm VM Maintenance",
                width: self.options.displayWidth,
                height: self.options.displayHeight,
                virtualMachine: virtualMachine,
                onClose: { [weak self] in
                    self?.handleInputEnd()
                }
            )
            viewerWindow = newViewerWindow
            newViewerWindow.show()
        }

        if Thread.isMainThread {
            attach()
        } else {
            DispatchQueue.main.sync(execute: attach)
        }
    }

    private func start(_ virtualMachine: VZVirtualMachine) throws {
        let semaphore = DispatchSemaphore(value: 0)
        let result = BlockingResult<Void>()

        vmQueue.async {
            virtualMachine.start { startResult in
                result.resolve(startResult)
                semaphore.signal()
            }
        }

        semaphore.wait()
        guard let startResult = result.result() else {
            throw HostFailure(code: "vm_start_failed", message: "VM start completed without a result.")
        }
        try startResult.get()
    }

    private func requestStop(_ virtualMachine: VZVirtualMachine) throws {
        let semaphore = DispatchSemaphore(value: 0)
        let result = BlockingResult<Void>()

        vmQueue.async {
            do {
                try virtualMachine.requestStop()
                result.resolve(.success(()))
            } catch {
                result.resolve(.failure(error))
            }
            semaphore.signal()
        }

        semaphore.wait()
        guard let stopResult = result.result() else {
            throw HostFailure(code: "vm_graceful_stop_failed", message: "Graceful VM stop completed without a result.")
        }
        try stopResult.get()
    }

    private func forceStop(_ virtualMachine: VZVirtualMachine) throws {
        let semaphore = DispatchSemaphore(value: 0)
        let result = BlockingResult<Void>()

        vmQueue.async {
            virtualMachine.stop { error in
                if let error {
                    result.resolve(.failure(error))
                } else {
                    result.resolve(.success(()))
                }
                semaphore.signal()
            }
        }

        semaphore.wait()
        guard let stopResult = result.result() else {
            throw HostFailure(code: "vm_force_stop_failed", message: "Emergency VM stop completed without a result.")
        }
        try stopResult.get()
    }

    private func waitUntilStopped(_ virtualMachine: VZVirtualMachine) -> Bool {
        let deadline = Date().addingTimeInterval(TimeInterval(options.stopTimeoutMilliseconds) / 1000)
        while Date() < deadline {
            if vmQueue.sync(execute: { virtualMachine.state == .stopped }) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return vmQueue.sync { virtualMachine.state == .stopped }
    }

    private func statusJSON() -> JSONValue {
        let vmStatus: (state: String, canStart: Bool, canStop: Bool, canRequestStop: Bool)
        if let existingVM = virtualMachine {
            vmStatus = vmQueue.sync {
                (
                    stateName(existingVM.state),
                    existingVM.canStart,
                    existingVM.canStop,
                    existingVM.canRequestStop
                )
            }
        } else {
            let baseExists = FileManager.default.fileExists(atPath: paths.baseImageURL.path)
            vmStatus = (
                "stopped",
                VZVirtualMachine.isSupported && baseExists,
                false,
                false
            )
        }

        let status: [String: JSONValue] = [
            "state": .string(vmStatus.state),
            "supported": .boolean(VZVirtualMachine.isSupported),
            "appleSilicon": .boolean(isAppleSilicon),
            "configurationValidated": .boolean(configurationValidated),
            "canStart": .boolean(vmStatus.canStart),
            "canStop": .boolean(vmStatus.canStop),
            "canRequestStop": .boolean(vmStatus.canRequestStop),
            "baseImage": .object(paths.fileInfo(for: paths.baseImageURL)),
            "workingImage": .object(paths.fileInfo(for: paths.workingImageURL)),
            "efiVariables": .object(paths.fileInfo(for: paths.efiVariablesURL)),
            "machineIdentifier": .object(paths.fileInfo(for: paths.machineIdentifierURL)),
            "runtimeShare": .object(paths.fileInfo(for: paths.runtimeShareURL)),
            "runtimeShareReadOnly": .boolean(HelmRuntimeShareConfiguration.isReadOnly),
            "runtimeTag": .string(options.runtimeTag),
            "guestTransport": .string("virtio-socket"),
            "guestPort": .number(Double(options.guestPort)),
            "uncleanShutdownDetected": .boolean(uncleanShutdownDetected),
            "lastError": lastErrorJSON()
        ]
        return .object(status)
    }

    private var acceptsOperations: Bool {
        shutdownStateLock.lock()
        defer { shutdownStateLock.unlock() }
        return acceptingOperations
    }

    private func markCleanStop(reason: String) {
        // Preserve an explicit forced-stop marker until the next startup can
        // report it. A later SIGTERM used only to close an already-stopped
        // helper must not hide that recovery signal.
        guard paths.previousLifecycleState() != "forced-stop" else { return }
        try? paths.writeLifecycleMarker(state: "stopped", clean: true, reason: reason)
    }

    private func withOperationLock<T>(_ body: () throws -> T) rethrows -> T {
        operationLock.lock()
        defer { operationLock.unlock() }
        return try body()
    }

    private func logDiagnostic(_ message: String) {
        FileHandle.standardError.write(Data("helm-vm-host: \(message)\n".utf8))
    }

    private func lastErrorJSON() -> JSONValue {
        errorLock.lock()
        defer { errorLock.unlock() }
        guard let lastError else {
            return .null
        }
        return lastError.jsonValue
    }

    private func setLastError(_ value: HostFailure?) {
        errorLock.lock()
        lastError = value
        errorLock.unlock()
    }

    private func emitLifecycle(
        state: String,
        reason: String,
        data: JSONValue = .object([:])
    ) {
        eventLock.lock()
        eventSequence += 1
        let sequence = eventSequence
        eventLock.unlock()
        writer.lifecycle(sequence: sequence, state: state, reason: reason, data: data)
    }

    private func stateName(_ state: VZVirtualMachine.State) -> String {
        switch state {
        case .stopped:
            return "stopped"
        case .running:
            return "running"
        case .paused:
            return "paused"
        case .error:
            return "error"
        case .starting:
            return "starting"
        case .pausing:
            return "pausing"
        case .stopping:
            return "stopping"
        case .resuming:
            return "resuming"
        case .restoring:
            return "restoring"
        case .saving:
            return "saving"
        @unknown default:
            return "unknown"
        }
    }

    private var isAppleSilicon: Bool {
        #if arch(arm64)
        return true
        #else
        return false
        #endif
    }

    // MARK: VZVirtualMachineDelegate

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        markCleanStop(reason: "guestDidStop")
        emitLifecycle(state: "stopped", reason: "guestDidStop")
    }

    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        let failure = hostFailure(from: error)
        setLastError(failure)
        try? paths.writeLifecycleMarker(state: "error", clean: false, reason: "virtualMachineDidStopWithError")
        emitLifecycle(
            state: "error",
            reason: "virtualMachineDidStopWithError",
            data: failure.jsonValue
        )
    }
}

private final class VMHostInputReader {
    private let fileDescriptor: Int32
    private let queue = DispatchQueue(label: "com.helm.vm-host.stdin")
    private let onLine: (String) -> Void
    private let onEnd: () -> Void
    private var source: DispatchSourceRead?
    private var buffer = Data()
    private var finished = false

    init(onLine: @escaping (String) -> Void, onEnd: @escaping () -> Void) {
        self.fileDescriptor = FileHandle.standardInput.fileDescriptor
        self.onLine = onLine
        self.onEnd = onEnd
    }

    func start() {
        let newSource = DispatchSource.makeReadSource(
            fileDescriptor: fileDescriptor,
            queue: queue
        )
        source = newSource
        newSource.setEventHandler { [weak self] in
            self?.readAvailableData()
        }
        newSource.setCancelHandler {}
        newSource.resume()
    }

    func stop() {
        source?.cancel()
        source = nil
        queue.sync {}
    }

    private func readAvailableData() {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        let count = bytes.withUnsafeMutableBytes { buffer in
            Darwin.read(fileDescriptor, buffer.baseAddress, buffer.count)
        }

        if count > 0 {
            buffer.append(contentsOf: bytes[0..<count])
            drainLines()
            return
        }
        if count == 0 || errno != EINTR {
            finish()
        }
    }

    private func drainLines() {
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let endIndex = buffer.index(after: newlineIndex)
            let lineData = buffer[..<newlineIndex]
            buffer.removeSubrange(..<endIndex)
            onLine(String(decoding: lineData, as: UTF8.self))
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        drainLines()
        if !buffer.isEmpty {
            onLine(String(decoding: buffer, as: UTF8.self))
            buffer.removeAll(keepingCapacity: false)
        }
        onEnd()
        source?.cancel()
    }
}
