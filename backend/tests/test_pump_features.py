"""Backend tests for the new PoolKiosk pump/schedule features (iteration 9)."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback to the value in frontend/.env for local runs
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("EXPO_PUBLIC_BACKEND_URL"):
                BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---------------- Pump / Dashboard shape ----------------
class TestDashboardPump:
    def test_dashboard_summary_has_pump(self, api):
        r = api.get(f"{BASE_URL}/api/dashboard/summary", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "pump" in data, "dashboard.summary must expose a `pump` object"
        p = data["pump"]
        expected_keys = {"state", "today_hours", "week_hours", "manual_override",
                         "auto_filtration", "water_temp", "recommended_hours"}
        assert expected_keys.issubset(p.keys()), (
            f"Missing keys in pump: {expected_keys - set(p.keys())}"
        )
        assert isinstance(p["state"], bool)
        assert isinstance(p["manual_override"], bool)
        assert isinstance(p["auto_filtration"], bool)
        assert isinstance(p["today_hours"], (int, float))
        assert isinstance(p["week_hours"], (int, float))
        assert isinstance(p["water_temp"], (int, float))
        assert isinstance(p["recommended_hours"], (int, float))
        # Rule: recommended = temp/2, bounded [4, 24]
        expected_rec = max(4.0, min(24.0, p["water_temp"] / 2.0))
        assert abs(p["recommended_hours"] - round(expected_rec, 1)) <= 0.15, (
            f"recommended_hours={p['recommended_hours']} not ~= temp/2 for temp={p['water_temp']}"
        )

    def test_pump_runtime_same_shape(self, api):
        r = api.get(f"{BASE_URL}/api/equipment/pump/runtime", timeout=15)
        assert r.status_code == 200, r.text
        p = r.json()
        expected_keys = {"state", "today_hours", "week_hours", "manual_override",
                         "auto_filtration", "water_temp", "recommended_hours"}
        assert expected_keys.issubset(p.keys())


# ---------------- Manual override lifecycle ----------------
class TestManualOverride:
    def test_toggle_pump_sets_manual_override(self, api):
        # First clear any prior override
        r = api.post(f"{BASE_URL}/api/equipment/pump/clear-override", timeout=10)
        assert r.status_code == 200, r.text
        # Read current pump state
        r = api.get(f"{BASE_URL}/api/equipment/pump/runtime", timeout=10).json()
        cur = bool(r["state"])
        # Toggle pump to opposite state
        r2 = api.post(
            f"{BASE_URL}/api/equipment/filtration/toggle",
            json={"state": not cur}, timeout=10,
        )
        # electrolyseur-without-pump business rule may make it 409 only if starting
        # electrolyseur; filtration itself should always succeed.
        assert r2.status_code == 200, r2.text
        # Verify manual_override is now True
        r3 = api.get(f"{BASE_URL}/api/equipment/pump/runtime", timeout=10).json()
        assert r3["manual_override"] is True, (
            "manual_override must be True after user toggles pump"
        )
        assert bool(r3["state"]) == (not cur), (
            f"Pump state should reflect toggle; expected {not cur}, got {r3['state']}"
        )

    def test_clear_override_returns_ok_and_clears_flag(self, api):
        r = api.post(f"{BASE_URL}/api/equipment/pump/clear-override", timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        r2 = api.get(f"{BASE_URL}/api/equipment/pump/runtime", timeout=10).json()
        assert r2["manual_override"] is False


# ---------------- Auto-apply schedule ----------------
class TestAutoApply:
    def test_auto_apply_returns_hours_slots_and_persists(self, api):
        r = api.post(f"{BASE_URL}/api/schedule/auto-apply", timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert "hours" in body and "slots" in body and "water_temp" in body
        assert isinstance(body["slots"], list)
        # Rule: temp/2, clamped [4, 24]
        expected = max(4.0, min(24.0, float(body["water_temp"]) / 2.0))
        assert abs(body["hours"] - round(expected, 1)) <= 0.15

        # Verify the schedules table was replaced by these slots.
        r2 = api.get(f"{BASE_URL}/api/schedule", timeout=10).json()
        assert len(r2["schedules"]) == len(body["slots"]), (
            f"Auto-apply must replace schedules table. Got {len(r2['schedules'])} rows, expected {len(body['slots'])}"
        )
        # Every returned slot's start/end must exist in the persisted list
        persisted = {(s["start"], s["end"]) for s in r2["schedules"]}
        for slot in body["slots"]:
            assert (slot["start"], slot["end"]) in persisted, (
                f"Slot {slot} missing from persisted schedules {persisted}"
            )


# ---------------- Regression: existing endpoints still work ----------------
class TestRegression:
    def test_wifi_endpoint(self, api):
        r = api.get(f"{BASE_URL}/api/system/wifi", timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert "available" in d and "connected" in d

    def test_history_endpoint(self, api):
        r = api.get(f"{BASE_URL}/api/sensors/history?metric=temp&hours=168", timeout=10)
        assert r.status_code == 200
        assert "points" in r.json()

    def test_history_24h(self, api):
        r = api.get(f"{BASE_URL}/api/sensors/history?metric=temp&hours=24", timeout=10)
        assert r.status_code == 200
        assert "points" in r.json()
