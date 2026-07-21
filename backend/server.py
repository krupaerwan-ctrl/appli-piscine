"""Appli Piscine Backend - FastAPI + SQLite + MQTT-ready sensor bridge.

Rewritten to use SQLite (zero deps, no Docker) — perfectly sized for Raspberry Pi.
"""
from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import aiosqlite
import os
import asyncio
import json
import logging
import random
import math
import subprocess
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone, timedelta

ROOT_DIR = Path(__file__).parent
POOLKIOSK_HOME = Path(os.environ.get("POOLKIOSK_HOME", ROOT_DIR.parent))
DB_PATH = Path(os.environ.get("POOLKIOSK_DB_PATH", ROOT_DIR / "poolkiosk.db"))
UPDATE_LOG = Path("/tmp/poolkiosk_update.log")
UPDATE_STATE_FILE = Path("/tmp/poolkiosk_update_state.txt")
_update_proc: Optional[subprocess.Popen] = None
load_dotenv(ROOT_DIR / ".env")

app = FastAPI(title="Appli Piscine API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("pool")

# ==============================================================
# DEFAULTS
# ==============================================================
DEFAULT_SETTINGS = {
    "temp_target": 28.0,
    "ph_min": 7.0,
    "ph_max": 7.4,
    "orp_min": 600,
    "orp_max": 750,
    "salinity_min": 3000,
    "salinity_max": 4000,
    "pressure_min": 0.5,
    "pressure_max": 1.5,
    "pressure_auto_cutoff": True,
    "auto_filtration": True,
    "screen_sleep_minutes": 5,
}

DEFAULT_EQUIPMENT = [
    {"id": "filtration", "name": "Filtration", "icon": "engine", "state": 1, "auto_managed": 1},
    {"id": "electrolyseur", "name": "Électrolyseur", "icon": "flash", "state": 1, "auto_managed": 0},
    {"id": "heat_pump", "name": "Pompe à chaleur", "icon": "fire", "state": 0, "auto_managed": 0},
    {"id": "lighting", "name": "Éclairage", "icon": "bulb", "state": 0, "auto_managed": 0},
]

DEFAULT_SCHEDULES = [
    {"start": "08:00", "end": "12:00", "enabled": 1},
    {"start": "14:00", "end": "18:00", "enabled": 1},
    {"start": "22:00", "end": "06:00", "enabled": 1},
]

DEFAULT_WIDGETS = [
    {"id": "temp", "name": "Température de l'eau", "enabled": 1, "order_num": 1},
    {"id": "ph", "name": "pH", "enabled": 1, "order_num": 2},
    {"id": "orp", "name": "Redox (ORP)", "enabled": 1, "order_num": 3},
    {"id": "salinity", "name": "Sel (Salinité)", "enabled": 1, "order_num": 4},
    {"id": "history", "name": "Historique température 24h", "enabled": 1, "order_num": 5},
    {"id": "pressure", "name": "Pression / Niveau", "enabled": 1, "order_num": 6},
    {"id": "equipment", "name": "Équipements", "enabled": 1, "order_num": 7},
    {"id": "schedule", "name": "Programmation filtration", "enabled": 1, "order_num": 8},
    {"id": "system", "name": "État système", "enabled": 1, "order_num": 9},
    {"id": "alerts", "name": "Alertes", "enabled": 1, "order_num": 10},
]

# A few demo Zigbee devices so the "Appareils Zigbee" screen is populated
# out-of-the-box (offline mode). Real devices auto-populate via MQTT bridge.
DEMO_ZIGBEE_DEVICES = [
    {"id": "0x00158d0001a2b3c4", "friendly_name": "relais-pompe", "model": "Sonoff ZBMINI",
     "device_type": "relay", "assigned_role": "filtration", "online": 1},
    {"id": "0x00158d0002a2b3c5", "friendly_name": "relais-electro", "model": "Sonoff ZBMINI",
     "device_type": "relay", "assigned_role": "electrolyseur", "online": 1},
    {"id": "0x00158d0003a2b3c6", "friendly_name": "relais-pac", "model": "Sonoff ZBMINI",
     "device_type": "relay", "assigned_role": "heat_pump", "online": 1},
    {"id": "0x00158d0004a2b3c7", "friendly_name": "relais-light", "model": "Sonoff ZBMINI",
     "device_type": "relay", "assigned_role": "lighting", "online": 1},
    {"id": "0x00158d0005a2b3c8", "friendly_name": "sonde-temp", "model": "Aqara T1",
     "device_type": "sensor", "assigned_role": "temp", "online": 1},
    {"id": "0x00158d0006a2b3c9", "friendly_name": "sonde-ph", "model": "IPX pH",
     "device_type": "sensor", "assigned_role": "ph", "online": 1},
    {"id": "0x00158d0007a2b3ca", "friendly_name": "sonde-orp", "model": "IPX ORP",
     "device_type": "sensor", "assigned_role": "orp", "online": 1},
    {"id": "0x00158d0008a2b3cb", "friendly_name": "sonde-salinite", "model": "IPX SAL",
     "device_type": "sensor", "assigned_role": "salinity", "online": 1},
    {"id": "0x00158d0009a2b3cc", "friendly_name": "sonde-pression", "model": "Xiaomi PZ", 
     "device_type": "sensor", "assigned_role": "pressure", "online": 1},
]

# ==============================================================
# MODELS
# ==============================================================
class EquipmentToggle(BaseModel):
    state: bool

class Schedule(BaseModel):
    id: Optional[str] = None
    start: str
    end: str
    enabled: bool = True

class WidgetConfig(BaseModel):
    id: str
    name: str
    enabled: bool
    order: int

class SettingsPayload(BaseModel):
    temp_target: Optional[float] = None
    ph_min: Optional[float] = None
    ph_max: Optional[float] = None
    orp_min: Optional[int] = None
    orp_max: Optional[int] = None
    salinity_min: Optional[int] = None
    salinity_max: Optional[int] = None
    pressure_min: Optional[float] = None
    pressure_max: Optional[float] = None
    pressure_auto_cutoff: Optional[bool] = None
    auto_filtration: Optional[bool] = None
    screen_sleep_minutes: Optional[int] = None


# ==============================================================
# HELPERS
# ==============================================================
def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat()


def compute_filtration_hours(water_temp: float) -> float:
    return max(4.0, min(24.0, water_temp / 2.0))


async def db_conn() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA journal_mode=WAL")
    return conn


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
        CREATE TABLE IF NOT EXISTS readings (
            id TEXT PRIMARY KEY, metric TEXT NOT NULL, value REAL NOT NULL,
            unit TEXT, ts TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_readings_metric_ts ON readings(metric, ts);

        CREATE TABLE IF NOT EXISTS equipment (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
            state INTEGER NOT NULL DEFAULT 0, auto_managed INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS widgets (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
            order_num INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL,
            message TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS zigbee_devices (
            id TEXT PRIMARY KEY, friendly_name TEXT, model TEXT,
            device_type TEXT, assigned_role TEXT,
            online INTEGER NOT NULL DEFAULT 0, last_seen TEXT
        );
        """)
        await db.commit()

        # Seed defaults if empty
        cur = await db.execute("SELECT COUNT(*) FROM settings")
        row = await cur.fetchone()
        if row[0] == 0:
            for k, v in DEFAULT_SETTINGS.items():
                await db.execute("INSERT INTO settings(key, value) VALUES(?, ?)",
                                 (k, json.dumps(v)))
        cur = await db.execute("SELECT COUNT(*) FROM equipment")
        if (await cur.fetchone())[0] == 0:
            for e in DEFAULT_EQUIPMENT:
                await db.execute(
                    "INSERT INTO equipment(id,name,icon,state,auto_managed) VALUES(?,?,?,?,?)",
                    (e["id"], e["name"], e["icon"], e["state"], e["auto_managed"]),
                )
        cur = await db.execute("SELECT COUNT(*) FROM schedules")
        if (await cur.fetchone())[0] == 0:
            for s in DEFAULT_SCHEDULES:
                await db.execute("INSERT INTO schedules(id,start,end,enabled) VALUES(?,?,?,?)",
                                 (str(uuid.uuid4()), s["start"], s["end"], s["enabled"]))
        cur = await db.execute("SELECT COUNT(*) FROM widgets")
        if (await cur.fetchone())[0] == 0:
            for w in DEFAULT_WIDGETS:
                await db.execute(
                    "INSERT INTO widgets(id,name,enabled,order_num) VALUES(?,?,?,?)",
                    (w["id"], w["name"], w["enabled"], w["order_num"]),
                )
        # Seed 24h of temperature history
        cur = await db.execute("SELECT COUNT(*) FROM readings WHERE metric='temp'")
        if (await cur.fetchone())[0] == 0:
            now = datetime.now(timezone.utc)
            docs = []
            for i in range(24 * 6):
                t = now - timedelta(minutes=(24 * 6 - i) * 10)
                v = 26 + 2 * math.sin((t.hour + t.minute / 60) / 24 * 2 * math.pi - math.pi / 2)
                docs.append((str(uuid.uuid4()), "temp", round(v, 2), "°C", _iso(t)))
            await db.executemany(
                "INSERT INTO readings(id,metric,value,unit,ts) VALUES(?,?,?,?,?)", docs
            )
        # Seed demo Zigbee devices
        cur = await db.execute("SELECT COUNT(*) FROM zigbee_devices")
        if (await cur.fetchone())[0] == 0:
            now_iso = _iso(datetime.now(timezone.utc))
            for d in DEMO_ZIGBEE_DEVICES:
                await db.execute(
                    "INSERT INTO zigbee_devices(id,friendly_name,model,device_type,"
                    "assigned_role,online,last_seen) VALUES(?,?,?,?,?,?,?)",
                    (d["id"], d["friendly_name"], d["model"], d["device_type"],
                     d["assigned_role"], d["online"], now_iso),
                )
        await db.commit()


async def get_settings_dict() -> Dict[str, Any]:
    out = dict(DEFAULT_SETTINGS)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute("SELECT key, value FROM settings"):
            try:
                out[row["key"]] = json.loads(row["value"])
            except Exception:
                out[row["key"]] = row["value"]
    return out


# ==============================================================
# SENSOR STATE (in-memory) + SAFETY
# ==============================================================
sensor_state: Dict[str, Dict[str, Any]] = {
    "temp": {"value": 26.4, "unit": "°C"},
    "ph": {"value": 7.2, "unit": ""},
    "orp": {"value": 650, "unit": "mV"},
    "salinity": {"value": 3500, "unit": "ppm"},
    "pressure": {"value": 0.9, "unit": "bar"},
    "outdoor_temp": {"value": 28, "unit": "°C"},
}

system_state: Dict[str, Any] = {
    "zigbee": "OK", "mqtt": "OK", "sensors": "OK",
    "mqtt_source": "simulator",
    "last_update": datetime.now(timezone.utc),
}


async def create_alert(level: str, title: str, message: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO alerts(id,level,title,message,acknowledged,ts) VALUES(?,?,?,?,0,?)",
            (str(uuid.uuid4()), level, title, message, _iso(datetime.now(timezone.utc))),
        )
        await db.commit()
    logger.warning("ALERT [%s] %s - %s", level, title, message)


# Track alert state per metric so we only fire on transitions (no spam)
_alert_state: Dict[str, str] = {}


async def evaluate_metric_alerts():
    """Compare each sensor against soft (warn) and hard (critical) thresholds.
    Fire an alert only when the state changes."""
    settings = await get_settings_dict()

    async def check(metric: str, val: float, low: float, high: float, unit: str,
                    low_low_msg: str, low_high_msg: str,
                    high_low_msg: str, high_high_msg: str):
        prev = _alert_state.get(metric, "normal")
        rng = max(0.001, high - low)
        warn_low = low + rng * 0.1
        warn_high = high - rng * 0.1
        if val < low:
            state = "critical_low"; msg = low_high_msg; level = "error"
            title = f"{metric.upper()} : valeur critique"
        elif val > high:
            state = "critical_high"; msg = high_high_msg; level = "error"
            title = f"{metric.upper()} : valeur critique"
        elif val < warn_low:
            state = "warn_low"; msg = low_low_msg; level = "warning"
            title = f"{metric.upper()} : à surveiller"
        elif val > warn_high:
            state = "warn_high"; msg = high_low_msg; level = "warning"
            title = f"{metric.upper()} : à surveiller"
        else:
            state = "normal"; msg = None; level = None; title = None
        if state != prev:
            _alert_state[metric] = state
            if state != "normal":
                await create_alert(level, title, msg)

    ph = sensor_state["ph"]["value"]
    await check("pH", ph, settings["ph_min"], settings["ph_max"], "",
                f"pH descend vers la limite basse ({ph:.2f}). À surveiller.",
                f"pH monte vers la limite haute ({ph:.2f}). À surveiller.",
                f"pH trop bas ({ph:.2f} < {settings['ph_min']}). Rééquilibrer.",
                f"pH trop haut ({ph:.2f} > {settings['ph_max']}). Rééquilibrer.")

    orp = sensor_state["orp"]["value"]
    await check("ORP", orp, settings["orp_min"], settings["orp_max"], "mV",
                f"Redox descend ({int(orp)} mV). Vérifier l'électrolyseur/chlore.",
                f"Redox monte ({int(orp)} mV). Surveiller.",
                f"Redox trop bas ({int(orp)} mV). Désinfection insuffisante.",
                f"Redox trop haut ({int(orp)} mV). Trop de chlore.")

    sal = sensor_state["salinity"]["value"]
    await check("SEL", sal, settings["salinity_min"], settings["salinity_max"], "ppm",
                f"Salinité basse ({int(sal)} ppm). Ajouter du sel prochainement.",
                f"Salinité haute ({int(sal)} ppm). Surveiller.",
                f"Salinité trop basse ({int(sal)} ppm). Recharger en sel.",
                f"Salinité trop haute ({int(sal)} ppm). Diluer.")

    p = sensor_state["pressure"]["value"]
    await check("PRESSION", p, settings["pressure_min"], settings["pressure_max"], "bar",
                f"Pression basse ({p:.2f} bar). Vérifier l'amorçage / niveau d'eau.",
                f"Pression monte ({p:.2f} bar). ⚠ Filtre à nettoyer prochainement.",
                f"Pression trop basse ({p:.2f} bar). Coupure automatique imminente.",
                f"Pression trop haute ({p:.2f} bar). Filtre bouché — coupure imminente.")


async def _stop_electrolyseur_and_pump(reason_pump: str):
    """Stop electrolyseur FIRST, then pump. Used by safety cut-offs."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE equipment SET state=0 WHERE id='electrolyseur'")
        await db.execute("UPDATE equipment SET state=0 WHERE id='filtration'")
        await db.commit()
    await create_alert("error", "Pompe arrêtée", reason_pump)


async def safety_check():
    settings = await get_settings_dict()
    if not settings.get("pressure_auto_cutoff", True):
        return
    p = sensor_state["pressure"]["value"]
    pmin, pmax = settings["pressure_min"], settings["pressure_max"]
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT state FROM equipment WHERE id='filtration'")
        row = await cur.fetchone()
        if not row or not row["state"]:
            return
    if p < pmin:
        await _stop_electrolyseur_and_pump(
            f"Pression trop basse ({p:.2f} bar < {pmin} bar). Électrolyseur puis filtration coupés automatiquement.")
    elif p > pmax:
        await _stop_electrolyseur_and_pump(
            f"Pression trop haute ({p:.2f} bar > {pmax} bar). Filtre bouché. Électrolyseur puis filtration coupés.")


async def sensor_simulator_loop():
    tick = 0
    while True:
        try:
            sensor_state["temp"]["value"] = round(max(18, min(32, sensor_state["temp"]["value"] + random.uniform(-0.15, 0.15))), 2)
            sensor_state["ph"]["value"] = round(max(6.5, min(8.0, sensor_state["ph"]["value"] + random.uniform(-0.02, 0.02))), 2)
            sensor_state["orp"]["value"] = int(max(400, min(900, sensor_state["orp"]["value"] + random.uniform(-8, 8))))
            sensor_state["salinity"]["value"] = int(max(2500, min(4500, sensor_state["salinity"]["value"] + random.uniform(-15, 15))))
            sensor_state["pressure"]["value"] = round(max(0.2, min(1.8, sensor_state["pressure"]["value"] + random.uniform(-0.03, 0.03))), 2)
            system_state["last_update"] = datetime.now(timezone.utc)

            if tick % 5 == 0:
                now = datetime.now(timezone.utc)
                docs = [
                    (str(uuid.uuid4()), m, float(sensor_state[m]["value"]),
                     sensor_state[m]["unit"], _iso(now))
                    for m in ("temp", "ph", "orp", "salinity", "pressure")
                ]
                async with aiosqlite.connect(DB_PATH) as db:
                    await db.executemany(
                        "INSERT INTO readings(id,metric,value,unit,ts) VALUES(?,?,?,?,?)", docs
                    )
                    cutoff = _iso(now - timedelta(days=7))
                    await db.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))
                    await db.commit()

            await safety_check()
            await evaluate_metric_alerts()
        except Exception as exc:
            logger.exception("simulator loop error: %s", exc)
        tick += 1
        await asyncio.sleep(2)


# ==============================================================
# OPTIONAL MQTT BRIDGE
# ==============================================================
def start_mqtt_bridge():
    broker = os.environ.get("MQTT_BROKER")
    if not broker:
        logger.info("MQTT bridge disabled (set MQTT_BROKER to enable).")
        return
    try:
        import paho.mqtt.client as mqtt
    except Exception:
        logger.warning("paho-mqtt not installed")
        return

    port = int(os.environ.get("MQTT_PORT", 1883))
    topic_prefix = os.environ.get("MQTT_TOPIC_PREFIX", "pool")

    def on_connect(c, u, f, rc, *_):
        logger.info("MQTT connected rc=%s", rc)
        c.subscribe(f"{topic_prefix}/#")
        system_state["mqtt"] = "OK"
        system_state["mqtt_source"] = "broker"

    def on_message(_c, _u, msg):
        metric = msg.topic.split("/")[-1]
        if metric in sensor_state:
            try:
                sensor_state[metric]["value"] = float(msg.payload.decode())
                system_state["last_update"] = datetime.now(timezone.utc)
            except Exception:
                pass

    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    try:
        client.connect(broker, port, 60)
        client.loop_start()
    except Exception as exc:
        logger.warning("MQTT connect failed: %s", exc)


# ==============================================================
# ROUTES
# ==============================================================
@api_router.get("/")
async def root():
    return {"service": "appli-piscine", "ok": True}


@api_router.get("/sensors/latest")
async def sensors_latest():
    return {
        "readings": [{"metric": m, **v} for m, v in sensor_state.items()],
        "ts": _iso(system_state["last_update"]),
    }


@api_router.get("/sensors/history")
async def sensors_history(metric: str = "temp", hours: int = 24):
    since = _iso(datetime.now(timezone.utc) - timedelta(hours=hours))
    items = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute(
            "SELECT id, metric, value, unit, ts FROM readings WHERE metric=? AND ts >= ? ORDER BY ts ASC",
            (metric, since),
        ):
            items.append(dict(row))
    return {"metric": metric, "hours": hours, "points": items}


@api_router.get("/equipment")
async def get_equipment():
    items = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute("SELECT id, name, icon, state, auto_managed FROM equipment"):
            d = dict(row)
            d["state"] = bool(d["state"])
            d["auto_managed"] = bool(d["auto_managed"])
            items.append(d)
    return {"equipment": items}


@api_router.post("/equipment/{eid}/toggle")
async def toggle_equipment(eid: str, payload: EquipmentToggle):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Business rule: electrolyseur requires pump running
        if eid == "electrolyseur" and payload.state:
            cur = await db.execute("SELECT state FROM equipment WHERE id='filtration'")
            pump_row = await cur.fetchone()
            if not pump_row or not pump_row["state"]:
                raise HTTPException(
                    409,
                    "L'électrolyseur ne peut pas fonctionner sans la pompe de filtration. "
                    "Démarrez d'abord la filtration.",
                )

        cur = await db.execute("UPDATE equipment SET state=? WHERE id=?",
                               (1 if payload.state else 0, eid))
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Equipment not found")

        # Business rule: stopping filtration also stops electrolyseur (safety)
        if eid == "filtration" and not payload.state:
            cur2 = await db.execute("SELECT state FROM equipment WHERE id='electrolyseur'")
            elec = await cur2.fetchone()
            if elec and elec["state"]:
                await db.execute("UPDATE equipment SET state=0 WHERE id='electrolyseur'")
                await db.commit()
                await create_alert("info", "Électrolyseur arrêté",
                                   "L'électrolyseur a été coupé automatiquement suite à l'arrêt de la pompe.")

    return {"id": eid, "state": payload.state}


async def _schedules_list():
    items = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute("SELECT id, start, end, enabled FROM schedules"):
            d = dict(row); d["enabled"] = bool(d["enabled"]); items.append(d)
    return items


@api_router.get("/schedule")
async def get_schedule():
    settings = await get_settings_dict()
    docs = await _schedules_list()
    total_h = 0.0
    for d in docs:
        if not d["enabled"]:
            continue
        sh, sm = map(int, d["start"].split(":"))
        eh, em = map(int, d["end"].split(":"))
        s = sh + sm / 60; e = eh + em / 60
        dur = (e - s) if e > s else (24 - s + e)
        total_h += dur
    recommended = compute_filtration_hours(sensor_state["temp"]["value"]) if settings.get("auto_filtration") else None
    return {
        "schedules": docs,
        "total_hours": round(total_h, 1),
        "recommended_hours": round(recommended, 1) if recommended is not None else None,
        "water_temp": sensor_state["temp"]["value"],
    }


@api_router.post("/schedule")
async def add_schedule(payload: Schedule):
    sid = str(uuid.uuid4())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("INSERT INTO schedules(id,start,end,enabled) VALUES(?,?,?,?)",
                         (sid, payload.start, payload.end, 1 if payload.enabled else 0))
        await db.commit()
    return {"id": sid, "start": payload.start, "end": payload.end, "enabled": payload.enabled}


@api_router.put("/schedule/{sid}")
async def update_schedule(sid: str, payload: Schedule):
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE schedules SET start=?, end=?, enabled=? WHERE id=?",
            (payload.start, payload.end, 1 if payload.enabled else 0, sid),
        )
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Not found")
    return {"ok": True}


@api_router.delete("/schedule/{sid}")
async def delete_schedule(sid: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM schedules WHERE id=?", (sid,))
        await db.commit()
    return {"ok": True}


@api_router.get("/settings")
async def api_get_settings():
    s = await get_settings_dict()
    s["id"] = "settings"
    return s


@api_router.put("/settings")
async def update_settings(payload: SettingsPayload):
    upd = {k: v for k, v in payload.dict().items() if v is not None}
    async with aiosqlite.connect(DB_PATH) as db:
        for k, v in upd.items():
            await db.execute(
                "INSERT INTO settings(key,value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v)),
            )
        await db.commit()
    s = await get_settings_dict()
    s["id"] = "settings"
    return s


@api_router.get("/alerts")
async def get_alerts(limit: int = 20):
    items = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute(
            "SELECT id, level, title, message, acknowledged, ts FROM alerts ORDER BY ts DESC LIMIT ?",
            (limit,),
        ):
            d = dict(row); d["acknowledged"] = bool(d["acknowledged"]); items.append(d)
    return {"alerts": items}


@api_router.post("/alerts/{aid}/ack")
async def ack_alert(aid: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE alerts SET acknowledged=1 WHERE id=?", (aid,))
        await db.commit()
    return {"ok": True}


@api_router.delete("/alerts")
async def clear_alerts():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM alerts")
        await db.commit()
    return {"ok": True}


@api_router.get("/system/status")
async def system_status():
    return {
        "zigbee": system_state["zigbee"],
        "mqtt": system_state["mqtt"],
        "sensors": system_state["sensors"],
        "mqtt_source": system_state["mqtt_source"],
        "last_update": _iso(system_state["last_update"]),
    }


async def _widgets_list():
    items = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute(
            "SELECT id, name, enabled, order_num FROM widgets ORDER BY order_num ASC"
        ):
            d = dict(row); d["enabled"] = bool(d["enabled"]); d["order"] = d.pop("order_num")
            items.append(d)
    return items


@api_router.get("/widgets")
async def get_widgets():
    return {"widgets": await _widgets_list()}


@api_router.put("/widgets/{wid}")
async def update_widget(wid: str, payload: WidgetConfig):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO widgets(id,name,enabled,order_num) VALUES(?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, order_num=excluded.order_num",
            (wid, payload.name, 1 if payload.enabled else 0, payload.order),
        )
        await db.commit()
    return {"ok": True}


@api_router.put("/widgets")
async def bulk_update_widgets(widgets: List[WidgetConfig]):
    async with aiosqlite.connect(DB_PATH) as db:
        for w in widgets:
            await db.execute(
                "INSERT INTO widgets(id,name,enabled,order_num) VALUES(?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, order_num=excluded.order_num",
                (w.id, w.name, 1 if w.enabled else 0, w.order),
            )
        await db.commit()
    return {"widgets": await _widgets_list()}


@api_router.get("/dashboard/summary")
async def dashboard_summary():
    settings = await get_settings_dict()
    settings["id"] = "settings"
    equipment_resp = await get_equipment()
    schedules = await _schedules_list()
    widgets = await _widgets_list()
    latest_alerts = []
    unresolved = 0
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT COUNT(*) FROM alerts WHERE acknowledged=0")
        unresolved = (await cur.fetchone())[0]
        async for row in await db.execute(
            "SELECT id, level, title, message, acknowledged, ts FROM alerts ORDER BY ts DESC LIMIT 5"
        ):
            d = dict(row); d["acknowledged"] = bool(d["acknowledged"]); latest_alerts.append(d)
    return {
        "sensors": [{"metric": m, **v} for m, v in sensor_state.items()],
        "equipment": equipment_resp["equipment"],
        "schedules": schedules,
        "widgets": widgets,
        "settings": settings,
        "alerts_open": unresolved,
        "latest_alerts": latest_alerts,
        "system": {
            "zigbee": system_state["zigbee"], "mqtt": system_state["mqtt"],
            "sensors": system_state["sensors"], "mqtt_source": system_state["mqtt_source"],
            "last_update": _iso(system_state["last_update"]),
        },
        "recommended_filtration_hours": round(compute_filtration_hours(sensor_state["temp"]["value"]), 1),
    }


# ==============================================================
# ZIGBEE DEVICES
# ==============================================================
class ZigbeeDeviceUpdate(BaseModel):
    friendly_name: Optional[str] = None
    assigned_role: Optional[str] = None


async def _zigbee_list():
    items = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute(
            "SELECT id, friendly_name, model, device_type, assigned_role, online, last_seen "
            "FROM zigbee_devices ORDER BY device_type ASC, friendly_name ASC"
        ):
            d = dict(row); d["online"] = bool(d["online"]); items.append(d)
    return items


@api_router.get("/zigbee/devices")
async def zigbee_devices():
    return {"devices": await _zigbee_list()}


@api_router.put("/zigbee/devices/{did}")
async def zigbee_device_update(did: str, payload: ZigbeeDeviceUpdate):
    upd = {k: v for k, v in payload.dict().items() if v is not None}
    if not upd:
        raise HTTPException(400, "Aucun champ à mettre à jour.")
    async with aiosqlite.connect(DB_PATH) as db:
        sets = ", ".join(f"{k}=?" for k in upd.keys())
        vals = list(upd.values()) + [did]
        cur = await db.execute(f"UPDATE zigbee_devices SET {sets} WHERE id=?", vals)
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Appareil introuvable.")
    return {"ok": True}


@api_router.post("/zigbee/devices/rescan")
async def zigbee_rescan():
    """When MQTT bridge is connected, forces a bridge/devices refresh.
    In simulator mode, returns the current list unchanged."""
    system_state["zigbee"] = "OK"
    return {"ok": True, "devices": await _zigbee_list()}


# ==============================================================
# SYSTEM UPDATE / EXIT KIOSK
# ==============================================================
def _write_update_state(state: str):
    try:
        UPDATE_STATE_FILE.write_text(state)
    except Exception as e:
        logger.warning("update state write failed: %s", e)


def _read_update_state() -> str:
    try:
        if UPDATE_STATE_FILE.exists():
            return UPDATE_STATE_FILE.read_text().strip() or "idle"
    except Exception:
        pass
    return "idle"


def _is_update_running() -> bool:
    global _update_proc
    return _update_proc is not None and _update_proc.poll() is None


def _spawn_update(mode: str):
    global _update_proc
    script = POOLKIOSK_HOME / "update.sh"
    if not script.exists():
        _write_update_state("failed")
        UPDATE_LOG.write_text(
            f"Script d'update introuvable : {script}\n"
            "Assurez-vous d'avoir la dernière version du dépôt sur le Raspberry."
        )
        return False
    UPDATE_LOG.write_text("")
    _write_update_state("running")
    _update_proc = subprocess.Popen(
        ["bash", str(script), mode],
        stdout=open(UPDATE_LOG, "a"), stderr=subprocess.STDOUT,
        cwd=str(POOLKIOSK_HOME),
        env={**os.environ, "POOLKIOSK_HOME": str(POOLKIOSK_HOME)},
        start_new_session=True,
    )
    return True


@api_router.get("/system/update/status")
async def update_status():
    log = ""
    if UPDATE_LOG.exists():
        try:
            log = UPDATE_LOG.read_text()[-4000:]
        except Exception:
            pass
    return {"state": _read_update_state(), "log": log}


@api_router.post("/system/update/online")
async def update_online():
    if _is_update_running():
        raise HTTPException(409, "Une mise à jour est déjà en cours.")
    if not _spawn_update("online"):
        raise HTTPException(500, "Script de mise à jour introuvable.")
    return {"ok": True, "state": "running"}


@api_router.post("/system/update/usb")
async def update_usb():
    if _is_update_running():
        raise HTTPException(409, "Une mise à jour est déjà en cours.")
    if not _spawn_update("usb"):
        raise HTTPException(500, "Script de mise à jour introuvable.")
    return {"ok": True, "state": "running"}


@api_router.post("/system/exit-kiosk")
async def exit_kiosk():
    try:
        subprocess.Popen(["pkill", "-f", "chromium"], start_new_session=True)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, f"Impossible de quitter le kiosque : {e}")


# ==============================================================
# APP LIFECYCLE
# ==============================================================
app.include_router(api_router)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.on_event("startup")
async def _startup():
    await init_db()
    asyncio.create_task(sensor_simulator_loop())
    start_mqtt_bridge()
    logger.info("Appli piscine backend ready. DB=%s", DB_PATH)


@app.on_event("shutdown")
async def _shutdown():
    logger.info("Bye.")
