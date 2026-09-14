# Playwright's own image: Chromium with every library it needs, published for
# both amd64 and arm64, so the same add-on builds on a NUC or a Raspberry Pi.
# The npm package below is pinned to the same version, because a Playwright
# client driving a browser from a different release fails at launch.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV DEBIAN_FRONTEND=noninteractive
# A virtual screen, a VNC server on it, and noVNC to show it in Home Assistant.
# The screen is how you sign in: Edsby's login may be a school Google or
# Microsoft account with its own prompts, and only a real browser you can see
# gets through that.
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fonts-noto-core \
 && rm -rf /var/lib/apt/lists/* \
 && cp -r /usr/share/novnc /opt/novnc

COPY novnc-index.html /opt/novnc/index.html

WORKDIR /app
COPY collector/package.json collector/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY collector/index.mjs collector/redact.mjs ./

COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
