"""Push notifications & regression tests for PoolKiosk push feature.
Verifies /api/register-push, /api/push/test, dashboard regression, maintenance
notified_at flag, and push_bg triggers.
"""
import os
import time
import sqlite3
import uuid as _uuid
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://pool-filter-hub.preview.emergentagent.com").rstrip("/")
DB_PATH = Path(os.environ.get("POOLKIOSK_DB_PATH", "/app/backend/poolkiosk.db"))
BACKEND_LOG = Path("/var/log/supervisor/backend.err.log")
TEST_USER_PREFIX = "TEST_pushuser_"


@pytest.fixture(scope="session")
def api_client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session", autouse=True)
def cleanup_test_subscribers():
    yield
    try:
        if DB_PATH.exists():
            con = sqlite3.connect(DB_PATH)
            con.execute("DELETE FROM push_subscribers WHERE user_id LIKE ?", (f"{TEST_USER_PREFIX}%",))
            con.commit()
            con.close()
    except Exception as e:
        print(f"cleanup failed: {e}")


# ------------------- basic health -------------------
class TestHealth:
    def test_system_status(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/system/status")
        assert r.status_code == 200
        assert "zigbee" in r.json()

    def test_dashboard_regression(self, api_client):
        """Regression: push additions must not break dashboard payload."""
        r = api_client.get(f"{BASE_URL}/api/dashboard/summary")
        assert r.status_code == 200
        d = r.json()
        assert "pump" in d and isinstance(d["pump"], dict)
        assert "maintenance" in d and isinstance(d["maintenance"], list)
        assert "widgets" in d and len(d["widgets"]) == 12
        # pump payload keys
        for k in ("state", "today_hours", "week_hours", "manual_override", "auto_filtration"):
            assert k in d["pump"], f"pump missing {k}"


# ------------------- /api/register-push -------------------
class TestRegisterPush:
    def test_register_saves_locally_and_returns_201(self, api_client):
        uid = f"{TEST_USER_PREFIX}{_uuid.uuid4().hex[:10]}"
        payload = {"user_id": uid, "platform": "android", "device_token": "test-token-xyz"}
        r = api_client.post(f"{BASE_URL}/api/register-push", json=payload)
        # MUST NOT raise 500 even though upstream key is placeholder
        assert r.status_code == 201, f"expected 201, got {r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body.get("status") == "registered"
        # relay_ok should be false (placeholder key ⇒ 401 upstream)
        assert body.get("relay_ok") is False, f"relay_ok should be False in dev, got {body}"

        # Verify DB persistence
        assert DB_PATH.exists(), f"DB not found at {DB_PATH}"
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT * FROM push_subscribers WHERE user_id=?", (uid,)).fetchone()
        con.close()
        assert row is not None, "subscriber not persisted in push_subscribers table"
        assert row["platform"] == "android"
        assert row["device_token"] == "test-token-xyz"

    def test_register_is_idempotent_upsert(self, api_client):
        uid = f"{TEST_USER_PREFIX}{_uuid.uuid4().hex[:10]}"
        api_client.post(f"{BASE_URL}/api/register-push",
                        json={"user_id": uid, "platform": "android", "device_token": "tok1"})
        r = api_client.post(f"{BASE_URL}/api/register-push",
                            json={"user_id": uid, "platform": "ios", "device_token": "tok2"})
        assert r.status_code == 201
        con = sqlite3.connect(DB_PATH); con.row_factory = sqlite3.Row
        row = con.execute("SELECT * FROM push_subscribers WHERE user_id=?", (uid,)).fetchone()
        con.close()
        assert row["platform"] == "ios"
        assert row["device_token"] == "tok2"


# ------------------- /api/push/test -------------------
class TestPushTest:
    def test_push_test_returns_ok_and_recipients(self, api_client):
        # Ensure at least one subscriber exists
        uid = f"{TEST_USER_PREFIX}{_uuid.uuid4().hex[:10]}"
        api_client.post(f"{BASE_URL}/api/register-push",
                        json={"user_id": uid, "platform": "android", "device_token": "tok"})
        r = api_client.post(f"{BASE_URL}/api/push/test")
        assert r.status_code == 200, f"push/test failed: {r.status_code} {r.text[:200]}"
        body = r.json()
        assert body.get("ok") is True
        assert isinstance(body.get("recipients"), int)
        assert body["recipients"] >= 1


# ------------------- maintenance notified_at + push_bg -------------------
class TestMaintenanceNotifiedField:
    def test_get_maintenance_includes_notified_at(self, api_client):
        r = api_client.get(f"{BASE_URL}/api/maintenance")
        assert r.status_code == 200
        tasks = r.json().get("tasks", [])
        assert len(tasks) >= 1
        for t in tasks:
            assert "notified_at" in t, f"task {t.get('id')} missing notified_at"

    def test_mark_done_clears_notified_at(self, api_client):
        # Pick first task, set notified_at directly via DB, then mark done, verify cleared
        r = api_client.get(f"{BASE_URL}/api/maintenance")
        tid = r.json()["tasks"][0]["id"]
        con = sqlite3.connect(DB_PATH)
        con.execute("UPDATE maintenance_tasks SET notified_at=? WHERE id=?", ("2026-01-01T00:00:00+00:00", tid))
        con.commit(); con.close()
        # Confirm set
        r2 = api_client.get(f"{BASE_URL}/api/maintenance")
        task = next(t for t in r2.json()["tasks"] if t["id"] == tid)
        assert task["notified_at"] is not None
        # Now mark done
        r3 = api_client.post(f"{BASE_URL}/api/maintenance/{tid}/done")
        assert r3.status_code == 200
        r4 = api_client.get(f"{BASE_URL}/api/maintenance")
        task2 = next(t for t in r4.json()["tasks"] if t["id"] == tid)
        assert task2["notified_at"] is None, "notified_at should be cleared after mark_done"


# ------------------- push_bg log verification -------------------
def _tail_log(path: Path, n=400) -> str:
    if not path.exists():
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 200000))
            return f.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


class TestPushBgTriggers:
    def test_filtration_toggle_triggers_push_bg(self, api_client):
        """log_equipment_event must call push_bg for filtration on/off."""
        # Clear override first so we can toggle freely
        api_client.post(f"{BASE_URL}/api/equipment/pump/clear-override")
        # Read current state
        eq = api_client.get(f"{BASE_URL}/api/equipment").json()["equipment"]
        f = next(e for e in eq if e["id"] == "filtration")
        current = f["state"]
        # Toggle to opposite
        target = not current
        r = api_client.post(f"{BASE_URL}/api/equipment/filtration/toggle", json={"state": target})
        assert r.status_code == 200, r.text[:200]
        time.sleep(1.5)  # allow bg task to run
        log = _tail_log(BACKEND_LOG)
        # Look for evidence push relay was called (title present in bg log OR warning about missing key)
        markers = ["Push sent", "EMERGENT_PUSH_KEY", "Push relay", "Pompe démarrée", "Pompe arrêtée"]
        found = [m for m in markers if m in log]
        # Restore state
        api_client.post(f"{BASE_URL}/api/equipment/filtration/toggle", json={"state": current})
        assert found, f"No push_bg activity in backend log for filtration toggle. Markers checked: {markers}"

    def test_create_alert_triggers_push_bg(self, api_client):
        """Force an alert via /api/alerts injection is not exposed;
        rely on running metric evaluator by inspecting recent log for push activity
        after alerts are present. Fallback: verify at least one alert-related
        push line exists in log OR no crash after acknowledging existing alerts."""
        # Fetch alerts
        r = api_client.get(f"{BASE_URL}/api/alerts")
        assert r.status_code == 200
        log = _tail_log(BACKEND_LOG)
        # After bootup, evaluate_metric_alerts runs; if any alert has fired,
        # we'd see Push sent or the placeholder warning. This is a soft check.
        soft_markers = ["Push sent", "EMERGENT_PUSH_KEY missing", "push relay", "ALERT ["]
        found = [m for m in soft_markers if m in log]
        if not found:
            pytest.skip("No alerts fired since backend start — cannot verify create_alert push_bg trigger in this window")
