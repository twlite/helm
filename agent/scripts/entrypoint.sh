#!/bin/bash
set -e

export DISPLAY=:99
export HOME=/home/agent

configure_desktop_look() {
	local wallpaper="/usr/share/backgrounds/xfce/xfce-stripes.png"
	local browser_exec="google-chrome"

	if [ ! -f "$wallpaper" ]; then
		wallpaper="$(find /usr/share/backgrounds -type f | head -n 1 || true)"
	fi

	# Enable XFCE desktop icons and apply a less bare default visual style.
	xfconf-query -c xfce4-desktop -p /desktop-icons/style -n -t int -s 2 || true
	xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-home -n -t bool -s true || true
	xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-trash -n -t bool -s true || true
	xfconf-query -c xfce4-desktop -p /desktop-icons/file-icons/show-filesystem -n -t bool -s true || true

	if [ -n "$wallpaper" ]; then
		while IFS= read -r path; do
			xfconf-query -c xfce4-desktop -p "$path" -s "$wallpaper" || true
		done < <(xfconf-query -c xfce4-desktop -l | grep '/last-image$' || true)
	fi

	xfconf-query -c xsettings -p /Net/IconThemeName -n -t string -s Papirus-Dark || true
	xfconf-query -c xsettings -p /Net/ThemeName -n -t string -s Arc-Dark || true
	xfconf-query -c xsettings -p /Net/CursorThemeName -n -t string -s Adwaita || true

	if ! pgrep -x xfdesktop >/dev/null 2>&1; then
		xfdesktop &
	fi
}

echo "[helm] Preparing writable agent home..."
sudo mkdir -p "$HOME" "$HOME/.config" "$HOME/.cache" "$HOME/.dbus"
# Named volumes can be root-owned from prior runs; fix ownership so XFCE can initialize.
sudo chown -R agent:agent "$HOME"
touch "$HOME/.Xauthority" "$HOME/.ICEauthority"
chmod 700 "$HOME/.dbus"

echo "[helm] Cleaning stale X11 display locks..."
sudo rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

echo "[helm] Starting Xvfb..."
Xvfb :99 -screen 0 ${RESOLUTION:-1280x720x24} &
sleep 1

echo "[helm] Starting XFCE desktop..."
if command -v dbus-launch >/dev/null 2>&1; then
	eval "$(dbus-launch --sh-syntax)"
	startxfce4 &
else
	startxfce4 &
fi
sleep 3

echo "[helm] Applying desktop style..."
configure_desktop_look

echo "[helm] Starting x11vnc..."
x11vnc -display :99 -nopw -listen 0.0.0.0 -xkb -forever -shared -noxdamage &

echo "[helm] Starting noVNC..."
websockify --web /usr/share/novnc 6080 localhost:5900 &

echo "[helm] Desktop ready at http://localhost:6080/vnc.html"

# Keep container alive
wait
