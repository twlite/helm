# Helm VM host

`helm-vm-host` is the native macOS slice of Helm. It owns only the
`Virtualization.framework` VM and exposes a small JSON Lines control protocol.
Helm business logic, task state, tools, and guest behavior stay outside this
package.

## Requirements

- Apple Silicon Mac (`arm64`)
- macOS 14 or newer
- Swift/Xcode toolchain with the matching macOS SDK
- An official Ubuntu 24.04 LTS ARM64 installer ISO for first-run provisioning
- A code-signed helper carrying
  `com.apple.security.virtualization`

The host configures a generic EFI Linux VM with Virtio block storage, Virtio
graphics, USB keyboard, absolute USB pointing, NAT networking, entropy,
traditional Virtio memory ballooning, a read-only VirtioFS runtime share, and
one Virtio socket device. The configuration is passed through
`VZVirtualMachineConfiguration.validate()` before a VM object is created.

## Build and sign

From this directory:

```sh
./Scripts/build.sh
SIGN=1 ./Scripts/build.sh
```

`SIGN=1` uses ad-hoc signing by default. Set `CODE_SIGN_IDENTITY` when a
different local signing identity is required. The unsigned binary is useful for
protocol checks, but Virtualization.framework will reject it when the
entitlement is required.

The Command Line Tools and compiler must use the same SDK/toolchain version.

## Host paths

The default root is:

```text
~/Library/Application Support/Helm/
├── vm/
│   ├── base.img          # sealed Ubuntu installation, never modified by host
│   ├── disk.img          # mutable working copy
│   ├── efi-vars.bin      # EFI variable store
│   ├── machine-id.bin    # persistent generic VM identifier
│   ├── provisioning.img  # interactive installer disk
│   ├── provisioning-efi-vars.bin
│   └── provisioning.lock # transient; owned by bun run vm:provision
└── runtime/              # shared into the guest read-only
```

`base.img` must exist before `vm.start` or `vm.reset`. The repository-level
`bun run vm:provision /path/to/ubuntu-24.04-arm64.iso` command creates a
separate sparse 24 GiB installation disk, a fresh provisioning EFI store, and
an AppKit window containing `VZVirtualMachineView`. The ISO is attached
read-only through `VZUSBMassStorageDeviceConfiguration`; the writable disk is
attached through Virtio. After the interactive installation shuts down, run
`bun run vm:seal` to atomically copy the retained installation disk to
`base.img` and promote the provisioning EFI state to the normal EFI path.

If `disk.img` is missing, the normal host copies `base.img` to it. If
`efi-vars.bin` is missing, the normal host creates it with
`VZEFIVariableStore(creatingVariableStoreAt:options:)`. `vm.reset` stops the
VM, replaces the working image from the base image, preserves the EFI boot
state, and clears the generic machine identifier. It never writes to
`base.img`.

Override paths with the command-line options shown by `--help`, or with the
corresponding `HELM_VM_*` environment variables. The runtime VirtioFS tag is
`helm-runtime`, and the guest mount point expected by the plan is
`/opt/helm-runtime`:

```sh
sudo mkdir -p /opt/helm-runtime
sudo mount -t virtiofs helm-runtime /opt/helm-runtime
```

The prepared guest image remains responsible for mounting the share at boot,
starting the AF_VSOCK-to-loopback bridge from `guest/helm-guest/bridge`, and
starting `helm-guest` after its graphical session is ready.

## JSON Lines protocol

One JSON object is read from stdin per line. Responses and lifecycle events are
one JSON object per line on stdout; human diagnostics belong on stderr.

Commands:

```json
{"id":"1","method":"vm.status","params":{}}
{"id":"2","method":"vm.start","params":{}}
{"id":"3","method":"vm.guestRequest","params":{"method":"desktop.screenshot","params":{}}}
{"id":"4","method":"vm.stop","params":{}}
{"id":"5","method":"vm.reset","params":{}}
```

Successful responses use:

```json
{"type":"response","id":"1","ok":true,"result":{}}
```

Failures use a structured code and message:

```json
{"type":"response","id":"1","ok":false,"error":{"code":"missing_resource","message":"..."}}
```

Lifecycle events use `type: "event"`, `event: "vm.lifecycle"`, a monotonic
sequence number, an ISO-8601 timestamp, a state, a reason, and structured
data. The host emits events for start, validated configuration, running,
stopping, stopped, reset, and errors. `vm.guestRequest` opens a connection to
the configured guest AF_VSOCK port, sends one JSON line, reads one JSON line,
and returns the guest JSON unchanged.

## Limitations

- This first host slice supports Apple Silicon only; it does not boot x86
  guests or Windows.
- Provisioning is intentionally manual: Helm does not download an OS image or
  automate the Ubuntu installer. The user must supply the official ARM64 ISO
  and complete the native VM window. The VirtioFS mount setup, XFCE/X11
  session, AF_VSOCK bridge, and guest runtime remain guest-image concerns.
- It does not contain a runtime screenshot pipeline, guest RPC business logic,
  Bun controller, or automatic display-readiness retry loop; the only native
  viewer is the manual provisioning window.
- `vm.stop` is the framework's destructive stop operation. The host does not
  currently request a graceful guest shutdown.
- Real start/stop/guest-RPC integration needs a valid image, the entitlement,
  and a prepared guest with the bridge and runtime listening on the configured
  port. Protocol and path behavior can be checked without those resources.

The implementation follows Apple's current Virtualization.framework APIs for
`VZVirtualMachineConfiguration`, `VZVirtioFileSystemDeviceConfiguration`, and
`VZVirtioSocketDevice`.
