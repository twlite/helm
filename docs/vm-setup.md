# VM setup

Helm runs its guest with Apple's `Virtualization.framework` on an Apple
Silicon Mac. Helm does not download an operating system image. The first-run
workflow accepts an official Ubuntu 24.04 LTS ARM64 installer ISO and opens a
native macOS VM window so the installation can be completed normally.

The provisioning contract is deliberately explicit: provide Ubuntu 24.04 LTS
for ARM64/aarch64. Helm validates that the path is a readable, non-empty file;
it does not try to infer the ISO architecture from its bytes.

## Host requirements

- Apple Silicon (`arm64`)
- macOS 14 or newer for normal VM runtime
- Swift/Command Line Tools with a matching macOS SDK
- A code-signed helper carrying `com.apple.security.virtualization`
- An official Ubuntu 24.04 LTS ARM64 installer ISO supplied by the user

No QEMU, Docker, or UTM process is used by either provisioning or normal VM
runtime.

## First-run provisioning

Build the native helper and inspect the host:

```sh
bun run vm:build
bun run vm:doctor
```

Before the first image is sealed, `vm:doctor` may report `WAIT` for `base.img`,
`disk.img`, and `efi-vars.bin`. Those files are created by the workflow below;
their absence alone does not make doctor exit non-zero. `MISS` is reserved for
an actual blocking prerequisite such as an unsupported host, missing helper, or
missing virtualization entitlement.

Start the interactive installer with the path to the downloaded official ARM64
ISO:

```sh
bun run vm:provision /path/to/ubuntu-24.04-arm64.iso
```

This command:

1. validates the ISO path and the Apple Silicon host;
2. creates Helm's VM directory;
3. creates a fresh sparse 24 GiB raw installation disk at
   `vm/provisioning.img`;
4. creates a fresh EFI variable store for this installer run;
5. attaches the writable disk as Virtio storage;
6. attaches the ISO read-only as USB mass storage; and
7. opens a native `VZVirtualMachineView` window with keyboard, pointer,
   graphics, NAT networking, entropy, and memory-balloon devices.

Complete the Ubuntu installation in that window and shut down the guest from
Ubuntu. The installation disk is retained when the VM stops. Close the window,
then promote the installed disk to Helm's immutable base image:

```sh
bun run vm:seal
```

`vm:seal` atomically copies `vm/provisioning.img` to `vm/base.img`, promotes
the provisioning EFI state to the normal EFI path so the installed boot entry
is retained, and keeps the provisioning disk as a recovery/source artifact. It
refuses to replace an existing base image or existing normal working state
unless explicitly asked:

```sh
bun run vm:seal --force
```

Use `--force` only when intentionally replacing the current base image. When
forced, Helm clears the existing normal working disk and machine identifier;
the promoted EFI state is retained for boot.

## Normal VM lifecycle

After sealing, start the normal Helm VM through the server or the convenience
commands:

```sh
bun run vm:doctor
bun run vm:start
bun run vm:stop
```

Normal initialization requires `base.img`. If `disk.img` is absent, the native
helper creates it by copying `base.img`. If `efi-vars.bin` is absent, the helper
creates a fresh EFI variable store automatically. A machine identifier is also
created lazily. No manual creation of `disk.img`, `efi-vars.bin`, or the
machine identifier is needed.

To discard the mutable guest state and return to the sealed base image:

```sh
bun run vm:reset
```

Reset stops the VM, recreates `disk.img` from `base.img`, and removes the
working machine identifier. It preserves the EFI variable store so the boot
entry captured during provisioning remains available; if the EFI store is
absent, the next start creates it automatically. Reset never modifies
`base.img`.

## Data layout

By default Helm keeps VM state under:

```text
~/Library/Application Support/Helm/
├── vm/
│   ├── base.img                       # sealed Ubuntu installation
│   ├── disk.img                       # mutable normal-run copy
│   ├── efi-vars.bin                   # lazily-created normal EFI state
│   ├── machine-id.bin                 # lazily-created normal VM identity
│   ├── provisioning.img               # interactive installer disk
│   ├── provisioning-efi-vars.bin      # provisioning-only EFI state
│   └── provisioning.lock              # transient while installer is open
├── runtime/guest/helm-guest.js
└── helm.sqlite
```

The provisioning EFI store is separate from normal runtime state. The
provisioning disk is not attached by normal Helm VM startup and can be retained
until the base image has been verified.

## Prepared guest expectations

The installed image should contain a `helm` user with automatic XFCE/X11
login, Chromium, a lightweight text editor, a lightweight file manager,
Playwright dependencies, and the desktop utilities needed by semantic RPC
methods. Build and install the small Linux-only bridge in
[guest/helm-guest/bridge](../guest/helm-guest/bridge/README.md); it forwards
AF_VSOCK port `4242` to the guest runtime's loopback HTTP port `4242`. Start the
bridge and then `helm-guest` after the graphical session, retrying until
`DISPLAY` and `XAUTHORITY` are usable.

The runtime directory is exposed read-only through VirtioFS at
`/opt/helm-runtime`. Rebuilding the guest bundle therefore does not require
rebuilding the disk image.

## VM devices

Normal runtime configures a generic Linux platform with EFI boot, a writable
Virtio block disk, Virtio graphics, USB keyboard, absolute pointing, NAT
networking, entropy, a traditional memory balloon, a read-only VirtioFS runtime
share, and a Virtio socket device. Provisioning uses the same hardware where
useful, replacing the normal runtime disk with the fresh installation disk and
adding the read-only USB installer media required by Apple's GUI Linux
installation pattern.
