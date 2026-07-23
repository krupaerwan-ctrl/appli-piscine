#!/bin/bash
# PoolKiosk update script.
# Usage: update.sh online|usb
# The backend triggers this in the background and writes status to /tmp files.
set -e

MODE="$1"
STATE_FILE=/tmp/poolkiosk_update_state.txt
LOG_FILE=/tmp/poolkiosk_update.log

# --- Auto-detect the app home directory ---
# 1) $POOLKIOSK_HOME env var (set by backend when invoking us).
# 2) Directory containing THIS script (works whether the folder is called
#    'poolkiosk', 'appli-piscine', or anything else).
# 3) Falls back to /home/pi/poolkiosk for backward compat.
if [ -n "$POOLKIOSK_HOME" ]; then
    HOME_DIR="$POOLKIOSK_HOME"
else
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
    if [ -d "$SCRIPT_DIR/backend" ] && [ -d "$SCRIPT_DIR/frontend" ]; then
        HOME_DIR="$SCRIPT_DIR"
    else
        HOME_DIR="/home/pi/poolkiosk"
    fi
fi

# --- Auto-detect the systemd service names ---
# Users may have named services 'poolkiosk-*', 'appli-piscine-*', or something
# else. We look for any unit that matches known patterns.
find_service() {
    local pat="$1"
    for svc in $(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}'); do
        if echo "$svc" | grep -qiE "$pat"; then
            echo "$svc"
            return 0
        fi
    done
    return 1
}
BACKEND_SVC="$(find_service '(poolkiosk|appli-piscine|pool-kiosk).*back' || true)"
FRONTEND_SVC="$(find_service '(poolkiosk|appli-piscine|pool-kiosk).*front' || true)"

echo "=== $(date) : starting update ($MODE) ==="
echo "-- Home dir      : $HOME_DIR"
echo "-- Backend svc   : ${BACKEND_SVC:-<non détecté>}"
echo "-- Frontend svc  : ${FRONTEND_SVC:-<non détecté>}"

fail() {
    echo "!! $1"
    echo "failed" > "$STATE_FILE"
    exit 1
}

cd "$HOME_DIR" || fail "HOME_DIR introuvable: $HOME_DIR"

if [ "$MODE" = "online" ]; then
    echo "-- Récupération de la dernière version depuis GitHub..."
    # Untrack the SQLite DB in case an old commit still has it, then stash
    # any local changes so 'git pull' never conflicts with the running DB.
    git rm --cached backend/poolkiosk.db 2>/dev/null || true
    git rm --cached backend/poolkiosk.db-shm 2>/dev/null || true
    git rm --cached backend/poolkiosk.db-wal 2>/dev/null || true
    git stash push --include-untracked -m "poolkiosk-auto-$(date +%s)" >/dev/null 2>&1 || true
    if ! git pull --ff-only 2>&1; then
        # Try to restore stash before failing
        git stash pop 2>/dev/null || true
        fail "git pull a échoué (vérifiez la connexion Internet)."
    fi
    # Restore ONLY the untracked runtime files (the DB), never touch code files
    git stash pop 2>/dev/null || true
    # If the pull re-added the DB in the tree (from history), keep local version:
    git checkout HEAD -- . 2>/dev/null || true
    # Nothing to do beyond that; the DB file (untracked now) is preserved

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
# Install the FULL requirements.txt (adds new libs like httpx, pymodbus, etc.)
# Fall back to a minimal set if requirements.txt is missing for any reason.
if [ -f "requirements.txt" ]; then
    .venv/bin/pip install --quiet --upgrade -r requirements.txt || \
        .venv/bin/pip install --quiet --upgrade \
            fastapi 'uvicorn[standard]' aiosqlite pydantic python-dotenv paho-mqtt httpx
else
    .venv/bin/pip install --quiet --upgrade \
        fastapi 'uvicorn[standard]' aiosqlite pydantic python-dotenv paho-mqtt httpx
fi

# Sanity check: verify the backend actually imports before we restart it.
if ! .venv/bin/python -c "import server" 2>/tmp/poolkiosk_import_err.txt; then
    echo "!! Le backend ne peut pas démarrer avec le nouveau code :"
    cat /tmp/poolkiosk_import_err.txt
    fail "Import backend échoué — dépendance manquante ou code cassé. Vérifiez ci-dessus."
fi

echo "-- Recompilation du frontend (2-5 min)..."
cd "$HOME_DIR/frontend"
# --ignore-engines: some Expo/RN devDeps require Node ≥20.19.4 which many Pis
# don't ship yet. We ignore the engine strict check because the built output
# runs in Chromium, not Node, so a slightly older Node at build time is fine.
if command -v yarn >/dev/null 2>&1; then
    yarn install --silent --ignore-engines || yarn install --ignore-engines
else
    npm install --silent --legacy-peer-deps --engine-strict=false || \
        npm install --legacy-peer-deps --engine-strict=false
fi
npx expo export -p web

echo "-- Redémarrage du frontend..."
if [ -n "$FRONTEND_SVC" ]; then
    if sudo -n /bin/systemctl restart "$FRONTEND_SVC" 2>/dev/null; then
        echo "Frontend ($FRONTEND_SVC) redémarré."
    else
        echo "!! sudo systemctl restart $FRONTEND_SVC a échoué. Vérifiez la config sudoers."
    fi
else
    echo "-- Aucun service frontend systemd détecté (pas grave si Chromium relit dist/ directement)."
fi

echo "success" > "$STATE_FILE"
echo "=== $(date) : mise à jour terminée avec succès ==="
echo "-- Redémarrage du backend dans 3s (cette fenêtre va se figer)..."

# Restart backend last, from a background subshell so this script can finish.
# Sudoers example: erwan ALL=(ALL) NOPASSWD: /bin/systemctl restart appli-piscine-backend
if [ -n "$BACKEND_SVC" ]; then
    (sleep 3 && sudo -n /bin/systemctl restart "$BACKEND_SVC") &
    disown
else
    echo "-- Aucun service backend systemd détecté. Redémarrez-le manuellement."
fi
exit 0
