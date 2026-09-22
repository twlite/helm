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

    private var virtualMachine: VZVirtualMachine?
    private var lifecycleLock: HelmVMLifecycleLock?
    private var eventSequence: UInt64 = 0
    private var configurationValidated = false
    private var lastError: HostFailure?
    private var viewerWindow: HelmVMViewerWindow?
    private var inputReader: VMHostInputReader?

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

    public func run() {
        if options.showWindow {
            runWithViewer()
            return
        }

        runHeadless()
    }

    private func runHeadless() {
        while let line = readLine() {
            handle(line: line)
        }

        if virtualMachine != nil {
            _ = try? stopVM(emitEvents: false)
        }
    }

    private func runWithViewer() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)

        let reader = VMHostInputReader(
            onLine: { [weak self] line in
                self?.handle(line: line)
            },
            onEnd: { [weak self] in
                DispatchQueue.main.async {
                    self?.stopViewerRunLoop()
                }
            }
        )
        inputReader = reader
        reader.start()

        application.run()

        reader.stop()
        inputReader = nil
        if virtualMachine != nil {
            _ = try? stopVM(emitEvents: false)
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
            let result: JSONValue
            switch command.method {
            case "vm.start":
                result = try startVM()
            case "vm.stop":
                result = try stopVM(emitEvents: true)
            case "vm.status":
                result = statusJSON()
            case "vm.reset":
                result = try resetVM()
            case "vm.guestRequest":
                result = try guestRequest(params: command.params)
            default:
                throw HostFailure(
                    code: "unknown_method",
                    message: "Unknown host method: \(command.method)"
                )
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
                break
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
        }

        configurationValidated = false
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
            emitLifecycle(state: "running", reason: "vm.start")
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            virtualMachine = nil
            emitLifecycle(
                state: "error",
                reason: "vm.start",
                data: failure.jsonValue
            )
            throw failure
        }
    }

    private func stopVM(emitEvents: Bool) throws -> JSONValue {
        guard let existingVM = virtualMachine else {
            return statusJSON()
        }

        let snapshot = vmQueue.sync {
            (state: existingVM.state, canStop: existingVM.canStop)
        }

        switch snapshot.state {
        case .stopped:
            return statusJSON()
        case .error:
            virtualMachine = nil
            return statusJSON()
        default:
            guard snapshot.canStop else {
                throw HostFailure(
                    code: "vm_not_stoppable",
                    message: "The VM cannot be stopped from the \(stateName(snapshot.state)) state."
                )
            }
        }

        if emitEvents {
            emitLifecycle(state: "stopping", reason: "vm.stop")
        }

        do {
            try stop(existingVM)
            if emitEvents {
                emitLifecycle(state: "stopped", reason: "vm.stop")
            }
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure)
            emitLifecycle(
                state: "error",
                reason: "vm.stop",
                data: failure.jsonValue
            )
            throw failure
        }
    }

    private func resetVM() throws -> JSONValue {
        emitLifecycle(state: "resetting", reason: "vm.reset")

        do {
            if lifecycleLock == nil {
                lifecycleLock = try HelmVMLifecycleLock(url: paths.stateLockURL)
            }
            if virtualMachine != nil {
                _ = try stopVM(emitEvents: true)
            }
            virtualMachine = nil
            configurationValidated = false
            try paths.prepareHostDirectories()
            try paths.resetWorkingState()
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
                    self?.stopViewerRunLoop()
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

    private func stop(_ virtualMachine: VZVirtualMachine) throws {
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
            throw HostFailure(code: "vm_stop_failed", message: "VM stop completed without a result.")
        }
        try stopResult.get()
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
            "lastError": lastErrorJSON()
        ]
        return .object(status)
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
        emitLifecycle(state: "stopped", reason: "guestDidStop")
    }

    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        let failure = hostFailure(from: error)
        setLastError(failure)
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
