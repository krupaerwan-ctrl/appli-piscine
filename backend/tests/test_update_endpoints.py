"""Tests for new maintenance/update endpoints and regression on legacy ones."""
import os
import time
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


def _wait_for_state(s, target_states, timeout=20):
    """Poll /status until state is one of target_states, or timeout."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = s.get(f"{API}/system/update/status", timeout=10)
        assert r.status_code == 200
        last = r.json()
        if last["state"] in target_states:
            return last
        time.sleep(1)
    return last


class TestUpdateStatus:
    def test_status_shape(self, s):
        r = s.get(f"{API}/system/update/status", timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert "state" in d and "log" in d
        assert d["state"] in {"idle", "running", "success", "failed"}


class TestUpdateOnline:
    def test_online_starts_then_fails_in_preview(self, s):
        # Reset by waiting until not-running (previous test may have left running)
        _wait_for_state(s, {"idle", "success", "failed"}, timeout=10)

        r = s.post(f"{API}/system/update/online", timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body == {"ok": True, "state": "running"}

        final = _wait_for_state(s, {"failed", "success"}, timeout=25)
        assert final is not None
        # In preview: update.sh runs (POOLKIOSK_HOME defaults to /app) and fails
        # on `git pull` because /app has no tracking branch. Mechanism validated.
        assert final["state"] == "failed", f"expected failed, got {final}"
        log = final["log"] or ""
        # Log should be useful and mention some failure indicator
        assert log.strip() != "", "log should not be empty"
        assert ("échoué" in log) or ("!!" in log) or ("failed" in log.lower()) or ("introuvable" in log), \
            f"log lacks failure indication: {log[:400]}"


class TestUpdateLock:
    def test_second_online_returns_409(self, s):
        """Fire two POSTs in near-simultaneous fashion via threads to catch the
        race window while state==running before subprocess completes.

        NOTE: In preview, subprocess (`update.sh online`) fails almost instantly
        because /app has no git tracking branch. Combined with the file-based
        lock (state file), this creates a TOCTOU race: both requests can read
        state != "running" and both start updates. This is a real bug worth
        flagging to the main agent (server should use an in-memory asyncio.Lock
        set BEFORE spawning subprocess, not just the file marker)."""
        import threading
        _wait_for_state(s, {"idle", "success", "failed"}, timeout=15)

        results = []

        def fire():
            try:
                rr = requests.post(f"{API}/system/update/online", timeout=10)
                results.append(rr.status_code)
            except Exception as ex:
                results.append(str(ex))

        threads = [threading.Thread(target=fire) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        assert 200 in results, f"one call should return 200: {results}"
        # Lock ideally returns 409 for the second call
        assert 409 in results, (
            f"expected 409 lock on concurrent call, got {results}. "
            "BUG: lock uses file marker that can race; use asyncio.Lock instead."
        )

        _wait_for_state(s, {"failed", "success"}, timeout=25)


class TestUpdateUsb:
    def test_usb_starts_then_fails(self, s):
        _wait_for_state(s, {"idle", "success", "failed"}, timeout=15)

        r = s.post(f"{API}/system/update/usb", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True, "state": "running"}

        final = _wait_for_state(s, {"failed", "success"}, timeout=25)
        assert final["state"] == "failed"
        log = final["log"] or ""
        assert log.strip() != ""
        assert ("échoué" in log) or ("!!" in log) or ("introuvable" in log) or ("USB" in log), \
            f"log lacks failure indication: {log[:400]}"


class TestExitKiosk:
    def test_exit_kiosk_returns_ok(self, s):
        r = s.post(f"{API}/system/exit-kiosk", timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True}


class TestRegression:
    def test_dashboard_summary_still_works(self, s):
        r = s.get(f"{API}/dashboard/summary", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert len(d["sensors"]) == 6
        assert len(d["equipment"]) == 4

    def test_sensors_latest_still_works(self, s):
        r = s.get(f"{API}/sensors/latest", timeout=10)
        assert r.status_code == 200
        assert len(r.json()["readings"]) == 6

    def test_equipment_still_works(self, s):
        r = s.get(f"{API}/equipment", timeout=10)
        assert r.status_code == 200
        assert len(r.json()["equipment"]) == 4
