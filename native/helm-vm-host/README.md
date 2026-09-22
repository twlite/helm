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
traditional Virtio memory ballooning, a read-only VirtioFS runtime share, a
SPICE agent Virtio console for clipboard sharing, and one Virtio socket device.
The configuration is passed through
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
│   ├── machine-id.bin    # persistent provisioning/normal VM identifier
│   ├── provisioning.img  # interactive installer disk
│   ├── provisioning-efi-vars.bin
│   ├── provisioning.lock # transient; owned by bun run vm:provision
│   ├── .helm-vm.lock     # native lifecycle lock
│   └── .helm-vm-lifecycle.json # last lifecycle state / clean-stop marker
└── runtime/              # shared into the guest read-only
```

`base.img` must exist before `vm.start` or `vm.reset`. The repository-level
`bun run vm:provision --iso /path/to/ubuntu-24.04-arm64.iso` command creates a
separate sparse 24 GiB installation disk, a fresh provisioning EFI store, and
an AppKit window containing `VZVirtualMachineView`. The ISO is attached
read-only through `VZUSBMassStorageDeviceConfiguration`; the writable disk is
attached through Virtio. After the interactive installation shuts down, run
`bun run vm:seal` to atomically copy the retained installation disk to
`base.img` and promote the provisioning EFI state to the normal EFI path.

If the installer VM is stopped before installation completes, resume it with
`bun run vm:provision --resume`. Resume requires the existing provisioning disk
and EFI store, never recreates or truncates them, and may optionally receive
`--iso /path/to/ubuntu-24.04-arm64.iso` to attach installer media again. Fresh
provisioning refuses existing provisioning state unless `--force` is supplied.

If `disk.img` is missing, the normal host copies `base.img` to it. If
`efi-vars.bin` is missing, the normal host creates it with
`VZEFIVariableStore(creatingVariableStoreAt:options:)`. `vm.reset` is
refused while the VM is running. Stop the VM first; after the framework reports
`stopped`, the host releases its framework object and replaces the working
image from the base image. The paired generic machine identifier and EFI boot
state are preserved. It never writes to `base.img`. The native host takes an
exclusive lifecycle lock for the duration of each VM owner process, so two
`helm-vm-host` processes cannot open the same working image concurrently.

If the framework reports an invalid boot loader, use the explicit repository
command `bun run vm:repair-efi`. It preserves the existing EFI file as a
`.bak` backup and replaces only the EFI variable store; it never modifies a
guest disk. Normal startup creates a missing EFI store lazily, but it never
recreates an existing store.

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
starting `helm-guest` after its graphical session is ready. For host clipboard
support, install Ubuntu's `spice-vdagent` package and run it in the logged-in
graphical session. See `docs/vm-setup.md` for the guest setup command.

## JSON Lines protocol

One JSON object is read from stdin per line. Responses and lifecycle events are
one JSON object per line on stdout; human diagnostics belong on stderr.

Commands:

```json
{"id":"1","method":"vm.status","params":{}}
{"id":"2","method":"vm.start","params":{}}
{"id":"3","method":"vm.guestRequest","params":{"method":"desktop.screenshot","params":{}}}
{"id":"4","method":"vm.stop","params":{}}
{"id":"5","method":"vm.force-stop","params":{}}
{"id":"6","method":"vm.reset","params":{}}
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
stopping, force-stopping, stopped, reset, and errors. `vm.stop` requests a
graceful guest shutdown and waits for the confirmed `stopped` state. It never
calls the hard-stop API. `vm.force-stop` is the explicit emergency path.
`vm.guestRequest` opens a connection to the configured guest AF_VSOCK port,
sends one JSON line, reads one JSON line, and returns the guest JSON unchanged.

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
- `vm.stop` requests a graceful guest shutdown through
  `VZVirtualMachine.requestStop()`, waits up to the configured stop timeout,
  and only returns after `VZVirtualMachine.State.stopped` is observed. A host
  signal or stdin close follows the same graceful path and uses hard stop only
  as a logged last resort.
- A lifecycle marker warns on the next startup when the previous host ended
  while the VM was still in a running, error, or forced state.
- Real start/stop/guest-RPC integration needs a valid image, the entitlement,
  and a prepared guest with the bridge and runtime listening on the configured
  port. Protocol and path behavior can be checked without those resources.

The implementation follows Apple's current Virtualization.framework APIs for
`VZVirtualMachineConfiguration`, `VZVirtioFileSystemDeviceConfiguration`, and
`VZVirtioSocketDevice`.
