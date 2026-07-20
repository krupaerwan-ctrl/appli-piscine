"""Pool Kiosk Backend - FastAPI + MongoDB + MQTT-ready sensor bridge.

Handles:
- Real-time sensor readings (simulated OR from Zigbee/MQTT bridge)
- Equipment state (pump, electrolyzer, heat pump, lights)
- Filtration scheduling with auto-calculation from water temperature
- Safety logic: auto-stop pump on pressure out-of-range
- Threshold settings, alerts, widget configuration
"""
from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import asyncio
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
UPDATE_LOG = Path("/tmp/poolkiosk_update.log")
UPDATE_STATE_FILE = Path("/tmp/poolkiosk_update_state.txt")
# Handle to the currently running update subprocess (None if idle/finished).
_update_proc: Optional[subprocess.Popen] = None
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Appli Piscine API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("pool")

# ==============================================================
# CONSTANTS / DEFAULTS
# ==============================================================
DEFAULT_SETTINGS = {
    "id": "settings",
    "temp_target": 28.0,
    "ph_min": 7.0,
    "ph_max": 7.4,
    "orp_min": 600,
    "orp_max": 750,
    "salinity_min": 3000,
    "salinity_max": 4000,
    "pressure_min": 0.5,       # bar
    "pressure_max": 1.5,       # bar - filter clogged
    "pressure_auto_cutoff": True,
    "auto_filtration": True,   # compute filtration hours from temperature
    "screen_sleep_minutes": 5,
}

DEFAULT_EQUIPMENT = [
    {"id": "filtration", "name": "Filtration", "icon": "engine", "state": True, "auto_managed": True},
    {"id": "electrolyseur", "name": "Électrolyseur", "icon": "flash", "state": True, "auto_managed": False},
    {"id": "heat_pump", "name": "Pompe à chaleur", "icon": "fire", "state": False, "auto_managed": False},
    {"id": "lighting", "name": "Éclairage", "icon": "bulb", "state": False, "auto_managed": False},
]

DEFAULT_SCHEDULES = [
    {"id": str(uuid.uuid4()), "start": "08:00", "end": "12:00", "enabled": True},
    {"id": str(uuid.uuid4()), "start": "14:00", "end": "18:00", "enabled": True},
    {"id": str(uuid.uuid4()), "start": "22:00", "end": "06:00", "enabled": True},
]

DEFAULT_WIDGETS = [
    {"id": "temp", "name": "Température de l'eau", "enabled": True, "order": 1},
    {"id": "ph", "name": "pH", "enabled": True, "order": 2},
    {"id": "orp", "name": "Redox (ORP)", "enabled": True, "order": 3},
    {"id": "salinity", "name": "Sel (Salinité)", "enabled": True, "order": 4},
    {"id": "history", "name": "Historique température 24h", "enabled": True, "order": 5},
    {"id": "pressure", "name": "Pression / Niveau", "enabled": True, "order": 6},
    {"id": "equipment", "name": "Équipements", "enabled": True, "order": 7},
    {"id": "schedule", "name": "Programmation filtration", "enabled": True, "order": 8},
    {"id": "system", "name": "État système", "enabled": True, "order": 9},
    {"id": "alerts", "name": "Alertes", "enabled": True, "order": 10},
]

# ==============================================================
# MODELS
# ==============================================================
class SensorReading(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    metric: str
    value: float
    unit: str
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class EquipmentToggle(BaseModel):
    state: bool


class Schedule(BaseModel):
    id: Optional[str] = None
    start: str
    end: str
    enabled: bool = True


class Alert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    level: str  # info, warning, error
    title: str
    message: str
    acknowledged: bool = False
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
def _strip_id(doc: Optional[dict]) -> Optional[dict]:
    if doc is None:
        return None
    doc.pop("_id", None)
    return doc


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat()


def compute_filtration_hours(water_temp: float) -> float:
    """Rule: filtration hours = water temp / 2 (classic pool rule).
    Clamped 4h..24h."""
    return max(4.0, min(24.0, water_temp / 2.0))


async def init_defaults():
    if not await db.settings.find_one({"id": "settings"}):
        await db.settings.insert_one(DEFAULT_SETTINGS.copy())
    if await db.equipment.count_documents({}) == 0:
        await db.equipment.insert_many([e.copy() for e in DEFAULT_EQUIPMENT])
    if await db.schedules.count_documents({}) == 0:
        await db.schedules.insert_many([s.copy() for s in DEFAULT_SCHEDULES])
    if await db.widgets.count_documents({}) == 0:
        await db.widgets.insert_many([w.copy() for w in DEFAULT_WIDGETS])
    # Seed 24h of temperature history so the chart is populated immediately
    if await db.readings.count_documents({"metric": "temp"}) == 0:
        now = datetime.now(timezone.utc)
        docs = []
        for i in range(24 * 6):  # 10-minute points over 24h
            t = now - timedelta(minutes=(24 * 6 - i) * 10)
            # daily wave 24..28°C
            v = 26 + 2 * math.sin((t.hour + t.minute / 60) / 24 * 2 * math.pi - math.pi / 2)
            docs.append({
                "id": str(uuid.uuid4()),
                "metric": "temp",
                "value": round(v, 2),
                "unit": "°C",
                "ts": t,
            })
        await db.readings.insert_many(docs)


# ==============================================================
# SENSOR STATE (live in-memory + persisted periodically)
# ==============================================================
sensor_state: Dict[str, Any] = {
    "temp": {"value": 26.4, "unit": "°C"},
    "ph": {"value": 7.2, "unit": ""},
    "orp": {"value": 650, "unit": "mV"},
    "salinity": {"value": 3500, "unit": "ppm"},
    "pressure": {"value": 0.9, "unit": "bar"},
    "outdoor_temp": {"value": 28, "unit": "°C"},
}

system_state: Dict[str, Any] = {
    "zigbee": "OK",
    "mqtt": "OK",
    "sensors": "OK",
    "mqtt_source": "simulator",   # or "broker"
    "last_update": datetime.now(timezone.utc),
}


async def create_alert(level: str, title: str, message: str):
    alert = Alert(level=level, title=title, message=message)
    await db.alerts.insert_one(alert.dict())
    logger.warning("ALERT [%s] %s - %s", level, title, message)


async def safety_check():
    """Auto-cutoff filtration pump if pressure out of range."""
    settings = _strip_id(await db.settings.find_one({"id": "settings"})) or DEFAULT_SETTINGS
    if not settings.get("pressure_auto_cutoff", True):
        return
    p = sensor_state["pressure"]["value"]
    pmin, pmax = settings["pressure_min"], settings["pressure_max"]
    pump = await db.equipment.find_one({"id": "filtration"})
    if not pump or not pump.get("state"):
        return
    if p < pmin:
        await db.equipment.update_one({"id": "filtration"}, {"$set": {"state": False}})
        await create_alert("error", "Pompe arrêtée", f"Pression trop basse ({p:.2f} bar < {pmin} bar). Filtration coupée automatiquement.")
    elif p > pmax:
        await db.equipment.update_one({"id": "filtration"}, {"$set": {"state": False}})
        await create_alert("error", "Pompe arrêtée", f"Pression trop haute ({p:.2f} bar > {pmax} bar). Filtre probablement bouché.")


async def sensor_simulator_loop():
    """Runs in background. Simulates realistic sensor drift & persists history."""
    tick = 0
    while True:
        try:
            # Random walk simulation
            sensor_state["temp"]["value"] = round(max(18, min(32, sensor_state["temp"]["value"] + random.uniform(-0.15, 0.15))), 2)
            sensor_state["ph"]["value"] = round(max(6.5, min(8.0, sensor_state["ph"]["value"] + random.uniform(-0.02, 0.02))), 2)
            sensor_state["orp"]["value"] = int(max(400, min(900, sensor_state["orp"]["value"] + random.uniform(-8, 8))))
            sensor_state["salinity"]["value"] = int(max(2500, min(4500, sensor_state["salinity"]["value"] + random.uniform(-15, 15))))
            sensor_state["pressure"]["value"] = round(max(0.2, min(1.8, sensor_state["pressure"]["value"] + random.uniform(-0.03, 0.03))), 2)
            system_state["last_update"] = datetime.now(timezone.utc)

            # Persist every ~10 sec
            if tick % 5 == 0:
                now = datetime.now(timezone.utc)
                docs = [
                    {"id": str(uuid.uuid4()), "metric": m, "value": float(sensor_state[m]["value"]),
                     "unit": sensor_state[m]["unit"], "ts": now}
                    for m in ("temp", "ph", "orp", "salinity", "pressure")
                ]
                await db.readings.insert_many(docs)
                # prune older than 7 days
                cutoff = now - timedelta(days=7)
                await db.readings.delete_many({"ts": {"$lt": cutoff}})

            await safety_check()
        except Exception as exc:
            logger.exception("simulator loop error: %s", exc)
        tick += 1
        await asyncio.sleep(2)


# ==============================================================
# OPTIONAL MQTT BRIDGE (activates only if MQTT_BROKER env set)
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
        # topic format: pool/<metric>  payload: numeric string
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
        "readings": [
            {"metric": m, **v} for m, v in sensor_state.items()
        ],
        "ts": _iso(system_state["last_update"]),
    }


@api_router.get("/sensors/history")
async def sensors_history(metric: str = "temp", hours: int = 24):
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    cursor = db.readings.find(
        {"metric": metric, "ts": {"$gte": since}}, {"_id": 0}
    ).sort("ts", 1)
    items = await cursor.to_list(length=5000)
    for it in items:
        if isinstance(it.get("ts"), datetime):
            it["ts"] = _iso(it["ts"])
    return {"metric": metric, "hours": hours, "points": items}


@api_router.get("/equipment")
async def get_equipment():
    docs = await db.equipment.find({}, {"_id": 0}).to_list(50)
    return {"equipment": docs}


@api_router.post("/equipment/{eid}/toggle")
async def toggle_equipment(eid: str, payload: EquipmentToggle):
    res = await db.equipment.find_one_and_update(
        {"id": eid}, {"$set": {"state": payload.state}}
    )
    if not res:
        raise HTTPException(404, "Equipment not found")
    return {"id": eid, "state": payload.state}


@api_router.get("/schedule")
async def get_schedule():
    settings = _strip_id(await db.settings.find_one({"id": "settings"})) or DEFAULT_SETTINGS
    docs = await db.schedules.find({}, {"_id": 0}).to_list(50)
    total_h = 0.0
    for d in docs:
        if not d.get("enabled"):
            continue
        sh, sm = map(int, d["start"].split(":"))
        eh, em = map(int, d["end"].split(":"))
        s = sh + sm / 60
        e = eh + em / 60
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
    doc = payload.dict()
    doc["id"] = str(uuid.uuid4())
    await db.schedules.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.put("/schedule/{sid}")
async def update_schedule(sid: str, payload: Schedule):
    upd = {k: v for k, v in payload.dict().items() if v is not None and k != "id"}
    r = await db.schedules.update_one({"id": sid}, {"$set": upd})
    if r.matched_count == 0:
        raise HTTPException(404, "Not found")
    return {"ok": True}


@api_router.delete("/schedule/{sid}")
async def delete_schedule(sid: str):
    await db.schedules.delete_one({"id": sid})
    return {"ok": True}


@api_router.get("/settings")
async def get_settings():
    doc = _strip_id(await db.settings.find_one({"id": "settings"})) or DEFAULT_SETTINGS
    return doc


@api_router.put("/settings")
async def update_settings(payload: SettingsPayload):
    upd = {k: v for k, v in payload.dict().items() if v is not None}
    await db.settings.update_one({"id": "settings"}, {"$set": upd}, upsert=True)
    doc = _strip_id(await db.settings.find_one({"id": "settings"}))
    return doc


@api_router.get("/alerts")
async def get_alerts(limit: int = 20):
    docs = await db.alerts.find({}, {"_id": 0}).sort("ts", -1).to_list(limit)
    for d in docs:
        if isinstance(d.get("ts"), datetime):
            d["ts"] = _iso(d["ts"])
    return {"alerts": docs}


@api_router.post("/alerts/{aid}/ack")
async def ack_alert(aid: str):
    await db.alerts.update_one({"id": aid}, {"$set": {"acknowledged": True}})
    return {"ok": True}


@api_router.delete("/alerts")
async def clear_alerts():
    await db.alerts.delete_many({})
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


@api_router.get("/widgets")
async def get_widgets():
    docs = await db.widgets.find({}, {"_id": 0}).sort("order", 1).to_list(50)
    return {"widgets": docs}


@api_router.put("/widgets/{wid}")
async def update_widget(wid: str, payload: WidgetConfig):
    upd = payload.dict()
    upd.pop("id", None)
    await db.widgets.update_one({"id": wid}, {"$set": upd}, upsert=True)
    return {"ok": True}


@api_router.put("/widgets")
async def bulk_update_widgets(widgets: List[WidgetConfig]):
    for w in widgets:
        d = w.dict()
        wid = d.pop("id")
        await db.widgets.update_one({"id": wid}, {"$set": d}, upsert=True)
    docs = await db.widgets.find({}, {"_id": 0}).sort("order", 1).to_list(50)
    return {"widgets": docs}


@api_router.get("/dashboard/summary")
async def dashboard_summary():
    """Single endpoint the dashboard polls to get everything at once."""
    settings = _strip_id(await db.settings.find_one({"id": "settings"})) or DEFAULT_SETTINGS
    equipment = await db.equipment.find({}, {"_id": 0}).to_list(50)
    schedules = await db.schedules.find({}, {"_id": 0}).to_list(50)
    widgets = await db.widgets.find({}, {"_id": 0}).sort("order", 1).to_list(50)
    unresolved = await db.alerts.count_documents({"acknowledged": False})
    latest_alerts = await db.alerts.find({}, {"_id": 0}).sort("ts", -1).to_list(5)
    for a in latest_alerts:
        if isinstance(a.get("ts"), datetime):
            a["ts"] = _iso(a["ts"])
    return {
        "sensors": [{"metric": m, **v} for m, v in sensor_state.items()],
        "equipment": equipment,
        "schedules": schedules,
        "widgets": widgets,
        "settings": settings,
        "alerts_open": unresolved,
        "latest_alerts": latest_alerts,
        "system": {
            "zigbee": system_state["zigbee"],
            "mqtt": system_state["mqtt"],
            "sensors": system_state["sensors"],
            "mqtt_source": system_state["mqtt_source"],
            "last_update": _iso(system_state["last_update"]),
        },
        "recommended_filtration_hours": round(compute_filtration_hours(sensor_state["temp"]["value"]), 1),
    }


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
        stdout=open(UPDATE_LOG, "a"),
        stderr=subprocess.STDOUT,
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
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup():
    await init_defaults()
    asyncio.create_task(sensor_simulator_loop())
    start_mqtt_bridge()
    logger.info("Appli piscine backend ready.")


@app.on_event("shutdown")
async def _shutdown():
    client.close()
