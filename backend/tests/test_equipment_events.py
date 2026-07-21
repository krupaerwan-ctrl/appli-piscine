"""Tests for equipment_events journal (iteration 5)."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://pool-filter-hub.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _events(api, **params):
    r = api.get(f"{BASE_URL}/api/equipment/events", params=params, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["events"]


def _set(api, eid, state):
    r = api.post(f"{BASE_URL}/api/equipment/{eid}/toggle", json={"state": state}, timeout=10)
    return r


def _ensure_state(api, eid, state):
    """Force equipment into a state via toggle; ignore result."""
    r = api.post(f"{BASE_URL}/api/equipment/{eid}/toggle", json={"state": state}, timeout=10)
    return r.status_code


# ---------- Journal endpoint ----------
class TestEquipmentEvents:
    def test_01_initial_state(self, api):
        """Fresh DB → after backend start seed defaults. Journal may or may not be empty
        depending on prior activity; require endpoint returns 200 and list shape."""
        r = api.get(f"{BASE_URL}/api/equipment/events", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert "events" in body and isinstance(body["events"], list)

    def test_02_toggle_filtration_off_creates_user_event(self, api):
        # Prime: make sure filtration is ON first
        _ensure_state(api, "filtration", True)
        # Ensure electrolyseur is off to isolate the event (pump on required for elec on).
        _ensure_state(api, "electrolyseur", False)
        before = len(_events(api, equipment_id="filtration"))
        r = _set(api, "filtration", False)
        assert r.status_code == 200
        time.sleep(0.3)
        evts = _events(api, equipment_id="filtration")
        assert len(evts) >= before + 1
        latest = evts[0]
        assert latest["equipment_id"] == "filtration"
        assert latest["action"] == "off"
        assert latest["source"] == "user"
        assert "manuelle" in (latest["reason"] or "").lower()

    def test_03_coupling_stops_electrolyseur(self, api):
        # Start pump then electrolyseur
        _ensure_state(api, "filtration", True)
        time.sleep(0.2)
        r_elec = _set(api, "electrolyseur", True)
        assert r_elec.status_code == 200
        time.sleep(0.2)
        # Stop pump → must create 2 events: filtration off (user) + electrolyseur off (coupling)
        _set(api, "filtration", False)
        time.sleep(0.3)
        all_evts = _events(api)
        # inspect the 2 most recent
        top2 = all_evts[:2]
        sources = {(e["equipment_id"], e["source"], e["action"]) for e in top2}
        assert ("filtration", "user", "off") in sources
        assert ("electrolyseur", "coupling", "off") in sources
        coupl = [e for e in top2 if e["source"] == "coupling"][0]
        assert coupl["reason"] == "Arrêt automatique suite à l'arrêt de la pompe"

    def test_04_filter_by_equipment_id(self, api):
        # Make sure we have events for multiple equipment: toggle lighting on/off
        _ensure_state(api, "lighting", True)
        time.sleep(0.2)
        _ensure_state(api, "lighting", False)
        time.sleep(0.3)
        filt = _events(api, equipment_id="filtration")
        assert len(filt) > 0
        assert all(e["equipment_id"] == "filtration" for e in filt)
        light = _events(api, equipment_id="lighting")
        assert len(light) > 0
        assert all(e["equipment_id"] == "lighting" for e in light)

    def test_05_limit_param(self, api):
        r = _events(api, limit=1)
        assert len(r) == 1

    def test_06_electrolyseur_without_pump_returns_409_no_event(self, api):
        # Ensure pump is off
        _ensure_state(api, "electrolyseur", False)
        _ensure_state(api, "filtration", False)
        time.sleep(0.2)
        count_before = len(_events(api, equipment_id="electrolyseur"))
        r = _set(api, "electrolyseur", True)
        assert r.status_code == 409
        time.sleep(0.3)
        count_after = len(_events(api, equipment_id="electrolyseur"))
        assert count_after == count_before, "409 must not create event"

    def test_07_noop_toggle_does_not_log(self, api):
        # lighting is off currently. Toggle it off again → no new event.
        _ensure_state(api, "lighting", False)
        time.sleep(0.2)
        before = len(_events(api, equipment_id="lighting"))
        r = _set(api, "lighting", False)
        assert r.status_code == 200
        time.sleep(0.3)
        after = len(_events(api, equipment_id="lighting"))
        assert after == before, "noop toggle must NOT add an event"
