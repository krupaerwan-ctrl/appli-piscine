"""Pool Kiosk backend tests - covers all API endpoints from review request."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://pool-filter-hub.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


# --- Dashboard summary ---
class TestDashboard:
    def test_summary_structure(self, s):
        r = s.get(f"{API}/dashboard/summary", timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert len(d["sensors"]) == 6
        assert len(d["equipment"]) == 4
        assert len(d["schedules"]) >= 3
        assert len(d["widgets"]) == 10
        assert "settings" in d
        assert "system" in d
        assert "recommended_filtration_hours" in d
        assert isinstance(d["recommended_filtration_hours"], (int, float))


# --- Sensors ---
class TestSensors:
    def test_latest_6_metrics(self, s):
        r = s.get(f"{API}/sensors/latest", timeout=10)
        assert r.status_code == 200
        d = r.json()
        metrics = {x["metric"] for x in d["readings"]}
        assert metrics == {"temp", "ph", "orp", "salinity", "pressure", "outdoor_temp"}

    def test_history_temp_24h(self, s):
        r = s.get(f"{API}/sensors/history?metric=temp&hours=24", timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert d["metric"] == "temp"
        assert len(d["points"]) > 5


# --- Equipment ---
class TestEquipment:
    def test_toggle_filtration_and_verify(self, s):
        r = s.post(f"{API}/equipment/filtration/toggle", json={"state": False}, timeout=10)
        assert r.status_code == 200
        assert r.json()["state"] is False
        r2 = s.get(f"{API}/equipment", timeout=10)
        assert r2.status_code == 200
        filt = next(e for e in r2.json()["equipment"] if e["id"] == "filtration")
        assert filt["state"] is False
        # restore
        s.post(f"{API}/equipment/filtration/toggle", json={"state": True}, timeout=10)


# --- Schedule ---
class TestSchedule:
    def test_add_and_delete(self, s):
        r = s.post(f"{API}/schedule", json={"start": "10:00", "end": "11:00", "enabled": True}, timeout=10)
        assert r.status_code == 200
        sid = r.json()["id"]
        assert sid
        # verify present
        r2 = s.get(f"{API}/schedule", timeout=10)
        assert any(x["id"] == sid for x in r2.json()["schedules"])
        # delete
        r3 = s.delete(f"{API}/schedule/{sid}", timeout=10)
        assert r3.status_code == 200
        r4 = s.get(f"{API}/schedule", timeout=10)
        assert not any(x["id"] == sid for x in r4.json()["schedules"])


# --- Settings ---
class TestSettings:
    def test_update_and_get(self, s):
        r = s.put(f"{API}/settings", json={"temp_target": 29.5, "ph_min": 7.1}, timeout=10)
        assert r.status_code == 200
        assert r.json()["temp_target"] == 29.5
        r2 = s.get(f"{API}/settings", timeout=10)
        assert r2.status_code == 200
        assert r2.json()["temp_target"] == 29.5
        assert r2.json()["ph_min"] == 7.1
        # restore
        s.put(f"{API}/settings", json={"temp_target": 28.0, "ph_min": 7.0}, timeout=10)


# --- Widgets ---
class TestWidgets:
    def test_bulk_update_disable(self, s):
        r = s.get(f"{API}/widgets", timeout=10)
        widgets = r.json()["widgets"]
        assert len(widgets) == 10
        # disable "alerts" widget
        for w in widgets:
            if w["id"] == "alerts":
                w["enabled"] = False
        r2 = s.put(f"{API}/widgets", json=widgets, timeout=10)
        assert r2.status_code == 200
        r3 = s.get(f"{API}/widgets", timeout=10)
        alerts_w = next(w for w in r3.json()["widgets"] if w["id"] == "alerts")
        assert alerts_w["enabled"] is False
        # restore
        for w in widgets:
            if w["id"] == "alerts":
                w["enabled"] = True
        s.put(f"{API}/widgets", json=widgets, timeout=10)


# --- Alerts ---
class TestAlerts:
    def test_get_alerts_returns_array(self, s):
        r = s.get(f"{API}/alerts", timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json()["alerts"], list)


# --- System ---
class TestSystem:
    def test_status(self, s):
        r = s.get(f"{API}/system/status", timeout=10)
        assert r.status_code == 200
        d = r.json()
        for k in ("zigbee", "mqtt", "sensors", "last_update"):
            assert k in d



# --- Zigbee devices (NEW feature) ---
class TestZigbee:
    def test_list_9_seeded_devices(self, s):
        r = s.get(f"{API}/zigbee/devices", timeout=10)
        assert r.status_code == 200, r.text
        devs = r.json()["devices"]
        assert len(devs) == 9, f"expected 9 seeded, got {len(devs)}"
        relays = [d for d in devs if d["device_type"] == "relay"]
        sensors = [d for d in devs if d["device_type"] == "sensor"]
        assert len(relays) == 4
        assert len(sensors) == 5
        # every device has an assigned_role predefined (not empty/None)
        for d in devs:
            assert d.get("assigned_role"), f"missing assigned_role: {d}"

    def test_update_assigned_role(self, s):
        r0 = s.get(f"{API}/zigbee/devices", timeout=10)
        dev = r0.json()["devices"][0]
        did = dev["id"]
        original_role = dev["assigned_role"]
        # change role
        r = s.put(f"{API}/zigbee/devices/{did}",
                  json={"assigned_role": "lighting"}, timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True}
        # verify persisted
        r2 = s.get(f"{API}/zigbee/devices", timeout=10)
        updated = next(d for d in r2.json()["devices"] if d["id"] == did)
        assert updated["assigned_role"] == "lighting"
        # restore
        s.put(f"{API}/zigbee/devices/{did}",
              json={"assigned_role": original_role}, timeout=10)

    def test_update_friendly_name(self, s):
        r0 = s.get(f"{API}/zigbee/devices", timeout=10)
        dev = r0.json()["devices"][0]
        did = dev["id"]
        original_name = dev["friendly_name"]
        r = s.put(f"{API}/zigbee/devices/{did}",
                  json={"friendly_name": "TEST_new_name"}, timeout=10)
        assert r.status_code == 200
        r2 = s.get(f"{API}/zigbee/devices", timeout=10)
        updated = next(d for d in r2.json()["devices"] if d["id"] == did)
        assert updated["friendly_name"] == "TEST_new_name"
        # restore
        s.put(f"{API}/zigbee/devices/{did}",
              json={"friendly_name": original_name}, timeout=10)

    def test_update_nonexistent_returns_404(self, s):
        r = s.put(f"{API}/zigbee/devices/does-not-exist",
                  json={"assigned_role": "lighting"}, timeout=10)
        assert r.status_code == 404

    def test_rescan_returns_devices(self, s):
        r = s.post(f"{API}/zigbee/devices/rescan", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert isinstance(body["devices"], list)
        assert len(body["devices"]) == 9


# --- Coupling logic (electrolyseur <-> filtration) ---
class TestCoupling:
    def _set_pump(self, s, state: bool):
        return s.post(f"{API}/equipment/filtration/toggle",
                      json={"state": state}, timeout=10)

    def _set_elec(self, s, state: bool):
        return s.post(f"{API}/equipment/electrolyseur/toggle",
                      json={"state": state}, timeout=10)

    def test_elec_cannot_start_without_pump(self, s):
        # Ensure pump is OFF (this also stops electrolyseur silently)
        self._set_pump(s, False)
        r = self._set_elec(s, True)
        assert r.status_code == 409, r.text
        # Message should be in French and explicit
        msg = r.json().get("detail", "")
        assert "pompe" in msg.lower()
        assert "électrolyseur" in msg.lower() or "electrolyseur" in msg.lower()
        # restore state (pump ON so other tests are unaffected)
        self._set_pump(s, True)

    def test_elec_starts_when_pump_on(self, s):
        # Pump ON
        r0 = self._set_pump(s, True)
        assert r0.status_code == 200
        r = self._set_elec(s, True)
        assert r.status_code == 200, r.text
        assert r.json()["state"] is True
        # cleanup: turn elec off to keep tests idempotent
        self._set_elec(s, False)

    def test_stopping_pump_also_stops_elec_and_creates_info_alert(self, s):
        # Set state pump=ON, elec=ON
        assert self._set_pump(s, True).status_code == 200
        assert self._set_elec(s, True).status_code == 200
        # Now stop the pump
        r = self._set_pump(s, False)
        assert r.status_code == 200
        # Verify electrolyseur was cut
        eq = s.get(f"{API}/equipment", timeout=10).json()["equipment"]
        elec = next(e for e in eq if e["id"] == "electrolyseur")
        assert elec["state"] is False, "electrolyseur should be stopped when pump stops"
        # Verify an info alert with title 'Électrolyseur arrêté' exists
        alerts = s.get(f"{API}/alerts?limit=20", timeout=10).json()["alerts"]
        info_alert = next(
            (a for a in alerts if a["level"] == "info"
             and "Électrolyseur arrêté" in a["title"]),
            None,
        )
        assert info_alert is not None, f"expected info alert; got {alerts[:3]}"
        # restore pump ON
        self._set_pump(s, True)
