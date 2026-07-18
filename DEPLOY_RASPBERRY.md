# Déploiement PoolKiosk sur Raspberry Pi

Ce guide décrit comment installer PoolKiosk sur votre Raspberry Pi (recommandé : Pi 3B+ ou supérieur) avec écran tactile 7 pouces, en mode kiosque.

## 1. Pré-requis matériel

- Raspberry Pi 3B+ / 4 / 5
- Écran tactile 7" HDMI (résolution recommandée : 1024×600)
- Coordinateur Zigbee USB (ex. Sonoff Zigbee 3.0 Dongle Plus, ConBee II)
- Sondes Zigbee (température, pH, ORP, salinité, pression) déjà appairées
- Alimentation stable (5V / 3A minimum)

## 2. Système d'exploitation

Installez **Raspberry Pi OS (64-bit)** avec desktop. Assurez-vous que le Wi-Fi ou l'Ethernet local est configuré (l'accès Internet n'est pas requis pour le fonctionnement quotidien).

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git python3 python3-pip python3-venv nodejs npm chromium-browser unclutter xdotool
```

## 3. MongoDB

```bash
# Sur Pi 64-bit :
wget -qO - https://pgp.mongodb.com/server-7.0.asc | sudo apt-key add -
echo "deb [ arch=arm64 ] https://repo.mongodb.org/apt/debian bullseye/mongodb-org/7.0 main" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable mongod --now
```

## 4. Broker MQTT (Mosquitto) + Zigbee2MQTT

```bash
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable mosquitto --now

# Zigbee2MQTT (recommandé) - il expose vos sondes Zigbee sur les topics MQTT
sudo npm install -g zigbee2mqtt
# Suivez la configuration officielle :
# https://www.zigbee2mqtt.io/guide/installation/01_linux.html
```

Dans la config de Zigbee2MQTT, mappez chaque sonde vers un topic MQTT `pool/<metric>` en utilisant un `friendly_name` compatible :

```yaml
# configuration.yaml de Zigbee2MQTT
mqtt:
  base_topic: pool
  server: 'mqtt://localhost'

devices:
  '0x00158d0001234567':
    friendly_name: temp
  '0x00158d0009876543':
    friendly_name: ph
  # etc. pour orp, salinity, pressure
```

## 5. Installation de PoolKiosk

```bash
cd ~
git clone <votre_repo>.git poolkiosk
cd poolkiosk

# Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# .env
cat > .env <<EOF
MONGO_URL=mongodb://localhost:27017
DB_NAME=poolkiosk
MQTT_BROKER=127.0.0.1
MQTT_PORT=1883
MQTT_TOPIC_PREFIX=pool
EOF

# Test lancement
uvicorn server:app --host 0.0.0.0 --port 8001
```

Le backend démarre le simulateur si `MQTT_BROKER` n'est pas défini ; sinon il écoute les topics MQTT (`pool/temp`, `pool/ph`, `pool/orp`, `pool/salinity`, `pool/pressure`) et met à jour l'état capteurs en temps réel.

### Frontend

```bash
cd ../frontend
yarn install
# .env
echo 'EXPO_PUBLIC_BACKEND_URL=http://127.0.0.1:8001' > .env

# Build web (sortie statique)
yarn expo export -p web
# Résultat : ./dist/
```

Servez le build avec un serveur statique local :

```bash
sudo npm install -g serve
serve -s dist -l 3000
```

## 6. Mode kiosque au démarrage

Créez `~/.config/lxsession/LXDE-pi/autostart` :

```
@xset s off
@xset -dpms
@xset s noblank
@unclutter -idle 0
@chromium-browser --kiosk --noerrdialogs --disable-infobars --incognito http://127.0.0.1:3000
```

## 7. Services systemd

`/etc/systemd/system/poolkiosk-backend.service` :

```ini
[Unit]
Description=Pool Kiosk Backend
After=network.target mongod.service mosquitto.service

[Service]
User=pi
WorkingDirectory=/home/pi/poolkiosk/backend
ExecStart=/home/pi/poolkiosk/backend/.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8001
Restart=always

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/poolkiosk-frontend.service` :

```ini
[Unit]
Description=Pool Kiosk Frontend
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/poolkiosk/frontend
ExecStart=/usr/bin/serve -s dist -l 3000
Restart=always

[Install]
WantedBy=multi-user.target
```

Activez :

```bash
sudo systemctl enable --now poolkiosk-backend poolkiosk-frontend
```

## 8. Fonctionnement offline

Tout tourne en local :
- Chromium → `http://127.0.0.1:3000`
- Frontend → Backend `http://127.0.0.1:8001/api/*`
- Backend → MongoDB local + broker MQTT local
- Sondes Zigbee → Zigbee2MQTT → topics `pool/*` → Backend

Aucune connexion Internet requise. Le tableau de bord est accessible localement depuis un autre appareil du LAN via `http://<IP-du-Pi>:3000` (idéal pour smartphone dans le jardin).

## 9. Sécurité pompe (arrêt automatique)

Le backend surveille en permanence la pression :
- Si `pression < pressure_min` → pompe filtration arrêtée, alerte "Pression trop basse".
- Si `pression > pressure_max` → pompe arrêtée, alerte "Filtre probablement bouché".

Les seuils sont configurables dans l'écran **Paramètres** (par défaut 0.5 – 1.5 bar).

## 10. Filtration auto selon température

Règle appliquée : `heures = température_eau / 2` (formule classique piscine, entre 4h et 24h). La valeur recommandée s'affiche dans le widget Programmation et l'écran Programmation détaillé.

## 11. Mise en veille écran

L'écran passe en mode "screensaver" (fond noir + horloge + température) après **5 minutes** d'inactivité (durée configurable dans Paramètres). Un tap n'importe où réveille l'interface.
