# VM setup

The first VM target is Apple Silicon macOS with an ARM64 Linux raw disk image. The Swift helper uses Apple Virtualization.framework. It is deliberately separate from Helm's application logic and communicates with Bun over JSON Lines on stdin/stdout.

## Disk and runtime layout

Helm keeps runtime state under:

```text
~/Library/Application Support/Helm/
├── vm/
│   ├── base.img
│   ├── disk.img
│   └── efi-vars.bin
├── runtime/guest/helm-guest.js
└── helm.sqlite
```

The base image is never modified during a run. The working disk is the disk attached to the VM. Reset stops the VM, recreates the working disk from the base image, and leaves the base image unchanged.

The runtime directory is exposed read-only through VirtioFS at `/opt/helm-runtime`. Rebuilding the guest bundle therefore does not require rebuilding the disk image.

## Prepared guest

The prepared image should contain a `helm` user with automatic XFCE/X11 login, Chromium, a lightweight text editor, a lightweight file manager, Playwright dependencies, and the desktop utilities needed internally by semantic RPC methods. Build and install the small Linux-only bridge in [guest/helm-guest/bridge](../guest/helm-guest/bridge/README.md); it forwards AF_VSOCK port `4242` to the guest runtime's loopback HTTP port `4242`. Start the bridge and then `helm-guest` after the graphical session, retrying until `DISPLAY` and `XAUTHORITY` are usable.

## Build and diagnose

```sh
bun run guest:build
bun run vm:build
bun run vm:doctor
```

The diagnostic command checks the actual platform, helper path, image paths, EFI variables, and runtime bundle. Missing prerequisites are reported as missing; they are not treated as a successful VM check.

## VM devices

The helper configures a generic Linux platform with EFI boot, Virtio storage, Virtio graphics, keyboard, absolute pointing, NAT networking, entropy, optional memory ballooning, a read-only VirtioFS runtime share, and a Virtio socket device. The intended production path is Bun → JSONL Swift helper → Virtio socket → guest runtime. A localhost HTTP transport remains available for development and tests.
