FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install sudo, desktop, VNC, and general-purpose apps
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      sudo xfce4 xfce4-goodies xfce4-terminal dbus-x11 x11-xserver-utils \
      x11vnc xvfb novnc websockify \
      xdotool scrot curl ca-certificates nano vim git wget gnupg \
      libreoffice fonts-ubuntu papirus-icon-theme arc-theme \
    && wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y -qq --no-install-recommends /tmp/google-chrome.deb \
    && rm -f /tmp/google-chrome.deb \
    && if [ "$(apt-cache policy chromium | awk '/Candidate:/ {print $2}')" != "(none)" ]; then \
         apt-get install -y -qq --no-install-recommends chromium; \
       elif [ "$(apt-cache policy chromium-browser | awk '/Candidate:/ {print $2}')" != "(none)" ]; then \
         apt-get install -y -qq --no-install-recommends chromium-browser; \
       else \
         echo "[helm] Chromium package not available on this base image; continuing with Google Chrome only."; \
       fi \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create agent user with passwordless sudo
RUN useradd -ms /bin/bash agent && \
    echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent

# Non-root X servers require this directory to exist with sticky bit.
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

USER agent
WORKDIR /home/agent

# Copy scripts
COPY ./scripts /agent/scripts
RUN chmod +x /agent/scripts/entrypoint.sh || true

# Expose noVNC port
EXPOSE 6080

ENTRYPOINT ["/agent/scripts/entrypoint.sh"]
