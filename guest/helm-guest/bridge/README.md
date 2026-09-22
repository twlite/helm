# Helm guest transport bridge

The Swift host connects to the Linux guest through `VZVirtioSocketDevice`.
The prepared image runs `vsock-tcp-bridge` as a transparent boundary service
in front of helm-guest's loopback JSONL TCP listener:

```text
AF_VSOCK:4242 → 127.0.0.1:4242 → helm-guest
```

Build it inside the ARM64 Linux image with:

```sh
./build.sh
```

Run it before `helm-guest` becomes ready:

```sh
./vsock-tcp-bridge --vsock-port 4242 --tcp-host 127.0.0.1 --tcp-port 4242
```

The bridge forwards bytes only. It does not parse JSONL frames, translate
protocols, expose a shell, or access host paths. helm-guest listens only on
`127.0.0.1:4242`; each request and response is one UTF-8 JSON object followed
by `\n`. A systemd user service or XFCE autostart entry should start the bridge
and then the guest runtime after the graphical session is available.
