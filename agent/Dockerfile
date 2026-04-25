FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DEBIAN_PRIORITY=high

RUN apt-get update && \
    apt-get -y upgrade && \
    apt-get -y install \
      xvfb \
      ca-certificates \
      xterm \
      lxterminal \
      xdotool \
      scrot \
      imagemagick \
      sudo \
      openbox \
      dbus-x11 \
      x11vnc \
      tint2 \
      pcmanfm \
      desktop-file-utils \
      adwaita-icon-theme \
      fonts-dejavu \
      xdg-utils \
      gedit \
      galculator \
      net-tools \
      netcat \
      curl \
      git \
      unzip \
      x11-apps \
      x11-xserver-utils \
      software-properties-common && \
    add-apt-repository ppa:mozillateam/ppa && \
    apt-get install -y --no-install-recommends \
      firefox-esr && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN git clone --branch v1.5.0 https://github.com/novnc/noVNC.git /opt/noVNC && \
    git clone --branch v0.12.0 https://github.com/novnc/websockify /opt/noVNC/utils/websockify && \
    ln -s /opt/noVNC/vnc.html /opt/noVNC/index.html

ENV USERNAME=agent
ENV HOME=/home/$USERNAME
RUN useradd -m -s /bin/bash -d $HOME $USERNAME && \
    echo "${USERNAME} ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

USER agent
WORKDIR $HOME

ARG DISPLAY_NUM=99
ARG HEIGHT=720
ARG WIDTH=1280
ENV DISPLAY_NUM=$DISPLAY_NUM
ENV HEIGHT=$HEIGHT
ENV WIDTH=$WIDTH
ENV DISPLAY=:${DISPLAY_NUM}

COPY --chown=agent:agent ./scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
