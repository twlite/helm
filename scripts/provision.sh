#!/usr/bin/env bash
set -Eeuo pipefail

# Helm Linux guest provisioner
#
# Run as root from inside a fresh Ubuntu Server ARM64 guest:
#
#   sudo bash /opt/helm-runtime/provision-helm-guest.sh --reboot
#
# Assumptions:
#   - Apple Virtualization.framework exposes VirtioFS tag "helm-runtime"
#   - the intended desktop user already exists
#   - normally that user is "helm"
#   - /opt/helm-runtime/guest contains:
#       helm-guest.js
#       vsock-tcp-bridge.c
#
# The script is intended to be idempotent.

RUNTIME_TAG="helm-runtime"
RUNTIME_MOUNT="/opt/helm-runtime"
GUEST_PORT="4242"

REBOOT=0

if [[ "${1:-}" == "--reboot" ]]; then
  REBOOT=1
fi

# ---------------------------------------------------------------------------
# HARD SAFETY GUARD
#
# This script modifies the operating system substantially.
# Refuse to continue unless we are clearly inside the Helm Linux guest.
# ---------------------------------------------------------------------------

fail_host_guard() {
  echo >&2
  echo "============================================================" >&2
  echo " REFUSING TO PROVISION" >&2
  echo "============================================================" >&2
  echo "$1" >&2
  echo >&2
  echo "This script must only run inside the Helm Linux VM." >&2
  echo "No provisioning changes have been made." >&2
  echo >&2
  exit 100
}

OS="$(uname -s)"
ARCH="$(uname -m)"

[[ "${OS}" == "Linux" ]] || \
  fail_host_guard "Expected Linux, found: ${OS}"

case "${ARCH}" in
  aarch64|arm64)
    ;;
  *)
    fail_host_guard "Expected ARM64 Linux, found architecture: ${ARCH}"
    ;;
esac

# /proc must exist on the Linux guest.
[[ -r /proc/1/status ]] || \
  fail_host_guard "/proc is unavailable. This does not look like the Helm guest."

# Require the machine to report that it is virtualized when systemd can detect it.
if command -v systemd-detect-virt >/dev/null 2>&1; then
  if ! systemd-detect-virt --quiet; then
    fail_host_guard "systemd does not detect a virtual machine."
  fi

  VIRT_TYPE="$(systemd-detect-virt 2>/dev/null || true)"
  echo "Detected virtualization: ${VIRT_TYPE:-unknown}"
fi

# Root is needed from this point onward.
if [[ "${EUID}" -ne 0 ]]; then
  fail_host_guard "Run inside the VM using sudo."
fi

# The decisive Helm-specific check:
#
# A random Linux VM should not have a VirtioFS device named "helm-runtime".
mkdir -p "${RUNTIME_MOUNT}"

if ! mountpoint -q "${RUNTIME_MOUNT}"; then
  if ! mount -t virtiofs "${RUNTIME_TAG}" "${RUNTIME_MOUNT}" 2>/dev/null; then
    fail_host_guard \
      "Could not mount Helm VirtioFS tag '${RUNTIME_TAG}'. This is not a correctly configured Helm VM."
  fi
fi

# The share must contain Helm's actual runtime bundle.
if [[ ! -f "${RUNTIME_MOUNT}/guest/helm-guest.js" ]]; then
  fail_host_guard \
    "VirtioFS mounted, but Helm runtime marker guest/helm-guest.js is missing."
fi

echo
echo "Helm guest safety checks passed."
echo "OS:              ${OS}"
echo "Architecture:    ${ARCH}"
echo "Runtime share:   ${RUNTIME_MOUNT}"
echo

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run this script with sudo/root."
  exit 1
fi

# Determine the user Helm should run as.
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  HELM_USER="${SUDO_USER}"
elif id helm >/dev/null 2>&1; then
  HELM_USER="helm"
else
  echo "ERROR: Could not determine Helm desktop user."
  echo "Run with: sudo bash $0"
  echo "or create a user named 'helm'."
  exit 1
fi

HELM_HOME="$(getent passwd "${HELM_USER}" | cut -d: -f6)"

if [[ -z "${HELM_HOME}" || ! -d "${HELM_HOME}" ]]; then
  echo "ERROR: Home directory for ${HELM_USER} not found."
  exit 1
fi

echo
echo "======================================"
echo " Helm guest provisioning"
echo "======================================"
echo "User:        ${HELM_USER}"
echo "Home:        ${HELM_HOME}"
echo "Runtime tag: ${RUNTIME_TAG}"
echo "Runtime:     ${RUNTIME_MOUNT}"
echo "Guest port:  ${GUEST_PORT}"
echo

export DEBIAN_FRONTEND=noninteractive

echo "[1/12] Updating Ubuntu..."
apt-get update
apt-get upgrade -y

echo "[2/12] Installing desktop and agent dependencies..."

# Avoid an interactive display-manager chooser.
echo "lightdm shared/default-x-display-manager select lightdm" \
  | debconf-set-selections

apt-get install -y \
  xorg \
  xfce4 \
  xfce4-goodies \
  xfce4-terminal \
  lightdm \
  lightdm-gtk-greeter \
  dbus-x11 \
  thunar \
  mousepad \
  ristretto \
  xdotool \
  wmctrl \
  scrot \
  xclip \
  xserver-xorg-input-libinput \
  spice-vdagent \
  curl \
  ca-certificates \
  git \
  unzip \
  build-essential \
  pkg-config \
  jq \
  procps \
  iproute2

echo "[3/12] Configuring graphical boot..."

systemctl enable lightdm
systemctl set-default graphical.target

mkdir -p /etc/lightdm/lightdm.conf.d

cat > /etc/lightdm/lightdm.conf.d/50-helm.conf <<EOF
[Seat:*]
greeter-session=lightdm-gtk-greeter
user-session=xfce
autologin-user=${HELM_USER}
autologin-user-timeout=0
EOF

cat > "${HELM_HOME}/.dmrc" <<'EOF'
[Desktop]
Session=xfce
EOF

chown "${HELM_USER}:${HELM_USER}" "${HELM_HOME}/.dmrc"
chmod 0644 "${HELM_HOME}/.dmrc"

# Some LightDM/PAM configurations use these groups.
getent group autologin >/dev/null 2>&1 || groupadd autologin
usermod -aG autologin "${HELM_USER}"

getent group nopasswdlogin >/dev/null 2>&1 || groupadd nopasswdlogin
usermod -aG nopasswdlogin "${HELM_USER}"

echo "[4/12] Configuring Helm VirtioFS runtime..."

mkdir -p "${RUNTIME_MOUNT}"

if ! grep -Eq \
  "^${RUNTIME_TAG}[[:space:]]+${RUNTIME_MOUNT}[[:space:]]+virtiofs" \
  /etc/fstab; then
  echo "${RUNTIME_TAG} ${RUNTIME_MOUNT} virtiofs ro,nofail 0 0" \
    >> /etc/fstab
fi

if ! mountpoint -q "${RUNTIME_MOUNT}"; then
  if ! mount -t virtiofs "${RUNTIME_TAG}" "${RUNTIME_MOUNT}"; then
    echo
    echo "ERROR: Could not mount VirtioFS tag '${RUNTIME_TAG}'."
    echo
    echo "Make sure the VM host was started with the Helm runtime share:"
    echo
    echo "  ~/Library/Application Support/Helm/runtime"
    echo
    exit 1
  fi
fi

echo "VirtioFS mounted:"
mount | grep "${RUNTIME_MOUNT}" || true

echo "[5/12] Locating VSOCK bridge source..."

BRIDGE_SOURCE=""

for candidate in \
  "${RUNTIME_MOUNT}/guest/vsock-tcp-bridge.c" \
  "${RUNTIME_MOUNT}/guest/bridge/vsock-tcp-bridge.c"
do
  if [[ -f "${candidate}" ]]; then
    BRIDGE_SOURCE="${candidate}"
    break
  fi
done

if [[ -z "${BRIDGE_SOURCE}" ]]; then
  echo
  echo "ERROR: vsock-tcp-bridge.c is missing from the Helm runtime share."
  echo
  echo "Expected one of:"
  echo "  ${RUNTIME_MOUNT}/guest/vsock-tcp-bridge.c"
  echo "  ${RUNTIME_MOUNT}/guest/bridge/vsock-tcp-bridge.c"
  echo
  exit 1
fi

echo "[6/12] Building VSOCK bridge..."

cc \
  "${BRIDGE_SOURCE}" \
  -O2 \
  -Wall \
  -Wextra \
  -o /usr/local/bin/helm-vsock-bridge

chmod 0755 /usr/local/bin/helm-vsock-bridge

echo "[7/12] Installing Bun for ${HELM_USER}..."

if [[ ! -x "${HELM_HOME}/.bun/bin/bun" ]]; then
  runuser -u "${HELM_USER}" -- \
    bash -lc 'curl -fsSL https://bun.com/install | bash'
fi

if [[ ! -x "${HELM_HOME}/.bun/bin/bun" ]]; then
  echo "ERROR: Bun installation failed."
  exit 1
fi

echo "Bun version:"
runuser -u "${HELM_USER}" -- \
  "${HELM_HOME}/.bun/bin/bun" --version

echo "Installing playwright chromium for ${HELM_USER}..."
runuser -u "${HELM_USER}" -- \
  "${HELM_HOME}/.bun/bin/bunx" --bun playwright install --with-deps chromium

echo "[8/12] Creating Helm workspace..."

install \
  -d \
  -o "${HELM_USER}" \
  -g "${HELM_USER}" \
  "${HELM_HOME}/workspace"

install \
  -d \
  -o "${HELM_USER}" \
  -g "${HELM_USER}" \
  "${HELM_HOME}/fixtures"

install \
  -d \
  -o "${HELM_USER}" \
  -g "${HELM_USER}" \
  "${HELM_HOME}/.local/state/helm"

cat > "${HELM_HOME}/fixtures/demo.html" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Helm Demo</title>
</head>
<body>
  <main>
    <h1>Helm Demo Page</h1>
    <p>This page exists to test Helm browser automation.</p>
    <p>If Helm can read this text, save it into a file, and open that file,
       the basic computer-use loop is working.</p>
  </main>
</body>
</html>
EOF

chown "${HELM_USER}:${HELM_USER}" \
  "${HELM_HOME}/fixtures/demo.html"

echo "[9/12] Installing Helm guest launcher..."

cat > /usr/local/bin/start-helm-guest <<EOF
#!/usr/bin/env bash
set -u

RUNTIME="${RUNTIME_MOUNT}/guest"
BUN="${HELM_HOME}/.bun/bin/bun"
BRIDGE="/usr/local/bin/helm-vsock-bridge"
PORT="${GUEST_PORT}"

STATE_DIR="${HELM_HOME}/.local/state/helm"
GUEST_LOG="\${STATE_DIR}/guest.log"
BRIDGE_LOG="\${STATE_DIR}/bridge.log"

mkdir -p "\${STATE_DIR}"

# XFCE autostart should provide these. :0 is a reasonable fallback.
export DISPLAY="\${DISPLAY:-:0}"

# Avoid the agent desktop blanking itself during a run.
xset s off >/dev/null 2>&1 || true
xset -dpms >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true

# VirtioFS can become available slightly after the graphical login.
for _ in \$(seq 1 30); do
  if [[ -f "\${RUNTIME}/helm-guest.js" ]]; then
    break
  fi
  sleep 1
done

if [[ ! -f "\${RUNTIME}/helm-guest.js" ]]; then
  echo "helm-guest.js did not appear in \${RUNTIME}" >> "\${GUEST_LOG}"
  exit 1
fi

if [[ ! -x "\${BUN}" ]]; then
  echo "Bun not found at \${BUN}" >> "\${GUEST_LOG}"
  exit 1
fi

# Kill stale copies left by a restarted desktop session.
pkill -u "$(id -u)" -f '/helm-guest.js' >/dev/null 2>&1 || true
pkill -u "$(id -u)" -f 'helm-vsock-bridge' >/dev/null 2>&1 || true

sleep 1

# Start the Bun guest first so the VSOCK bridge does not accept a host
# connection before its TCP destination exists.
HELM_GUEST_PORT="\${PORT}" \
  "\${BUN}" "\${RUNTIME}/helm-guest.js" \
  >> "\${GUEST_LOG}" 2>&1 &

GUEST_PID=\$!

cleanup() {
  kill "\${GUEST_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Wait for localhost:4242.
READY=0

for _ in \$(seq 1 100); do
  if ss -ltn 2>/dev/null | grep -Eq "127\\.0\\.0\\.1:\${PORT}[[:space:]]"; then
    READY=1
    break
  fi

  if ! kill -0 "\${GUEST_PID}" >/dev/null 2>&1; then
    echo "helm-guest exited before becoming ready" >> "\${GUEST_LOG}"
    exit 1
  fi

  sleep 0.1
done

if [[ "\${READY}" != "1" ]]; then
  echo "helm-guest did not listen on TCP port \${PORT}" >> "\${GUEST_LOG}"
  exit 1
fi

echo "Starting VSOCK bridge on port \${PORT}" >> "\${BRIDGE_LOG}"

exec "\${BRIDGE}" \
  --vsock-port "\${PORT}" \
  --tcp-host 127.0.0.1 \
  --tcp-port "\${PORT}" \
  >> "\${BRIDGE_LOG}" 2>&1
EOF

chmod 0755 /usr/local/bin/start-helm-guest

echo "Configuring xfce4 config for ${HELM_USER}..."

install -d \
  -m 0700 \
  -o "${HELM_USER}" \
  -g "${HELM_USER}" \
  "${HELM_HOME}/.config" \
  "${HELM_HOME}/.config/xfce4" \
  "${HELM_HOME}/.config/xfce4/xfconf" \
  "${HELM_HOME}/.config/xfce4/xfconf/xfce-perchannel-xml" \
  "${HELM_HOME}/.local" \
  "${HELM_HOME}/.local/share" \
  "${HELM_HOME}/.cache"

echo "[10/12] Configuring XFCE autostart..."

AUTOSTART_DIR="${HELM_HOME}/.config/autostart"

install \
  -d \
  -o "${HELM_USER}" \
  -g "${HELM_USER}" \
  "${AUTOSTART_DIR}"

cat > "${AUTOSTART_DIR}/helm-guest.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Version=1.0
Name=Helm Guest Runtime
Comment=Start the Helm guest RPC runtime
Exec=/usr/local/bin/start-helm-guest
Terminal=false
Hidden=false
X-GNOME-Autostart-enabled=true
OnlyShowIn=XFCE;
EOF

chown "${HELM_USER}:${HELM_USER}" \
  "${AUTOSTART_DIR}/helm-guest.desktop"

echo "[11/12] Verifying provisioned state..."

FAILURES=0

check() {
  local description="$1"
  shift

  if "$@" >/dev/null 2>&1; then
    printf "OK    %s\n" "${description}"
  else
    printf "FAIL  %s\n" "${description}"
    FAILURES=$((FAILURES + 1))
  fi
}

check "XFCE installed" command -v startxfce4
check "LightDM installed" command -v lightdm
check "xdotool installed" command -v xdotool
check "wmctrl installed" command -v wmctrl
check "scrot installed" command -v scrot
check "Bun installed" test -x "${HELM_HOME}/.bun/bin/bun"
check "VirtioFS mounted" mountpoint -q "${RUNTIME_MOUNT}"
check "helm-guest bundle visible" \
  test -f "${RUNTIME_MOUNT}/guest/helm-guest.js"
check "VSOCK bridge installed" \
  test -x /usr/local/bin/helm-vsock-bridge
check "Helm autostart configured" \
  test -f "${AUTOSTART_DIR}/helm-guest.desktop"
check "workspace exists" \
  test -d "${HELM_HOME}/workspace"

echo
echo "[12/12] Provisioning complete."

if (( FAILURES > 0 )); then
  echo
  echo "WARNING: ${FAILURES} verification check(s) failed."
  echo "Do not seal this image yet."
  exit 1
fi

echo
echo "Guest is ready for a reboot."
echo
echo "After reboot verify:"
echo
echo "  ps aux | grep -E 'helm-guest|helm-vsock' | grep -v grep"
echo "  cat ~/.local/state/helm/guest.log"
echo "  cat ~/.local/state/helm/bridge.log"
echo
echo "Then power off cleanly and seal the image."

if (( REBOOT == 1 )); then
  echo
  echo "Rebooting in 3 seconds..."
  sleep 3
  reboot
fi