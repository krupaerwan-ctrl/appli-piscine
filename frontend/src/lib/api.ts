// API client for pool kiosk backend
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

async function req(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const api = {
  summary: () => req("/dashboard/summary"),
  latest: () => req("/sensors/latest"),
  history: (metric = "temp", hours = 24) =>
    req(`/sensors/history?metric=${metric}&hours=${hours}`),
  equipment: () => req("/equipment"),
  toggleEquipment: (id: string, state: boolean) =>
    req(`/equipment/${id}/toggle`, { method: "POST", body: JSON.stringify({ state }) }),
  schedule: () => req("/schedule"),
  addSchedule: (s: any) => req("/schedule", { method: "POST", body: JSON.stringify(s) }),
  updateSchedule: (id: string, s: any) =>
    req(`/schedule/${id}`, { method: "PUT", body: JSON.stringify(s) }),
  deleteSchedule: (id: string) => req(`/schedule/${id}`, { method: "DELETE" }),
  settings: () => req("/settings"),
  updateSettings: (payload: any) =>
    req("/settings", { method: "PUT", body: JSON.stringify(payload) }),
  alerts: () => req("/alerts"),
  ackAlert: (id: string) => req(`/alerts/${id}/ack`, { method: "POST" }),
  clearAlerts: () => req("/alerts", { method: "DELETE" }),
  widgets: () => req("/widgets"),
  updateWidgets: (widgets: any[]) =>
    req("/widgets", { method: "PUT", body: JSON.stringify(widgets) }),
  system: () => req("/system/status"),
  wifi: () => req("/system/wifi"),
  pumpRuntime: () => req("/equipment/pump/runtime"),
  clearPumpOverride: () => req("/equipment/pump/clear-override", { method: "POST" }),
  autoApplySchedule: () => req("/schedule/auto-apply", { method: "POST" }),
};

export type Sensor = { metric: string; value: number; unit: string };
export type Equipment = { id: string; name: string; icon: string; state: boolean; auto_managed?: boolean };
export type Schedule = { id: string; start: string; end: string; enabled: boolean };
export type Widget = { id: string; name: string; enabled: boolean; order: number };
export type Alert = { id: string; level: string; title: string; message: string; acknowledged: boolean; ts: string };
