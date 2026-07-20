#!/bin/bash
# PoolKiosk update script.
# Usage: update.sh online|usb
# The backend triggers this in the background and writes status to /tmp files.
set -e

MODE="$1"
STATE_FILE=/tmp/poolkiosk_update_state.txt
LOG_FILE=/tmp/poolkiosk_update.log
HOME_DIR="${POOLKIOSK_HOME:-/home/pi/poolkiosk}"

echo "=== $(date) : starting update ($MODE) ==="

fail() {
    echo "!! $1"
    echo "failed" > "$STATE_FILE"
    exit 1
}

cd "$HOME_DIR" || fail "HOME_DIR introuvable: $HOME_DIR"

if [ "$MODE" = "online" ]; then
    echo "-- Récupération de la dernière version depuis GitHub..."
    if ! git pull --ff-only 2>&1; then
        fail "git pull a échoué (vérifiez la connexion Internet)."
    fi

elif [ "$MODE" = "usb" ]; then
    echo "-- Recherche d'une clé USB avec poolkiosk-update*.zip..."
    ZIP=$(find /media/*/ /mnt/ /run/media/*/ -maxdepth 3 -type f -name "poolkiosk-update*.zip" 2>/dev/null | head -1)
    if [ -z "$ZIP" ]; then
        fail "Aucun fichier poolkiosk-update*.zip trouvé sur clé USB. Vérifiez le nom du fichier."
    fi
    echo "-- Trouvé: $ZIP"
    TMP=$(mktemp -d)
    unzip -q "$ZIP" -d "$TMP"
    # Detect the top-level folder inside the zip (either bare, or in a subfolder)
    SRC="$TMP"
    if [ -d "$TMP/backend" ] && [ -d "$TMP/frontend" ]; then
        SRC="$TMP"
    else
        SUB=$(find "$TMP" -maxdepth 2 -type d -name "backend" | head -1)
        if [ -n "$SUB" ]; then
            SRC=$(dirname "$SUB")
        fi
    fi
    echo "-- Synchronisation depuis $SRC vers $HOME_DIR..."
    rsync -a --delete-after \
        --exclude=".git" --exclude=".env" --exclude="node_modules" \
        --exclude=".venv" --exclude="dist" \
        "$SRC/" "$HOME_DIR/"
    rm -rf "$TMP"

else
    fail "Mode inconnu: $MODE"
fi

echo "-- Mise à jour des dépendances backend..."
cd "$HOME_DIR/backend"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade \
    fastapi 'uvicorn[standard]' aiosqlite pydantic python-dotenv paho-mqtt

echo "-- Recompilation du frontend (2-5 min)..."
cd "$HOME_DIR/frontend"
if command -v yarn >/dev/null 2>&1; then
    yarn install --silent
else
    npm install --silent
fi
npx expo export -p web

echo "-- Redémarrage du frontend..."
if sudo -n /bin/systemctl restart poolkiosk-frontend 2>/dev/null; then
    echo "Frontend redémarré."
else
    echo "!! sudo systemctl restart poolkiosk-frontend a échoué. Vérifiez la config sudoers."
fi

echo "success" > "$STATE_FILE"
echo "=== $(date) : mise à jour terminée avec succès ==="
echo "-- Redémarrage du backend dans 3s (cette fenêtre va se figer)..."

# Restart backend last, from a background subshell so this script can finish.
# Requires: pi ALL=(ALL) NOPASSWD: /bin/systemctl restart poolkiosk-backend
(sleep 3 && sudo -n /bin/systemctl restart poolkiosk-backend) &
disown
exit 0
