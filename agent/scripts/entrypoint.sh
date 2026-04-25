#!/bin/bash
set -euo pipefail

export DISPLAY=:${DISPLAY_NUM:-99}
export HOME=/home/agent
export XDG_RUNTIME_DIR=/tmp/runtime-agent
export TERMINAL=lxterminal

create_desktop_assets() {
  mkdir -p "$HOME/Desktop" "$HOME/.config/libfm" "$HOME/.config/pcmanfm/default"

  cat >"$HOME/.config/libfm/libfm.conf" <<EOF
[config]
single_click=0

[ui]
big_icon_size=64
small_icon_size=24
pane_icon_size=24
thumbnail_size=128
EOF

  cat >"$HOME/.config/pcmanfm/default/desktop-items-0.conf" <<EOF
[*]
wallpaper_mode=color
desktop_bg=#0b1220
desktop_fg=#ffffff
desktop_shadow=#000000
desktop_font=Sans 13
show_wm_menu=0
sort=mtime;ascending;
show_documents=0
show_trash=0
show_mounts=0
EOF

  cat >"$HOME/Desktop/Firefox.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Firefox
Comment=Open the web browser
Exec=firefox-esr about:blank
Icon=firefox-esr
Terminal=false
Categories=Network;WebBrowser;
EOF

  cat >"$HOME/Desktop/Terminal.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Terminal
Comment=Open a terminal
Exec=lxterminal
Icon=utilities-terminal
Terminal=false
Categories=System;TerminalEmulator;
EOF

  chmod +x "$HOME/Desktop/Firefox.desktop" "$HOME/Desktop/Terminal.desktop"
}

echo "[helm] Preparing runtime directories..."
mkdir -p "$HOME" "$HOME/Desktop" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
create_desktop_assets

echo "[helm] Cleaning stale X11 locks..."
sudo mkdir -p /tmp/.X11-unix
sudo chmod 1777 /tmp/.X11-unix
sudo rm -f /tmp/.X${DISPLAY_NUM:-99}-lock /tmp/.X11-unix/X${DISPLAY_NUM:-99}

echo "[helm] Starting Xvfb..."
Xvfb "$DISPLAY" -screen 0 "${WIDTH:-1366}x${HEIGHT:-768}x24" -ac -nolisten tcp +extension RANDR &
XVFB_PID=$!

echo "[helm] Waiting for X display..."
for _ in $(seq 1 100); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "[helm] X display failed to start"
  exit 1
fi

echo "[helm] Starting D-Bus session..."
if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
fi

echo "[helm] Starting window manager..."
openbox >/tmp/openbox.log 2>&1 &
OPENBOX_PID=$!
sleep 0.5

echo "[helm] Setting desktop background..."
xsetroot -display "$DISPLAY" -solid "#1f2430"

echo "[helm] Starting desktop manager..."
pcmanfm --desktop --profile default --display="$DISPLAY" >/tmp/pcmanfm.log 2>&1 &
sleep 0.5

echo "[helm] Starting taskbar..."
tint2 >/tmp/tint2.log 2>&1 &

echo "[helm] Desktop apps available as large launch icons: Firefox and Terminal"

echo "[helm] Starting x11vnc..."
x11vnc \
  -display "$DISPLAY" \
  -nopw \
  -listen 0.0.0.0 \
  -rfbport 5900 \
  -xkb \
  -forever \
  -shared \
  -repeat \
  -noxdamage \
  -quiet &
X11VNC_PID=$!

echo "[helm] Starting noVNC..."
/opt/noVNC/utils/novnc_proxy \
  --vnc localhost:5900 \
  --listen 6080 >/tmp/novnc.log 2>&1 &
NOVNC_PID=$!

echo "[helm] Desktop ready at http://localhost:6080/vnc.html?autoconnect=true&resize=scale"

wait -n "$XVFB_PID" "$OPENBOX_PID" "$X11VNC_PID" "$NOVNC_PID"
echo "[helm] One of the core desktop processes exited"
exit 1
