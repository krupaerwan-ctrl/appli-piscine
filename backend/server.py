"""Appli Piscine Backend - FastAPI + SQLite + MQTT-ready sensor bridge.

Rewritten to use SQLite (zero deps, no Docker) — perfectly sized for Raspberry Pi.
"""
from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import aiosqlite
import httpx
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
# Main asyncio loop reference — captured on startup so background threads
# (paho-mqtt on_message) can schedule coroutines back onto the app loop.
_main_loop: Optional[asyncio.AbstractEventLoop] = None
load_dotenv(ROOT_DIR / ".env")

app = FastAPI(title="Appli Piscine API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("pool")

# ==============================================================
# EMERGENT PUSH NOTIFICATIONS (SuprSend relay)
# ==============================================================
PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": PUSH_KEY},
    timeout=10.0,
)


async def _list_push_subscribers() -> List[str]:
    """Return all enrolled device user_ids (one per phone that registered)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await (await db.execute(
            "SELECT DISTINCT user_id FROM push_subscribers"
        )).fetchall()
        return [r["user_id"] for r in rows]


async def send_push(
    data: Dict[str, Any],
    recipients: Optional[List[str]] = None,
    idempotency_key: Optional[str] = None,
) -> None:
    """Send a push notification to all subscribed devices (or a subset).
    Non-blocking on failure — the caller's flow must never be interrupted."""
    try:
        if recipients is None:
            recipients = await _list_push_subscribers()
        if not recipients:
            return
        if "title" not in data or "message" not in data:
            raise ValueError("push data must include title and message")
        # SuprSend limits to 100 recipients per call — chunk if needed
        for i in range(0, len(recipients), 100):
            chunk = recipients[i : i + 100]
            payload: Dict[str, Any] = {"recipients": chunk, "data": data}
            if idempotency_key:
                payload["$idempotency_key"] = f"{idempotency_key}-{i}"
            resp = await _push_client.post("/api/v1/push/trigger", json=payload)
            if resp.status_code == 401:
                logger.warning("EMERGENT_PUSH_KEY missing/invalid — skipping push")
                return
            if resp.status_code >= 400:
                logger.warning(
                    "Push relay returned %s: %s",
                    resp.status_code, resp.text[:200],
                )
                return
        logger.info("Push sent: %s → %d recipient(s)", data.get("title"), len(recipients))
    except Exception as exc:
        # Never bubble — push must be fire-and-forget
        logger.warning("Push notification failed (non-blocking): %s", exc)


def push_bg(data: Dict[str, Any], idempotency_key: Optional[str] = None):
    """Fire-and-forget push. Safe to call from any coroutine."""
    try:
        asyncio.create_task(send_push(data, idempotency_key=idempotency_key))
    except RuntimeError:
        # No running loop (rare) — swallow silently
        pass


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
    "pump_manual_override": False,
    "auto_schedule_last_date": "",
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
    {"id": "pump", "name": "Contrôle pompe", "enabled": 1, "order_num": 0},
    {"id": "temp", "name": "Température de l'eau", "enabled": 1, "order_num": 1},
    {"id": "ph", "name": "pH", "enabled": 1, "order_num": 2},
    {"id": "orp", "name": "Redox (ORP)", "enabled": 1, "order_num": 3},
    {"id": "salinity", "name": "Sel (Salinité)", "enabled": 1, "order_num": 4},
    {"id": "history", "name": "Historique température 24h", "enabled": 1, "order_num": 5},
    {"id": "pressure", "name": "Pression / Niveau", "enabled": 1, "order_num": 6},
    {"id": "equipment", "name": "Équipements", "enabled": 1, "order_num": 7},
    {"id": "schedule", "name": "Programmation filtration", "enabled": 1, "order_num": 8},
    {"id": "maintenance", "name": "Rappels de maintenance", "enabled": 1, "order_num": 9},
    {"id": "system", "name": "État système", "enabled": 1, "order_num": 10},
    {"id": "alerts", "name": "Alertes", "enabled": 1, "order_num": 11},
]

DEFAULT_MAINTENANCE_TASKS = [
    {"id": "filter_cleaning", "name": "Nettoyage du filtre",
     "icon": "sparkles-outline", "interval_days": 30},
    {"id": "backwash", "name": "Contre-lavage (backwash)",
     "icon": "sync", "interval_days": 7},
    {"id": "chlorine_check", "name": "Vérification du chlore",
     "icon": "flask", "interval_days": 3},
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
    pump_manual_override: Optional[bool] = None


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

        CREATE TABLE IF NOT EXISTS equipment_events (
            id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL,
            action TEXT NOT NULL, source TEXT NOT NULL,
            reason TEXT, ts TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_equip_events_ts ON equipment_events(ts);

        CREATE TABLE IF NOT EXISTS maintenance_tasks (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
            interval_days INTEGER NOT NULL DEFAULT 30,
            last_done_at TEXT, enabled INTEGER NOT NULL DEFAULT 1,
            notified_at TEXT
        );

        CREATE TABLE IF NOT EXISTS push_subscribers (
            user_id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            device_token TEXT NOT NULL,
            registered_at TEXT NOT NULL
        );
        """)
        await db.commit()

        # Column migration: add water_temp to equipment_events on existing DBs
        cur = await db.execute("PRAGMA table_info(equipment_events)")
        cols = {row[1] async for row in cur}
        if "water_temp" not in cols:
            try:
                await db.execute("ALTER TABLE equipment_events ADD COLUMN water_temp REAL")
                await db.commit()
            except Exception as e:
                logger.warning("add water_temp column failed: %s", e)

        # Column migration: add notified_at to maintenance_tasks on existing DBs
        cur = await db.execute("PRAGMA table_info(maintenance_tasks)")
        cols_m = {row[1] async for row in cur}
        if "notified_at" not in cols_m:
            try:
                await db.execute("ALTER TABLE maintenance_tasks ADD COLUMN notified_at TEXT")
                await db.commit()
            except Exception as e:
                logger.warning("add notified_at column failed: %s", e)

        # Column migration: add battery + lqi to zigbee_devices
        cur = await db.execute("PRAGMA table_info(zigbee_devices)")
        cols_z = {row[1] async for row in cur}
        for col, decl in (("battery", "INTEGER"), ("lqi", "INTEGER")):
            if col not in cols_z:
                try:
                    await db.execute(f"ALTER TABLE zigbee_devices ADD COLUMN {col} {decl}")
                    await db.commit()
                except Exception as e:
                    logger.warning("add %s column failed: %s", col, e)

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
        else:
            # Migration: ensure any newly-added default widgets exist for existing DBs
            for w in DEFAULT_WIDGETS:
                await db.execute(
                    "INSERT OR IGNORE INTO widgets(id,name,enabled,order_num) VALUES(?,?,?,?)",
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
        # Seed default maintenance tasks (idempotent)
        for t in DEFAULT_MAINTENANCE_TASKS:
            await db.execute(
                "INSERT OR IGNORE INTO maintenance_tasks(id,name,icon,interval_days,last_done_at,enabled) "
                "VALUES(?,?,?,?,NULL,1)",
                (t["id"], t["name"], t["icon"], t["interval_days"]),
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
    # Push every new alert (level = "error" or "warning") to registered phones
    icon = "🚨" if level == "error" else "⚠️"
    push_bg({
        "title": f"{icon} {title}",
        "message": message,
        "action_url": "/",
    })


async def log_equipment_event(equipment_id: str, action: str, source: str, reason: Optional[str] = None):
    """Log every ON/OFF change to the equipment_events journal, capturing the
    current water temperature at that moment for later analysis."""
    try:
        water_temp = float(sensor_state.get("temp", {}).get("value") or 0.0)
    except Exception:
        water_temp = None
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO equipment_events(id,equipment_id,action,source,reason,ts,water_temp) "
            "VALUES(?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), equipment_id, action, source, reason,
             _iso(datetime.now(timezone.utc)), water_temp),
        )
        await db.commit()

    # ---- Push notification: pump start/stop ----
    if equipment_id == "filtration" and action in ("on", "off"):
        icon = "▶️" if action == "on" else "⏹️"
        title = f"{icon} Pompe {'démarrée' if action == 'on' else 'arrêtée'}"
        source_label = {
            "user": "Commande manuelle",
            "scheduler": "Planning automatique",
            "safety": "Sécurité",
            "coupling": "Couplage automatique",
        }.get(source, source)
        body = f"{source_label}"
        if water_temp:
            body += f"  ·  Eau {water_temp:.1f}°C"
        push_bg({
            "title": title,
            "message": body,
            "subtext": reason or "",
            "action_url": "/",
        })


async def _set_setting(key: str, value: Any):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        await db.commit()


# -------- Pump runtime & schedule helpers --------
def _today_start_utc() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def _week_start_utc() -> datetime:
    now = datetime.now(timezone.utc)
    monday = now - timedelta(days=now.weekday())
    return monday.replace(hour=0, minute=0, second=0, microsecond=0)


async def _compute_runtime_hours(equipment_id: str, since: datetime) -> float:
    """Compute total ON hours for an equipment since a UTC datetime.
    Uses equipment_events plus the current state to cover the open interval."""
    now = datetime.now(timezone.utc)
    since_iso = _iso(since)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # State immediately before `since`: use last event before that.
        cur = await db.execute(
            "SELECT action FROM equipment_events "
            "WHERE equipment_id=? AND ts < ? ORDER BY ts DESC LIMIT 1",
            (equipment_id, since_iso),
        )
        row = await cur.fetchone()
        state_at_since = (row["action"] == "on") if row else False

        cur = await db.execute(
            "SELECT action, ts FROM equipment_events "
            "WHERE equipment_id=? AND ts >= ? ORDER BY ts ASC",
            (equipment_id, since_iso),
        )
        events = [dict(r) for r in await cur.fetchall()]

    total_sec = 0.0
    cur_state = state_at_since
    cur_ts = since
    for e in events:
        try:
            ts = datetime.fromisoformat(e["ts"].replace("Z", "+00:00"))
        except Exception:
            continue
        if cur_state:
            total_sec += (ts - cur_ts).total_seconds()
        cur_state = (e["action"] == "on")
        cur_ts = ts
    if cur_state:
        total_sec += (now - cur_ts).total_seconds()
    return round(max(0.0, total_sec) / 3600.0, 2)


def _time_str_to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _minute_in_schedule(minute: int, schedules: List[Dict[str, Any]]) -> bool:
    """Return True if the given minute-of-day falls within any enabled slot.
    Handles wrap-around slots like 22:00 → 06:00."""
    for s in schedules:
        if not s.get("enabled"):
            continue
        start_m = _time_str_to_minutes(s["start"])
        end_m = _time_str_to_minutes(s["end"])
        if start_m == end_m:
            continue
        if start_m < end_m:
            if start_m <= minute < end_m:
                return True
        else:
            # Wrap-around: e.g. 22:00 → 06:00
            if minute >= start_m or minute < end_m:
                return True
    return False


def _distribute_hours_into_slots(total_hours: float) -> List[Dict[str, Any]]:
    """Turn a daily runtime (hours) into 1-3 non-overlapping slots.
    Rule of thumb (pool best practice):
      • split around solar noon (10-16h): main slot covers the warmest hours,
      • add early-morning / late-evening slots for longer runtimes.
    Always returns tuples in ascending order."""
    h = max(0.0, min(24.0, float(total_hours)))
    if h <= 0.1:
        return []
    slots: List[Dict[str, Any]] = []
    if h <= 6:
        # Single slot centered on solar noon (13:00)
        half = h / 2
        start = 13 - half
        end = 13 + half
        slots.append({"start": _fmt_hh(start), "end": _fmt_hh(end), "enabled": True})
    elif h <= 12:
        # Two slots: morning + afternoon
        morning = h * 0.4
        afternoon = h - morning
        slots.append({"start": _fmt_hh(9 - morning / 2), "end": _fmt_hh(9 + morning / 2), "enabled": True})
        slots.append({"start": _fmt_hh(15 - afternoon / 2), "end": _fmt_hh(15 + afternoon / 2), "enabled": True})
    else:
        # Three slots: morning + midday + evening
        third = h / 3
        # Morning around 08:00, midday around 13:00, evening around 20:00
        slots.append({"start": _fmt_hh(8 - third / 2), "end": _fmt_hh(8 + third / 2), "enabled": True})
        slots.append({"start": _fmt_hh(14 - third / 2), "end": _fmt_hh(14 + third / 2), "enabled": True})
        slots.append({"start": _fmt_hh(20 - third / 2), "end": _fmt_hh(20 + third / 2), "enabled": True})
    return slots


def _fmt_hh(h_float: float) -> str:
    """Convert float hours (e.g. 8.5) to HH:MM. Handles negatives / >24 by wrapping."""
    h = h_float % 24
    hh = int(h)
    mm = int(round((h - hh) * 60))
    if mm == 60:
        hh = (hh + 1) % 24
        mm = 0
    return f"{hh:02d}:{mm:02d}"


async def _apply_auto_schedule(reason: str = "auto"):
    """Recompute filtration schedules from current water temperature (temp/2 rule)."""
    temp = float(sensor_state.get("temp", {}).get("value") or 26.0)
    hours = compute_filtration_hours(temp)
    slots = _distribute_hours_into_slots(hours)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM schedules")
        for s in slots:
            await db.execute(
                "INSERT INTO schedules(id,start,end,enabled) VALUES(?,?,?,?)",
                (str(uuid.uuid4()), s["start"], s["end"], 1 if s["enabled"] else 0),
            )
        await db.commit()
    today = datetime.now(timezone.utc).date().isoformat()
    await _set_setting("auto_schedule_last_date", today)
    logger.info(
        "Auto-schedule applied (%s): temp=%.1f°C → %.1fh over %d slot(s)",
        reason, temp, hours, len(slots),
    )
    return {"water_temp": temp, "hours": round(hours, 1), "slots": slots}


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

    temp_val = sensor_state["temp"]["value"]
    target = float(settings.get("temp_target", 28.0))
    # Warn if temperature drifts more than 4°C from target (soft) or 6°C (hard)
    t_min = target - 6.0
    t_max = target + 6.0
    await check("TEMP", temp_val, t_min, t_max, "°C",
                f"Eau à {temp_val:.1f}°C — commence à baisser sous la cible ({target:.0f}°C).",
                f"Eau à {temp_val:.1f}°C — commence à dépasser la cible ({target:.0f}°C).",
                f"Eau trop froide ({temp_val:.1f}°C < {t_min:.0f}°C). Vérifier la PAC.",
                f"Eau trop chaude ({temp_val:.1f}°C > {t_max:.0f}°C). Réduire le chauffage.")


async def _stop_electrolyseur_and_pump(reason_pump: str):
    """Stop electrolyseur FIRST, then pump. Used by safety cut-offs."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE equipment SET state=0 WHERE id='electrolyseur'")
        await db.execute("UPDATE equipment SET state=0 WHERE id='filtration'")
        await db.commit()
    await log_equipment_event("electrolyseur", "off", "safety", reason_pump)
    await log_equipment_event("filtration", "off", "safety", reason_pump)
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


async def pump_scheduler_loop():
    """Enforce filtration schedules every minute.
    Turns the pump ON/OFF according to programmed slots UNLESS:
      • auto_filtration is disabled, or
      • pump_manual_override is enabled (user forced state)."""
    # Give the DB / sensors ~10 s to warm up
    await asyncio.sleep(10)
    while True:
        try:
            settings = await get_settings_dict()
            if not settings.get("auto_filtration", True):
                await asyncio.sleep(30)
                continue
            if settings.get("pump_manual_override"):
                await asyncio.sleep(30)
                continue

            # Get schedules + current pump state
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                cur = await db.execute("SELECT id, start, end, enabled FROM schedules")
                scheds = [dict(r) for r in await cur.fetchall()]
                cur = await db.execute("SELECT state FROM equipment WHERE id='filtration'")
                r = await cur.fetchone()
                pump_state = bool(r["state"]) if r else False

            # Local time (Pi is expected to run in the customer's timezone)
            now_local = datetime.now()
            minute_of_day = now_local.hour * 60 + now_local.minute
            desired_state = _minute_in_schedule(minute_of_day, scheds)

            if desired_state != pump_state:
                async with aiosqlite.connect(DB_PATH) as db:
                    await db.execute(
                        "UPDATE equipment SET state=? WHERE id='filtration'",
                        (1 if desired_state else 0,),
                    )
                    if not desired_state:
                        # Coupling rule: pump OFF ⇒ electrolyseur OFF
                        await db.execute(
                            "UPDATE equipment SET state=0 WHERE id='electrolyseur'"
                        )
                    await db.commit()
                await log_equipment_event(
                    "filtration", "on" if desired_state else "off", "scheduler",
                    "Créneau programmé",
                )
                if not desired_state:
                    await log_equipment_event(
                        "electrolyseur", "off", "coupling",
                        "Arrêt automatique suite au créneau de fin de filtration",
                    )
                logger.info("Scheduler → filtration=%s", desired_state)
        except Exception as exc:
            logger.exception("pump scheduler loop error: %s", exc)
        await asyncio.sleep(30)


async def auto_schedule_daily_loop():
    """Recompute filtration schedules from water temperature once per day
    (target time: 03:00 local). Idempotent — never runs twice for the same date."""
    await asyncio.sleep(30)  # let backend settle
    while True:
        try:
            settings = await get_settings_dict()
            if not settings.get("auto_filtration", True):
                await asyncio.sleep(1800)
                continue
            now_local = datetime.now()
            today = now_local.date().isoformat()
            last = settings.get("auto_schedule_last_date") or ""
            # Run at 03:00 or later, once per day
            if last != today and now_local.hour >= 3:
                await _apply_auto_schedule("daily")
        except Exception as exc:
            logger.exception("auto schedule loop error: %s", exc)
        await asyncio.sleep(1800)  # check every 30 min


async def maintenance_reminder_loop():
    """Every 30 min, push a notification once per task the first time it becomes overdue."""
    await asyncio.sleep(60)
    while True:
        try:
            tasks = await _list_maintenance()
            async with aiosqlite.connect(DB_PATH) as db:
                for t in tasks:
                    if not t.get("enabled") or not t.get("is_overdue"):
                        continue
                    # Only push if we haven't notified yet for this due cycle.
                    # Reset happens via mark_maintenance_done (clears notified_at).
                    if t.get("notified_at"):
                        continue
                    push_bg({
                        "title": "🛠️ Rappel maintenance",
                        "message": f"{t['name']} : à faire dès maintenant.",
                        "action_url": "/",
                    }, idempotency_key=f"maint-{t['id']}-{t.get('next_due_at','')}")
                    await db.execute(
                        "UPDATE maintenance_tasks SET notified_at=? WHERE id=?",
                        (_iso(datetime.now(timezone.utc)), t["id"]),
                    )
                await db.commit()
        except Exception as exc:
            logger.exception("maintenance reminder loop error: %s", exc)
        await asyncio.sleep(1800)


async def permit_join_watchdog_loop():
    """Tick every 1s to detect when the pairing window expires and
    clear the flag/notify the frontend accordingly."""
    while True:
        try:
            until = zigbee_bridge_state.get("permit_join_until")
            if zigbee_bridge_state.get("permit_join") and until:
                try:
                    end = datetime.fromisoformat(until.replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) >= end:
                        zigbee_bridge_state["permit_join"] = False
                        zigbee_bridge_state["permit_join_until"] = None
                except Exception:
                    zigbee_bridge_state["permit_join"] = False
                    zigbee_bridge_state["permit_join_until"] = None
        except Exception as exc:
            logger.exception("permit_join watchdog error: %s", exc)
        await asyncio.sleep(1)


# ==============================================================
# OPTIONAL MQTT BRIDGE
# ==============================================================
# Global MQTT client (paho-mqtt) so we can also PUBLISH (permit_join, remove…)
_mqtt_client: Any = None
# In-memory pairing state (updated by MQTT + endpoints)
zigbee_bridge_state: Dict[str, Any] = {
    "broker_connected": False,
    "broker_host": None,
    "broker_port": None,
    "permit_join": False,
    "permit_join_until": None,   # ISO string
    "last_bridge_state": None,   # "online" | "offline"
}


def _z2m_topic(sub: str) -> str:
    """Build a topic under the configured Zigbee2MQTT base (default 'zigbee2mqtt')."""
    base = os.environ.get("Z2M_BASE_TOPIC", "zigbee2mqtt").strip("/")
    return f"{base}/{sub}" if sub else base


def _mqtt_publish(topic: str, payload: Any):
    """Publish a JSON payload to MQTT. Silent no-op if bridge is offline."""
    if _mqtt_client is None:
        raise RuntimeError("mqtt-not-configured")
    body = payload if isinstance(payload, str) else json.dumps(payload)
    _mqtt_client.publish(topic, body)


def start_mqtt_bridge():
    global _mqtt_client
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
    z2m_base = _z2m_topic("")

    zigbee_bridge_state["broker_host"] = broker
    zigbee_bridge_state["broker_port"] = port

    def on_connect(c, u, f, rc, *_):
        logger.info("MQTT connected rc=%s", rc)
        # Legacy custom pool topics
        c.subscribe(f"{topic_prefix}/#")
        # Zigbee2MQTT admin topics
        c.subscribe(f"{z2m_base}/bridge/state")
        c.subscribe(f"{z2m_base}/bridge/devices")
        c.subscribe(f"{z2m_base}/bridge/response/#")
        c.subscribe(f"{z2m_base}/bridge/log")
        # All device data messages (pH sonoff, temp, relay states…)
        c.subscribe(f"{z2m_base}/+")
        c.subscribe(f"{z2m_base}/+/#")
        system_state["mqtt"] = "OK"
        system_state["mqtt_source"] = "broker"
        zigbee_bridge_state["broker_connected"] = True

    def on_disconnect(c, u, rc, *_):
        logger.warning("MQTT disconnected rc=%s", rc)
        zigbee_bridge_state["broker_connected"] = False

    def on_message(_c, _u, msg):
        try:
            topic = msg.topic
            # ---- Zigbee2MQTT bridge state ----
            if topic == f"{z2m_base}/bridge/state":
                try:
                    p = json.loads(msg.payload.decode())
                    st = p.get("state") if isinstance(p, dict) else p
                except Exception:
                    st = msg.payload.decode()
                zigbee_bridge_state["last_bridge_state"] = str(st)
                return
            # ---- Full device inventory (fired at every join/leave) ----
            if topic == f"{z2m_base}/bridge/devices":
                try:
                    devices = json.loads(msg.payload.decode())
                    asyncio.run_coroutine_threadsafe(
                        _sync_z2m_devices(devices), _main_loop
                    )
                except Exception as e:
                    logger.warning("device inventory parse failed: %s", e)
                return
            # ---- Pairing / permit_join events ----
            if topic.startswith(f"{z2m_base}/bridge/response/permit_join"):
                try:
                    p = json.loads(msg.payload.decode())
                    if p.get("status") == "ok":
                        val = (p.get("data") or {}).get("value")
                        if val:
                            zigbee_bridge_state["permit_join"] = True
                        else:
                            zigbee_bridge_state["permit_join"] = False
                            zigbee_bridge_state["permit_join_until"] = None
                except Exception:
                    pass
                return
            # ---- Legacy pool/<metric> topics ----
            if topic.startswith(f"{topic_prefix}/"):
                metric = topic.split("/")[-1]
                if metric in sensor_state:
                    try:
                        sensor_state[metric]["value"] = float(msg.payload.decode())
                        system_state["last_update"] = datetime.now(timezone.utc)
                    except Exception:
                        pass
                return
            # ---- Individual Zigbee device data (zigbee2mqtt/<friendly_name>) ----
            if topic.startswith(f"{z2m_base}/") and "/bridge/" not in topic:
                friendly = topic[len(z2m_base) + 1 :].split("/")[0]
                try:
                    payload = json.loads(msg.payload.decode())
                except Exception:
                    return
                asyncio.run_coroutine_threadsafe(
                    _apply_z2m_device_payload(friendly, payload), _main_loop
                )
        except Exception as exc:
            logger.exception("MQTT on_message error: %s", exc)

    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    try:
        client.connect(broker, port, 60)
        client.loop_start()
        _mqtt_client = client
    except Exception as exc:
        logger.warning("MQTT connect failed: %s", exc)


# ==============================================================
# Zigbee2MQTT device sync helpers (async, called from MQTT thread)
# ==============================================================
async def _sync_z2m_devices(devices: List[Dict[str, Any]]):
    """Persist the full device inventory reported by zigbee2mqtt/bridge/devices.
    - Insert new devices with a guessed device_type from `type`/`definition.exposes`
    - Update model, online/last_seen
    - Never overwrite the user's `friendly_name` (they may have renamed via UI)
    """
    if not devices:
        return
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        for d in devices:
            ieee = d.get("ieee_address") or d.get("friendly_name")
            if not ieee:
                continue
            friendly = d.get("friendly_name") or ieee
            model = d.get("model_id") or d.get("definition", {}).get("model") or "unknown"
            dev_type = _guess_z2m_type(d)
            online = 1 if d.get("interview_completed") is True and d.get("supported", True) else 0
            # Existing row?
            row = await (await db.execute(
                "SELECT id FROM zigbee_devices WHERE id=?", (ieee,)
            )).fetchone()
            if row is None:
                await db.execute(
                    "INSERT INTO zigbee_devices(id, friendly_name, model, device_type, "
                    "assigned_role, online, last_seen) VALUES(?,?,?,?,?,?,?)",
                    (ieee, friendly, model, dev_type, "none", online,
                     _iso(datetime.now(timezone.utc))),
                )
                logger.info("Zigbee: new device paired %s (%s)", friendly, model)
                # Push notification: new device paired
                push_bg({
                    "title": "🔗 Nouvel appareil Zigbee détecté",
                    "message": f"{friendly} ({model}) — ouvrez l'app pour l'assigner à un capteur.",
                    "action_url": "/",
                })
            else:
                await db.execute(
                    "UPDATE zigbee_devices SET model=?, device_type=?, online=?, "
                    "last_seen=? WHERE id=?",
                    (model, dev_type, online,
                     _iso(datetime.now(timezone.utc)), ieee),
                )
        await db.commit()


def _guess_z2m_type(d: Dict[str, Any]) -> str:
    """Categorise a zigbee2mqtt device as 'relay' | 'sensor' | 'other'."""
    exposes = d.get("definition", {}).get("exposes") or []
    for e in exposes:
        if e.get("type") == "switch" or (e.get("features") and
            any(f.get("name") in ("state", "on_off") for f in e["features"])):
            return "relay"
        if e.get("type") == "numeric" and e.get("property") in (
            "temperature", "humidity", "pressure", "battery", "illuminance"
        ):
            return "sensor"
    if d.get("type") in ("Router",):
        return "relay"
    return "other"


async def _apply_z2m_device_payload(friendly_name: str, payload: Dict[str, Any]):
    """Route an individual device MQTT payload to the right in-memory sensor
    slot based on assigned_role.  Also updates `last_seen`, battery, LQI."""
    if not isinstance(payload, dict):
        return
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        row = await (await db.execute(
            "SELECT id, assigned_role FROM zigbee_devices WHERE friendly_name=?",
            (friendly_name,),
        )).fetchone()
        if not row:
            # Unknown device — will be added on next bridge/devices message
            return
        did = row["id"]
        role = row["assigned_role"] or "none"

        # Update meta
        battery = payload.get("battery")
        lqi = payload.get("linkquality") or payload.get("lqi")
        await db.execute(
            "UPDATE zigbee_devices SET last_seen=?, online=1, "
            "battery=COALESCE(?,battery), lqi=COALESCE(?,lqi) WHERE id=?",
            (_iso(datetime.now(timezone.utc)), battery, lqi, did),
        )
        await db.commit()

    # Route to sensor slot
    role_to_key = {
        "temp": ("temp", "temperature"),
        "ph": ("ph", "ph"),
        "orp": ("orp", "orp"),
        "salinity": ("salinity", "salinity"),
        "pressure": ("pressure", "pressure"),
    }
    if role in role_to_key:
        slot, prop = role_to_key[role]
        val = payload.get(prop)
        if val is None and prop == "temperature":
            val = payload.get("temp")
        if isinstance(val, (int, float)):
            sensor_state[slot]["value"] = float(val)
            sensor_state[slot]["source"] = "zigbee"
            system_state["last_update"] = datetime.now(timezone.utc)

# ==============================================================


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

        # Check current state to detect a real change
        cur = await db.execute("SELECT state FROM equipment WHERE id=?", (eid,))
        prev_row = await cur.fetchone()
        if not prev_row:
            raise HTTPException(404, "Equipment not found")
        prev_state = bool(prev_row["state"])

        await db.execute("UPDATE equipment SET state=? WHERE id=?",
                         (1 if payload.state else 0, eid))
        await db.commit()

        # Log the change to the events journal (only if state changed)
        if prev_state != payload.state:
            await log_equipment_event(
                eid, "on" if payload.state else "off", "user",
                "Action manuelle depuis l'interface",
            )
            # Any manual filtration toggle activates the manual override so the
            # scheduler stops touching the pump until the user clears it.
            if eid == "filtration":
                await _set_setting("pump_manual_override", True)

        # Business rule: stopping filtration also stops electrolyseur (safety)
        if eid == "filtration" and not payload.state:
            cur2 = await db.execute("SELECT state FROM equipment WHERE id='electrolyseur'")
            elec = await cur2.fetchone()
            if elec and elec["state"]:
                await db.execute("UPDATE equipment SET state=0 WHERE id='electrolyseur'")
                await db.commit()
                await log_equipment_event(
                    "electrolyseur", "off", "coupling",
                    "Arrêt automatique suite à l'arrêt de la pompe",
                )
                await create_alert("info", "Électrolyseur arrêté",
                                   "L'électrolyseur a été coupé automatiquement suite à l'arrêt de la pompe.")

    return {"id": eid, "state": payload.state}


@api_router.get("/equipment/events")
async def equipment_events(limit: int = 100, equipment_id: Optional[str] = None):
    """List equipment ON/OFF events, most recent first.
    Each event is enriched with:
      • water_temp: the pool temperature captured at the moment of the event
      • duration_seconds: for OFF events, the duration of the preceding ON cycle
        (i.e. how long the equipment ran before it was stopped)."""
    q = "SELECT id, equipment_id, action, source, reason, ts, water_temp FROM equipment_events"
    params: list = []
    if equipment_id:
        q += " WHERE equipment_id = ?"
        params.append(equipment_id)
    q += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)

    events: list = []
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute(q, params):
            events.append(dict(row))

        # For each OFF event, look up the most recent ON of the same equipment
        # BEFORE that event to compute cycle duration.
        for ev in events:
            if ev["action"] == "off":
                cur = await db.execute(
                    "SELECT ts FROM equipment_events "
                    "WHERE equipment_id=? AND action='on' AND ts < ? "
                    "ORDER BY ts DESC LIMIT 1",
                    (ev["equipment_id"], ev["ts"]),
                )
                r = await cur.fetchone()
                if r and r["ts"]:
                    try:
                        t_on = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
                        t_off = datetime.fromisoformat(ev["ts"].replace("Z", "+00:00"))
                        ev["duration_seconds"] = int(max(0, (t_off - t_on).total_seconds()))
                    except Exception:
                        ev["duration_seconds"] = None
                else:
                    ev["duration_seconds"] = None
            else:
                ev["duration_seconds"] = None
    return {"events": events}


# ==============================================================
# MAINTENANCE TASKS
# ==============================================================
class MaintenancePayload(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    icon: Optional[str] = None
    interval_days: Optional[int] = None
    enabled: Optional[bool] = None


async def _list_maintenance() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async for row in await db.execute(
            "SELECT id, name, icon, interval_days, last_done_at, enabled, notified_at "
            "FROM maintenance_tasks ORDER BY name ASC"
        ):
            d = dict(row)
            d["enabled"] = bool(d["enabled"])
            interval = int(d.get("interval_days") or 0)
            last_iso = d.get("last_done_at")
            if last_iso:
                try:
                    last_dt = datetime.fromisoformat(last_iso.replace("Z", "+00:00"))
                    next_due = last_dt + timedelta(days=interval)
                except Exception:
                    last_dt = None
                    next_due = now
            else:
                # Never done → due immediately (or based on interval from "now").
                last_dt = None
                next_due = now
            d["next_due_at"] = _iso(next_due)
            remaining = (next_due - now).total_seconds()
            d["days_remaining"] = round(remaining / 86400.0, 1)
            d["is_overdue"] = remaining <= 0
            items.append(d)
    return items


@api_router.get("/maintenance")
async def get_maintenance():
    return {"tasks": await _list_maintenance()}


@api_router.post("/maintenance")
async def create_maintenance(payload: MaintenancePayload):
    if not payload.name:
        raise HTTPException(400, "Le nom est obligatoire.")
    tid = payload.id or str(uuid.uuid4())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO maintenance_tasks(id,name,icon,interval_days,last_done_at,enabled) "
            "VALUES(?,?,?,?,NULL,?)",
            (tid, payload.name, payload.icon or "construct", int(payload.interval_days or 30),
             1 if (payload.enabled is None or payload.enabled) else 0),
        )
        await db.commit()
    return {"id": tid, "ok": True}


@api_router.put("/maintenance/{tid}")
async def update_maintenance(tid: str, payload: MaintenancePayload):
    updates: List[str] = []
    values: List[Any] = []
    if payload.name is not None:
        updates.append("name=?"); values.append(payload.name)
    if payload.icon is not None:
        updates.append("icon=?"); values.append(payload.icon)
    if payload.interval_days is not None:
        updates.append("interval_days=?"); values.append(int(payload.interval_days))
    if payload.enabled is not None:
        updates.append("enabled=?"); values.append(1 if payload.enabled else 0)
    if not updates:
        raise HTTPException(400, "Aucun champ à mettre à jour.")
    values.append(tid)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            f"UPDATE maintenance_tasks SET {', '.join(updates)} WHERE id=?", values
        )
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Tâche introuvable.")
    return {"ok": True}


@api_router.delete("/maintenance/{tid}")
async def delete_maintenance(tid: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM maintenance_tasks WHERE id=?", (tid,))
        await db.commit()
    return {"ok": True}


@api_router.post("/maintenance/{tid}/done")
async def mark_maintenance_done(tid: str):
    """Reset the timer of a task: sets last_done_at = now, clears notified_at."""
    now_iso = _iso(datetime.now(timezone.utc))
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "UPDATE maintenance_tasks SET last_done_at=?, notified_at=NULL WHERE id=?",
            (now_iso, tid),
        )
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Tâche introuvable.")
    return {"ok": True, "last_done_at": now_iso}


# ==============================================================
# PUSH NOTIFICATIONS — device registration
# ==============================================================
class RegisterPushBody(BaseModel):
    user_id: str
    platform: str  # "android" | "ios"
    device_token: str


@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody):
    """Register a mobile device token with the Emergent push relay AND
    persist it locally so we know who to notify on events."""
    # 1) Save locally (idempotent upsert)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO push_subscribers(user_id, platform, device_token, registered_at) "
            "VALUES(?,?,?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET "
            "platform=excluded.platform, device_token=excluded.device_token, "
            "registered_at=excluded.registered_at",
            (body.user_id, body.platform, body.device_token,
             _iso(datetime.now(timezone.utc))),
        )
        await db.commit()

    # 2) Relay upstream to Emergent push provider
    relay_ok = False
    try:
        resp = await _push_client.post(
            "/api/v1/push/users/register", json=body.model_dump()
        )
        if resp.status_code == 401:
            # Key is placeholder in dev — device is still saved locally,
            # deployer will replace the key on Publish → real relay works.
            logger.info("Relay skipped (dev mode) — device %s saved locally", body.user_id[:8])
        elif resp.status_code >= 500:
            logger.warning("Push relay 5xx: %s", resp.text[:200])
        else:
            resp.raise_for_status()
            relay_ok = True
    except Exception as exc:
        logger.warning("Push relay error (kept locally): %s", exc)
    return {"status": "registered", "relay_ok": relay_ok}


@api_router.post("/push/test")
async def push_test():
    """Manually trigger a test push to all registered devices."""
    await send_push({
        "title": "PoolKiosk – test",
        "message": "Si vous voyez cette notification, votre téléphone est bien connecté 🎉",
        "action_url": "/",
    }, idempotency_key=f"test-{uuid.uuid4()}")
    return {"ok": True, "recipients": len(await _list_push_subscribers())}


async def _pump_runtime_payload() -> Dict[str, Any]:
    today_h = await _compute_runtime_hours("filtration", _today_start_utc())
    week_h = await _compute_runtime_hours("filtration", _week_start_utc())
    settings = await get_settings_dict()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT state FROM equipment WHERE id='filtration'")
        r = await cur.fetchone()
        pump_state = bool(r["state"]) if r else False
    temp = float(sensor_state.get("temp", {}).get("value") or 0)
    return {
        "state": pump_state,
        "today_hours": today_h,
        "week_hours": week_h,
        "manual_override": bool(settings.get("pump_manual_override")),
        "auto_filtration": bool(settings.get("auto_filtration", True)),
        "water_temp": round(temp, 1),
        "recommended_hours": round(compute_filtration_hours(temp), 1),
    }


@api_router.get("/equipment/pump/runtime")
async def pump_runtime():
    return await _pump_runtime_payload()


@api_router.post("/equipment/pump/clear-override")
async def clear_pump_override():
    """Return the pump to its programmed schedule. The scheduler will
    resume control on the next tick (≤ 30 s)."""
    await _set_setting("pump_manual_override", False)
    await log_equipment_event(
        "filtration", "override_off", "user",
        "Reprise du planning automatique (fin du mode manuel)",
    )
    return {"ok": True}


@api_router.post("/schedule/auto-apply")
async def schedule_auto_apply():
    """Manually recompute schedules from the current water temperature."""
    payload = await _apply_auto_schedule("manual")
    return {"ok": True, **payload}


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
    pump_info = await _pump_runtime_payload()
    maintenance = await _list_maintenance()
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
        "pump": pump_info,
        "maintenance": maintenance,
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
            "SELECT id, friendly_name, model, device_type, assigned_role, online, "
            "last_seen, battery, lqi FROM zigbee_devices "
            "ORDER BY device_type ASC, friendly_name ASC"
        ):
            d = dict(row); d["online"] = bool(d["online"]); items.append(d)
    return items


@api_router.get("/zigbee/devices")
async def zigbee_devices():
    return {"devices": await _zigbee_list()}


@api_router.get("/zigbee/status")
async def zigbee_status():
    """Return live bridge status: connection, pairing window, device count."""
    devices = await _zigbee_list()
    return {
        **zigbee_bridge_state,
        "device_count": len(devices),
        "online_count": sum(1 for d in devices if d.get("online")),
        "mqtt_source": system_state.get("mqtt_source"),
    }


@api_router.post("/zigbee/permit-join")
async def zigbee_permit_join(duration: int = 60):
    """Open the Zigbee pairing window for `duration` seconds.
    Publishes to zigbee2mqtt/bridge/request/permit_join."""
    duration = max(10, min(300, int(duration)))
    if _mqtt_client is None:
        # Simulator / no broker → set the flag so the UI can show the countdown
        # anyway (useful during development).
        zigbee_bridge_state["permit_join"] = True
        zigbee_bridge_state["permit_join_until"] = _iso(
            datetime.now(timezone.utc) + timedelta(seconds=duration)
        )
        return {"ok": True, "simulated": True, "duration": duration}
    try:
        _mqtt_publish(
            _z2m_topic("bridge/request/permit_join"),
            {"value": True, "time": duration},
        )
        zigbee_bridge_state["permit_join"] = True
        zigbee_bridge_state["permit_join_until"] = _iso(
            datetime.now(timezone.utc) + timedelta(seconds=duration)
        )
        return {"ok": True, "duration": duration}
    except Exception as exc:
        raise HTTPException(502, f"MQTT publish failed: {exc}")


@api_router.post("/zigbee/permit-join/stop")
async def zigbee_permit_join_stop():
    if _mqtt_client is not None:
        try:
            _mqtt_publish(
                _z2m_topic("bridge/request/permit_join"),
                {"value": False},
            )
        except Exception:
            pass
    zigbee_bridge_state["permit_join"] = False
    zigbee_bridge_state["permit_join_until"] = None
    return {"ok": True}


@api_router.post("/zigbee/broker/test")
async def zigbee_broker_test():
    """Ping the MQTT broker + return connection status."""
    return {
        "connected": zigbee_bridge_state.get("broker_connected", False),
        "host": zigbee_bridge_state.get("broker_host"),
        "port": zigbee_bridge_state.get("broker_port"),
        "bridge_state": zigbee_bridge_state.get("last_bridge_state"),
        "hint": ("Broker connecté ✅"
                 if zigbee_bridge_state.get("broker_connected")
                 else "Aucun broker. Configurez MQTT_BROKER dans .env "
                      "(ex: MQTT_BROKER=127.0.0.1 pour Mosquitto local)."),
    }


@api_router.delete("/zigbee/devices/{did}")
async def zigbee_device_remove(did: str):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        row = await (await db.execute(
            "SELECT friendly_name FROM zigbee_devices WHERE id=?", (did,)
        )).fetchone()
        if not row:
            raise HTTPException(404, "Appareil introuvable.")
        friendly = row["friendly_name"]
        await db.execute("DELETE FROM zigbee_devices WHERE id=?", (did,))
        await db.commit()

    if _mqtt_client is not None:
        try:
            _mqtt_publish(
                _z2m_topic("bridge/request/device/remove"),
                {"id": friendly, "block": False, "force": False},
            )
        except Exception as exc:
            logger.warning("device remove publish failed: %s", exc)
    return {"ok": True}


@api_router.put("/zigbee/devices/{did}")
async def zigbee_device_update(did: str, payload: ZigbeeDeviceUpdate):
    upd = {k: v for k, v in payload.dict().items() if v is not None}
    if not upd:
        raise HTTPException(400, "Aucun champ à mettre à jour.")
    # If friendly_name is being changed and MQTT is live, also rename in Z2M
    new_name = upd.get("friendly_name")
    old_name: Optional[str] = None
    if new_name and _mqtt_client is not None:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            row = await (await db.execute(
                "SELECT friendly_name FROM zigbee_devices WHERE id=?", (did,)
            )).fetchone()
            if row:
                old_name = row["friendly_name"]
    async with aiosqlite.connect(DB_PATH) as db:
        sets = ", ".join(f"{k}=?" for k in upd.keys())
        vals = list(upd.values()) + [did]
        cur = await db.execute(f"UPDATE zigbee_devices SET {sets} WHERE id=?", vals)
        await db.commit()
        if cur.rowcount == 0:
            raise HTTPException(404, "Appareil introuvable.")
    if new_name and old_name and old_name != new_name and _mqtt_client is not None:
        try:
            _mqtt_publish(
                _z2m_topic("bridge/request/device/rename"),
                {"from": old_name, "to": new_name},
            )
        except Exception as exc:
            logger.warning("device rename publish failed: %s", exc)
    return {"ok": True}


@api_router.post("/zigbee/devices/rescan")
async def zigbee_rescan():
    """Ask Zigbee2MQTT to re-publish its device inventory."""
    if _mqtt_client is not None:
        try:
            # Re-subscribe / republish trigger via a benign info request
            _mqtt_publish(_z2m_topic("bridge/request/health_check"), {})
        except Exception as exc:
            logger.warning("rescan publish failed: %s", exc)
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


# --------------------------------------------------------------
# WiFi status (Raspberry Pi)
# --------------------------------------------------------------
def _read_wifi_status() -> dict:
    """Read WiFi connection status and signal quality on the Raspberry Pi.
    Returns dict {available, connected, ssid, signal_percent, signal_dbm, ip, iface}.
    Falls back gracefully when running in a non-Pi environment.
    """
    result = {
        "available": False,
        "connected": False,
        "ssid": None,
        "signal_percent": None,
        "signal_dbm": None,
        "ip": None,
        "iface": None,
    }
    # 1) Try /proc/net/wireless (lightweight, works on Pi)
    try:
        wireless_path = "/proc/net/wireless"
        if os.path.exists(wireless_path):
            with open(wireless_path, "r") as f:
                lines = f.readlines()
            # Skip 2 header lines; parse first interface line if present
            for line in lines[2:]:
                parts = line.strip().split()
                if len(parts) >= 4:
                    iface = parts[0].rstrip(":")
                    # link quality (parts[2]) and signal level in dBm (parts[3])
                    try:
                        link_quality = float(parts[2].rstrip("."))
                        signal_dbm = float(parts[3].rstrip("."))
                    except ValueError:
                        continue
                    result["available"] = True
                    result["iface"] = iface
                    # link_quality is /70 typically → convert to percentage
                    percent = max(0, min(100, int(round(link_quality / 70.0 * 100))))
                    result["signal_percent"] = percent
                    result["signal_dbm"] = int(signal_dbm)
                    result["connected"] = percent > 0
                    break
    except Exception as e:
        logger.debug("wifi /proc/net/wireless read failed: %s", e)

    # 2) Try iwgetid for SSID
    if result["connected"]:
        try:
            out = subprocess.run(
                ["iwgetid", "-r"], capture_output=True, text=True, timeout=2
            )
            ssid = (out.stdout or "").strip()
            if ssid:
                result["ssid"] = ssid
        except Exception as e:
            logger.debug("iwgetid failed: %s", e)

        # 3) Get IP of the wireless interface
        try:
            iface = result.get("iface") or "wlan0"
            out = subprocess.run(
                ["ip", "-4", "addr", "show", iface],
                capture_output=True, text=True, timeout=2,
            )
            import re as _re
            m = _re.search(r"inet\s+(\d+\.\d+\.\d+\.\d+)", out.stdout or "")
            if m:
                result["ip"] = m.group(1)
        except Exception as e:
            logger.debug("ip addr failed: %s", e)

    # 4) Fallback: if /proc/net/wireless is missing but nmcli is present
    if not result["available"]:
        try:
            out = subprocess.run(
                ["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL,DEVICE", "device", "wifi"],
                capture_output=True, text=True, timeout=2,
            )
            for line in (out.stdout or "").splitlines():
                fields = line.split(":")
                if len(fields) >= 4 and fields[0] == "yes":
                    result["available"] = True
                    result["connected"] = True
                    result["ssid"] = fields[1] or None
                    try:
                        result["signal_percent"] = int(fields[2])
                    except ValueError:
                        pass
                    result["iface"] = fields[3] or None
                    break
        except Exception as e:
            logger.debug("nmcli fallback failed: %s", e)

    return result


@api_router.get("/system/wifi")
async def system_wifi():
    return _read_wifi_status()


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
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    await init_db()
    asyncio.create_task(sensor_simulator_loop())
    asyncio.create_task(pump_scheduler_loop())
    asyncio.create_task(auto_schedule_daily_loop())
    asyncio.create_task(maintenance_reminder_loop())
    asyncio.create_task(permit_join_watchdog_loop())
    start_mqtt_bridge()
    logger.info("Appli piscine backend ready. DB=%s", DB_PATH)


@app.on_event("shutdown")
async def _shutdown():
    logger.info("Bye.")
