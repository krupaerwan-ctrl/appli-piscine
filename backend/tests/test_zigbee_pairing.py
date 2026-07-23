"""Zigbee pairing / broker / device-CRUD endpoints — Phase 1."""
import os
import time
import pytest
import requests
from datetime import datetime, timezone

BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or ""
).rstrip("/")

if not BASE_URL:
    # Fallback for local test environment
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("EXPO_PUBLIC_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ==================== ZIGBEE STATUS ====================
class TestZigbeeStatus:
    def test_status_shape(self, api):
        r = api.get(f"{BASE_URL}/api/zigbee/status", timeout=10)
        assert r.status_code == 200
        d = r.json()
        for k in ("broker_connected", "permit_join", "permit_join_until",
                  "device_count", "online_count", "mqtt_source"):
            assert k in d, f"missing {k}: {d}"

    def test_status_simulator_mode(self, api):
        d = api.get(f"{BASE_URL}/api/zigbee/status").json()
        # MQTT_BROKER not set in dev
        assert d["broker_connected"] is False
        assert d["mqtt_source"] == "simulator"

    def test_status_device_count_matches_devices(self, api):
        s = api.get(f"{BASE_URL}/api/zigbee/status").json()
        devs = api.get(f"{BASE_URL}/api/zigbee/devices").json().get("devices", [])
        assert s["device_count"] == len(devs)


# ==================== PERMIT JOIN ====================
class TestPermitJoin:
    def test_permit_join_start(self, api):
        r = api.post(f"{BASE_URL}/api/zigbee/permit-join?duration=60")
        assert r.status_code == 200
        d = r.json()
        assert d["ok"] is True
        assert d["duration"] == 60
        # In simulator mode, simulated flag returned
        assert d.get("simulated") is True

        # Verify status reflects change
        s = api.get(f"{BASE_URL}/api/zigbee/status").json()
        assert s["permit_join"] is True
        assert s["permit_join_until"] is not None
        # Should be ISO UTC ~60s from now
        end = datetime.fromisoformat(s["permit_join_until"].replace("Z", "+00:00"))
        delta = (end - datetime.now(timezone.utc)).total_seconds()
        assert 40 < delta <= 70, f"expected ~60s window, got {delta}s"

    def test_permit_join_stop(self, api):
        api.post(f"{BASE_URL}/api/zigbee/permit-join?duration=60")
        r = api.post(f"{BASE_URL}/api/zigbee/permit-join/stop")
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        s = api.get(f"{BASE_URL}/api/zigbee/status").json()
        assert s["permit_join"] is False
        assert s["permit_join_until"] is None

    def test_permit_join_watchdog_expires(self, api):
        # Start with duration=10; watchdog should clear after ~10s
        r = api.post(f"{BASE_URL}/api/zigbee/permit-join?duration=10")
        assert r.status_code == 200
        assert r.json()["duration"] == 10
        s = api.get(f"{BASE_URL}/api/zigbee/status").json()
        assert s["permit_join"] is True
        # Wait 12s for the watchdog
        time.sleep(12)
        s2 = api.get(f"{BASE_URL}/api/zigbee/status").json()
        assert s2["permit_join"] is False, "watchdog did not expire permit_join"
        assert s2["permit_join_until"] is None


# ==================== BROKER TEST ====================
class TestBrokerTest:
    def test_broker_test_shape(self, api):
        r = api.post(f"{BASE_URL}/api/zigbee/broker/test")
        assert r.status_code == 200
        d = r.json()
        for k in ("connected", "host", "port", "hint"):
            assert k in d, f"missing {k}"

    def test_broker_test_hint_mentions_env_when_disconnected(self, api):
        d = api.post(f"{BASE_URL}/api/zigbee/broker/test").json()
        assert d["connected"] is False
        assert "MQTT_BROKER" in d["hint"]


# ==================== DEVICES / SCHEMA ====================
class TestZigbeeDevices:
    def test_list_devices_has_battery_lqi_columns(self, api):
        r = api.get(f"{BASE_URL}/api/zigbee/devices")
        assert r.status_code == 200
        devs = r.json().get("devices", [])
        assert len(devs) >= 1
        for d in devs:
            for k in ("id", "friendly_name", "model", "device_type",
                      "assigned_role", "online", "last_seen",
                      "battery", "lqi"):
                assert k in d, f"missing schema column {k} in device {d}"

    def test_update_device_friendly_name_and_role(self, api):
        devs = api.get(f"{BASE_URL}/api/zigbee/devices").json()["devices"]
        target = next(d for d in devs if d["device_type"] == "sensor")
        new_role = "orp" if target.get("assigned_role") != "orp" else "temp"
        r = api.put(
            f"{BASE_URL}/api/zigbee/devices/{target['id']}",
            json={"friendly_name": "TEST_regression", "assigned_role": new_role},
        )
        assert r.status_code == 200
        # Verify via list
        devs2 = api.get(f"{BASE_URL}/api/zigbee/devices").json()["devices"]
        updated = next(d for d in devs2 if d["id"] == target["id"])
        assert updated["friendly_name"] == "TEST_regression"
        assert updated["assigned_role"] == new_role
        # restore
        api.put(
            f"{BASE_URL}/api/zigbee/devices/{target['id']}",
            json={"friendly_name": target["friendly_name"],
                  "assigned_role": target["assigned_role"]},
        )

    def test_delete_device_and_404_on_missing(self, api):
        # Create a temp device via seed manipulation is not exposed;
        # so pick a device, delete it, then re-insert via PUT? PUT does not create.
        # Strategy: delete one demo device and verify 404 next time
        devs = api.get(f"{BASE_URL}/api/zigbee/devices").json()["devices"]
        # Pick 'other' if exists else last sensor
        target = devs[-1]
        r = api.delete(f"{BASE_URL}/api/zigbee/devices/{target['id']}")
        assert r.status_code == 200
        # Verify removed
        devs2 = api.get(f"{BASE_URL}/api/zigbee/devices").json()["devices"]
        assert all(d["id"] != target["id"] for d in devs2)
        # Second delete → 404
        r2 = api.delete(f"{BASE_URL}/api/zigbee/devices/{target['id']}")
        assert r2.status_code == 404


# ==================== REGRESSIONS ====================
class TestRegressions:
    def test_dashboard_summary_has_pump_maintenance_widgets(self, api):
        r = api.get(f"{BASE_URL}/api/dashboard/summary")
        assert r.status_code == 200
        d = r.json()
        assert "pump" in d and isinstance(d["pump"], dict)
        assert "maintenance" in d and isinstance(d["maintenance"], list)
        assert "widgets" in d and isinstance(d["widgets"], list)

    def test_system_wifi(self, api):
        r = api.get(f"{BASE_URL}/api/system/wifi")
        assert r.status_code == 200

    def test_push_test(self, api):
        r = api.post(f"{BASE_URL}/api/push/test")
        assert r.status_code == 200
        assert r.json().get("ok") is True
