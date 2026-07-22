"""Backend tests for iteration 10:
   - Maintenance tasks CRUD + done reset
   - Equipment events enrichment (water_temp + duration_seconds)
   - Dashboard summary includes `maintenance` array
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get(
    "EXPO_PUBLIC_BACKEND_URL",
    "https://pool-filter-hub.preview.emergentagent.com",
).rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _get_maint(api):
    r = api.get(f"{BASE_URL}/api/maintenance", timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["tasks"]


def _find_task(tasks, tid):
    return next((t for t in tasks if t["id"] == tid), None)


# ---------------- MAINTENANCE ----------------
class TestMaintenance:
    def test_01_defaults_present(self, api):
        tasks = _get_maint(api)
        ids = {t["id"] for t in tasks}
        assert {"filter_cleaning", "backwash", "chlorine_check"}.issubset(ids)
        for t in tasks:
            for f in ("id", "name", "icon", "interval_days", "enabled",
                      "days_remaining", "is_overdue", "next_due_at"):
                assert f in t, f"missing field {f} in {t}"
            assert isinstance(t["days_remaining"], (int, float))
            assert isinstance(t["is_overdue"], bool)

    def test_02_create_task(self, api):
        payload = {"name": "TEST_ph_calibration", "interval_days": 14, "icon": "flask"}
        r = api.post(f"{BASE_URL}/api/maintenance", json=payload, timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        tid = body["id"]
        pytest.maint_tid = tid
        # Verify via GET
        tasks = _get_maint(api)
        t = _find_task(tasks, tid)
        assert t is not None
        assert t["name"] == "TEST_ph_calibration"
        assert t["interval_days"] == 14
        assert t["icon"] == "flask"
        assert t["enabled"] is True
        # Never done → is_overdue should be True (next_due=now)
        assert t["is_overdue"] is True

    def test_03_update_task(self, api):
        tid = pytest.maint_tid
        r = api.put(
            f"{BASE_URL}/api/maintenance/{tid}",
            json={"name": "TEST_ph_calibration_v2", "interval_days": 21},
            timeout=10,
        )
        assert r.status_code == 200
        tasks = _get_maint(api)
        t = _find_task(tasks, tid)
        assert t["name"] == "TEST_ph_calibration_v2"
        assert t["interval_days"] == 21

    def test_04_toggle_enabled(self, api):
        tid = pytest.maint_tid
        r = api.put(f"{BASE_URL}/api/maintenance/{tid}",
                    json={"enabled": False}, timeout=10)
        assert r.status_code == 200
        t = _find_task(_get_maint(api), tid)
        assert t["enabled"] is False
        # re-enable
        api.put(f"{BASE_URL}/api/maintenance/{tid}", json={"enabled": True}, timeout=10)

    def test_05_mark_done_resets_timer(self, api):
        tid = pytest.maint_tid
        r = api.post(f"{BASE_URL}/api/maintenance/{tid}/done", timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert "last_done_at" in body
        t = _find_task(_get_maint(api), tid)
        assert t["is_overdue"] is False
        # interval was 21 → days_remaining should be ~21
        assert 20.5 <= t["days_remaining"] <= 21.1, t["days_remaining"]

    def test_06_dashboard_summary_has_maintenance(self, api):
        r = api.get(f"{BASE_URL}/api/dashboard/summary", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert "maintenance" in body
        assert isinstance(body["maintenance"], list)
        assert len(body["maintenance"]) >= 3  # 3 defaults + our test task
        sample = body["maintenance"][0]
        for f in ("id", "name", "icon", "interval_days", "days_remaining",
                  "is_overdue", "next_due_at"):
            assert f in sample

    def test_07_delete_task(self, api):
        tid = pytest.maint_tid
        r = api.delete(f"{BASE_URL}/api/maintenance/{tid}", timeout=10)
        assert r.status_code == 200
        tasks = _get_maint(api)
        assert _find_task(tasks, tid) is None

    def test_08_update_missing_returns_404(self, api):
        r = api.put(f"{BASE_URL}/api/maintenance/nonexistent-xyz",
                    json={"name": "x"}, timeout=10)
        assert r.status_code == 404

    def test_09_done_missing_returns_404(self, api):
        r = api.post(f"{BASE_URL}/api/maintenance/nonexistent-xyz/done", timeout=10)
        assert r.status_code == 404

    def test_10_create_without_name_returns_400(self, api):
        r = api.post(f"{BASE_URL}/api/maintenance",
                     json={"interval_days": 5}, timeout=10)
        assert r.status_code == 400


# ---------------- EVENTS ENRICHMENT ----------------
def _ensure(api, eid, state):
    api.post(f"{BASE_URL}/api/equipment/{eid}/toggle",
             json={"state": state}, timeout=10)


class TestEventsEnrichment:
    def test_01_events_shape_has_new_fields(self, api):
        r = api.get(f"{BASE_URL}/api/equipment/events?limit=5", timeout=10)
        assert r.status_code == 200
        for ev in r.json()["events"]:
            assert "water_temp" in ev
            assert "duration_seconds" in ev

    def test_02_new_events_have_water_temp(self, api):
        # Trigger a new ON then OFF for filtration
        _ensure(api, "filtration", False)
        time.sleep(0.3)
        _ensure(api, "filtration", True)
        time.sleep(0.5)
        _ensure(api, "filtration", False)
        time.sleep(0.5)
        r = api.get(
            f"{BASE_URL}/api/equipment/events?limit=5&equipment_id=filtration",
            timeout=10,
        )
        evs = r.json()["events"]
        assert len(evs) >= 2
        # The two most recent should be OFF then ON, both with water_temp
        off_ev = evs[0]
        on_ev = evs[1]
        assert off_ev["action"] == "off"
        assert on_ev["action"] == "on"
        assert isinstance(off_ev["water_temp"], (int, float))
        assert isinstance(on_ev["water_temp"], (int, float))
        assert 15 < off_ev["water_temp"] < 40

    def test_03_duration_computed_for_off(self, api):
        _ensure(api, "filtration", False)
        time.sleep(0.3)
        _ensure(api, "filtration", True)
        # keep it on ~2 seconds
        time.sleep(2.1)
        _ensure(api, "filtration", False)
        time.sleep(0.4)
        r = api.get(
            f"{BASE_URL}/api/equipment/events?limit=2&equipment_id=filtration",
            timeout=10,
        )
        evs = r.json()["events"]
        off_ev = evs[0]
        assert off_ev["action"] == "off"
        assert off_ev["duration_seconds"] is not None
        assert 1 <= off_ev["duration_seconds"] <= 10

    def test_04_duration_null_for_on_events(self, api):
        r = api.get(
            f"{BASE_URL}/api/equipment/events?limit=20&equipment_id=filtration",
            timeout=10,
        )
        evs = r.json()["events"]
        on_events = [e for e in evs if e["action"] == "on"]
        assert on_events, "expected at least one ON event"
        for e in on_events:
            assert e["duration_seconds"] is None

    def test_05_filter_by_equipment_id(self, api):
        r = api.get(
            f"{BASE_URL}/api/equipment/events?equipment_id=filtration&limit=10",
            timeout=10,
        )
        for e in r.json()["events"]:
            assert e["equipment_id"] == "filtration"
