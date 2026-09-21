import Foundation
import Virtualization

public final class VMHost: NSObject, VZVirtualMachineDelegate {
    private let options: HostOptions
    private let paths: VMPaths
    private let writer: JSONLWriter
    private let vmQueue = DispatchQueue(label: "com.helm.vm-host.virtual-machine")
    private let eventLock = NSLock()
    private let errorLock = NSLock()

    private var virtualMachine: VZVirtualMachine?
    private var eventSequence: UInt64 = 0
    private var configurationValidated = false
    private var lastError: String?

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
        while let line = readLine() {
            handle(line: line)
        }

        if virtualMachine != nil {
            _ = try? stopVM(emitEvents: false)
        }
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
            writer.error(id: .null, code: failure.code, message: failure.message)
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
            setLastError(failure.message)
            writer.error(id: command.id, code: failure.code, message: failure.message)
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
            try start(newVM)
            setLastError(nil)
            emitLifecycle(state: "running", reason: "vm.start")
            return statusJSON()
        } catch {
            let failure = hostFailure(from: error)
            setLastError(failure.message)
            virtualMachine = nil
            emitLifecycle(
                state: "error",
                reason: "vm.start",
                data: .object([
                    "code": .string(failure.code),
                    "message": .string(failure.message)
                ])
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
            setLastError(failure.message)
            emitLifecycle(
                state: "error",
                reason: "vm.stop",
                data: .object([
                    "code": .string(failure.code),
                    "message": .string(failure.message)
                ])
            )
            throw failure
        }
    }

    private func resetVM() throws -> JSONValue {
        emitLifecycle(state: "resetting", reason: "vm.reset")

        do {
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
            setLastError(failure.message)
            emitLifecycle(
                state: "error",
                reason: "vm.reset",
                data: .object([
                    "code": .string(failure.code),
                    "message": .string(failure.message)
                ])
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
            "runtimeShareReadOnly": .boolean(true),
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
        return .string(lastError)
    }

    private func setLastError(_ value: String?) {
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
        setLastError(error.localizedDescription)
        emitLifecycle(
            state: "error",
            reason: "virtualMachineDidStopWithError",
            data: .object(["message": .string(error.localizedDescription)])
        )
    }
}
