#!/usr/bin/env bash
set -uo pipefail

export DISPLAY=:99
rm -f /tmp/.X99-lock

# The screen Chromium draws on, and the view of it Home Assistant shows.
# VNC listens on localhost only and has no password: the one way in is
# through Home Assistant's own sign-in, via ingress.
Xvfb :99 -screen 0 1366x900x24 -nolisten tcp &
sleep 1
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet &
websockify --web /opt/novnc 6080 localhost:5900 >/dev/null 2>&1 &

cd /app
# If Chromium is closed or crashes, bring it back with the same profile, so
# the sign-in survives.
while true; do
  node index.mjs
  echo "[edsby-bridge] browser stopped; starting it again in 5 seconds"
  sleep 5
done
