#!/bin/bash
# Appli Piscine - Kiosk mode launcher
# Waits for backend, then launches Chromium in fullscreen kiosk mode.
# Compatible with old (chromium-browser) and new (chromium) Raspberry Pi OS.

# Detect the Chromium binary name
CHROMIUM=$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)
if [ -z "$CHROMIUM" ]; then
    echo "!! Chromium introuvable. Installez avec : sudo apt install chromium"
    exit 1
fi

# Wait for backend to be ready (up to 30 sec)
for i in {1..30}; do
    if curl -sf http://127.0.0.1:8001/api/ > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Kill any existing chromium instance
pkill -f chromium 2>/dev/null
sleep 1

# Clear any "Chromium didn't shut down cleanly" banner from previous crash
PREF=~/.config/chromium/Default/Preferences
if [ -f "$PREF" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' "$PREF" 2>/dev/null
    sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PREF" 2>/dev/null
fi

# Launch Chromium in kiosk mode (stderr suppressed: harmless EGL/GL warnings on Pi 3B+)
exec "$CHROMIUM" \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=TranslateUI,DialMediaRouteProvider \
    --disable-background-networking \
    --disable-translate \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --disable-gpu-driver-bug-workarounds \
    --disable-logging \
    --log-level=3 \
    --silent-debugger-extension-api \
    --touch-events=enabled \
    --enable-features=OverlayScrollbar \
    --incognito \
    http://127.0.0.1:3000 2>/dev/null
