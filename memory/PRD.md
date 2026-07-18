# PoolKiosk – PRD

## Objectif
Application kiosque de gestion d'une piscine (filtration + électrolyseur) tournant sur un Raspberry Pi + écran tactile 7". Fonctionne 100% en local (LAN, sans Internet). Utilise des sondes Zigbee via un broker MQTT local (Mosquitto + Zigbee2MQTT).

## Utilisateur
Propriétaire piscine dans son local technique. Usage personnel, pas d'authentification. Interface en français, mode paysage (1024×600), touch-first.

## Fonctionnalités MVP livrées
1. **Dashboard configurable** avec 10 widgets activables via un écran "Widgets" dédié.
2. **Capteurs temps réel** (simulateur intégré + bridge MQTT prêt) : Température eau, pH, Redox (ORP), Salinité, Pression, Température extérieure.
3. **Équipements** avec toggles ON/OFF : Filtration, Électrolyseur, Pompe à chaleur, Éclairage.
4. **Sécurité pompe** : arrêt automatique si pression hors seuils (basse = fuite/désamorçage, haute = filtre bouché) avec création d'alerte.
5. **Programmation filtration** : plages horaires modifiables + calcul auto des heures recommandées = température / 2.
6. **Historique** multi-métrique (24h/7j) avec graphique aire.
7. **Alertes** : liste, acquittement, effacement.
8. **Paramètres** : consignes cibles, seuils min/max, activation sécurité pression, activation filtration auto, durée avant mise en veille écran.
9. **Screensaver** : mise en veille après 5 min d'inactivité (configurable) avec horloge + température de l'eau. Tap pour réveiller.
10. **État système** : indicateurs Zigbee / MQTT / Capteurs + horodatage dernière donnée.

## Architecture
- **Frontend** : Expo (React Native) + expo-router, build web servi en mode kiosque Chromium.
- **Backend** : FastAPI (Python), MongoDB pour la persistance (readings, equipment, schedules, settings, widgets, alerts).
- **Bridge MQTT** : `paho-mqtt` intégré au backend, s'active si `MQTT_BROKER` env défini. Sinon simulateur en background.
- **Sécurité & auto-filtration** : logique métier centralisée dans `server.py` (fonctions `safety_check` et `compute_filtration_hours`).

## Endpoints backend clés (/api)
- `GET /dashboard/summary` – snapshot complet (sensors, equipment, schedules, widgets, settings, alerts, système)
- `GET /sensors/latest`, `GET /sensors/history?metric=&hours=`
- `GET /equipment`, `POST /equipment/{id}/toggle`
- `GET /schedule`, `POST /schedule`, `PUT /schedule/{id}`, `DELETE /schedule/{id}`
- `GET/PUT /settings`
- `GET /alerts`, `POST /alerts/{id}/ack`, `DELETE /alerts`
- `GET /widgets`, `PUT /widgets/{id}`, `PUT /widgets` (bulk)
- `GET /system/status`

## Déploiement
Voir `/app/DEPLOY_RASPBERRY.md` pour l'installation complète sur Raspberry Pi (Mosquitto, Zigbee2MQTT, MongoDB, systemd, Chromium kiosque).

## Roadmap post-MVP
- Drag & drop de l'ordre des widgets sur le dashboard.
- Notifications HTTP vers un téléphone (via IP locale ou webhook Home Assistant).
- Contrôles avancés de l'électrolyseur (mode boost, mode hiver).
- Export CSV des historiques.
- Multi-profils (été / hiver).
