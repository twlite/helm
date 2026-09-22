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

Provisioning exposes the same read-only runtime share as normal Helm runtime.
Ensure the host directory exists before starting the installer:

```sh
mkdir -p "$HOME/Library/Application Support/Helm/runtime"
```

Before the first image is sealed, `vm:doctor` may report `WAIT` for `base.img`,
`disk.img`, and `efi-vars.bin`. Those files are created by the workflow below;
their absence alone does not make doctor exit non-zero. `MISS` is reserved for
an actual blocking prerequisite such as an unsupported host, missing helper, or
missing virtualization entitlement.

Start the interactive installer with the path to the downloaded official ARM64
ISO:

```sh
bun run vm:provision --iso /path/to/ubuntu-24.04-arm64.iso
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

### Resume an interrupted installation

If the installer VM is stopped before Ubuntu installation is complete, resume
the existing provisioning disk without recreating it:

```sh
bun run vm:provision --resume
```

Resume requires both `vm/provisioning.img` and
`vm/provisioning-efi-vars.bin` to already exist. It reuses those files, the
persistent machine identifier, the runtime VirtioFS share, graphics, keyboard,
and pointer configuration. No storage preparation, formatting, truncation, or
installer ISO is performed. If installer media is needed again, attach it
explicitly:

```sh
bun run vm:provision --resume --iso /path/to/ubuntu-24.04-arm64.iso
```

Fresh provisioning refuses to overwrite an existing `provisioning.img` or EFI
store. Use `--force` with a fresh `--iso` command only when intentionally
discarding that provisioning state.

## Normal VM lifecycle

After sealing, start the normal Helm VM through the server or the convenience
commands:

```sh
bun run vm:doctor
bun run vm:start
bun run vm:start --gui
bun run vm:stop
```

Use `vm:start --gui` when debugging the agent loop. It launches the normal
working VM with the native `VZVirtualMachineView` window attached while the
server and JSONL guest path continue to operate normally. Plain `vm:start`
remains headless. If a helper is already running headlessly, stop it first so
Helm can relaunch it with the viewer enabled.

For maintenance work that only needs the native desktop viewer, start the
helper directly. This boots the working image and does not wait for
`helm-guest` or a guest RPC handshake:

```sh
bun run vm:maintenance
```

The helper still accepts JSONL commands on stdin, so `vm.status`, `vm.stop`,
`vm.reset`, and other host commands remain available in the terminal. Closing
the viewer stops the maintenance host cleanly; it does not replace or rewrite
the VM disk.

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

To remove the active, sealed, and provisioning VM state so Helm can be
provisioned from a fresh Ubuntu ISO, use the guarded deletion command:

```sh
bun run vm:delete
```

It refuses to run while the VM or native VM host is active, deletes only the
known VM state filenames, preserves manual backups and runtime files, and
requires typing `delete`. Use `bun run vm:delete -- --dry-run` to inspect the
plan or `bun run vm:delete -- --yes` for deliberate non-interactive use.

## Data layout

By default Helm keeps VM state under:

```text
~/Library/Application Support/Helm/
├── vm/
│   ├── base.img                       # sealed Ubuntu installation
│   ├── disk.img                       # mutable normal-run copy
│   ├── efi-vars.bin                   # lazily-created normal EFI state
│   ├── machine-id.bin                 # persistent provisioning/normal VM identity
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
AF_VSOCK port `4242` to the guest runtime's loopback JSONL TCP port `4242`.
Each request and response is one UTF-8 JSON object terminated by `\n`. Start
the bridge and then `helm-guest` after the graphical session, retrying until
`DISPLAY` and `XAUTHORITY` are usable.

The runtime directory is exposed read-only through VirtioFS at
`/opt/helm-runtime`. Rebuilding the guest bundle therefore does not require
rebuilding the disk image.

## Enable host clipboard sharing

The native VM configuration exposes Apple's SPICE clipboard channel in both
normal runtime and the graphical provisioning/maintenance viewers. Ubuntu also
needs its guest-side SPICE agent installed in the graphical session:

```sh
sudo apt update
sudo apt install spice-vdagent
```

Sign out and back in, or restart the guest, after installing it. The Ubuntu
package normally starts `spice-vdagent` through the desktop session. To check
that the agent is running as the logged-in desktop user:

```sh
pgrep -a spice-vdagent
```

After both sides are running, text and supported clipboard image data can be
copied between macOS and the Linux desktop while a `VZVirtualMachineView` is
open. This is desktop clipboard sharing, not file transfer; use the existing
shared runtime directory or guest filesystem tools for files.

## Install Playwright Chromium in the guest

`guest/helm-guest` keeps the Playwright Node package external to the bundled
runtime. The package and its browser binary must therefore be installed inside
Ubuntu. `bun run guest:build` only rebuilds the guest RPC bundle; it does not
download Chromium.

Open a terminal in the Ubuntu VM and run the browser install as the `helm`
user. Do not run the browser install as root, because Playwright will then put
the cache under `/root` instead of the runtime user's
`/home/helm/.cache/ms-playwright`:

```sh
sudo -iu helm
cd /home/helm
npx playwright install --with-deps chromium
```

If `npx` is not available, use Bun's runner instead:

```sh
sudo -iu helm
cd /home/helm
bunx --bun playwright install --with-deps chromium
```

If the guest does not yet have the external package in the directory from
which `helm-guest` starts, install the package first. Use the version resolved
by the current Helm lockfile rather than mixing a browser from a different
Playwright release:

```sh
sudo -iu helm
cd /home/helm
bun add playwright
bunx --bun playwright install --with-deps chromium
```

The `--with-deps` option may ask for `sudo` to install Ubuntu's Chromium
runtime libraries. Verify that the executable is now owned by `helm`:

```sh
find /home/helm/.cache/ms-playwright -path '*/chrome-linux-arm64/chrome' -type f -perm -111 -print
```

Restart `helm-guest` after installation. For the requested site, the browser
navigation target is `https://twlite.dev`.

## VM devices

Normal runtime configures a generic Linux platform with EFI boot, a writable
Virtio block disk, Virtio graphics, USB keyboard, absolute pointing, NAT
networking, entropy, a traditional memory balloon, a read-only VirtioFS runtime
share, a SPICE agent Virtio console for clipboard sharing, and a Virtio socket
device. Provisioning uses the same hardware where useful, replacing the normal
runtime disk with the fresh installation disk and adding the read-only USB
installer media required by Apple's GUI Linux installation pattern.
