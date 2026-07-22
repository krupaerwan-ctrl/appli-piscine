import React, { useEffect, useState } from "react";
import { View, StyleSheet, ScrollView } from "react-native";
import { COLORS, SPACING } from "../lib/theme";
import {
  TempWaveCard, MetricCard, HistoryChartCard, PressureCard,
  EquipmentCard, ScheduleCard, SystemStateCard, AlertsCard, PumpControlCard,
  MaintenanceCard,
} from "../components/Widgets";
import { api } from "../lib/api";

type Props = { data: any; reload: () => void; onNavigate?: (key: string) => void };

// Preferred min-widths per widget so the flex-wrap grid still looks clean
const W: Record<string, number> = {
  pump: 520,
  temp: 220, ph: 220, orp: 220, salinity: 220,
  history: 480, pressure: 240,
  equipment: 280, schedule: 280, system: 280, alerts: 280,
  maintenance: 380,
};

export const DashboardScreen: React.FC<Props> = ({ data, reload, onToggleEquipment, onNavigate }) => {
  const [history, setHistory] = useState<any[]>([]);
  const [histRange, setHistRange] = useState<"24h" | "7j">("24h");
  useEffect(() => {
    const hours = histRange === "7j" ? 168 : 24;
    api.history("temp", hours).then((r) => {
      const isMulti = hours > 24;
      const pts = r.points.map((p: any) => {
        const d = new Date(p.ts);
        return {
          value: p.value,
          label: isMulti
            ? d.toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "")
            : d.getHours() + "h",
        };
      });
      setHistory(pts);
    }).catch(() => {});
  }, [histRange]);

  if (!data) return <View style={{ flex: 1, backgroundColor: COLORS.surface }} />;

  const settings = data.settings || {};
  const sensors: Record<string, any> = {};
  (data.sensors || []).forEach((r: any) => (sensors[r.metric] = r));

  async function toggleEquipment(id: string, next: boolean) {
    await onToggleEquipment(id, next);
  }

  const orderedWidgets = [...(data.widgets || [])]
    .filter((w: any) => w.enabled)
    .sort((a: any, b: any) => a.order - b.order);

  const renderWidget = (id: string) => {
    switch (id) {
      case "pump": {
        const p = data.pump || {
          state: false, today_hours: 0, week_hours: 0,
          manual_override: false, auto_filtration: true,
          water_temp: sensors.temp?.value ?? 0,
          recommended_hours: data.recommended_filtration_hours ?? 0,
        };
        return (
          <PumpControlCard
            state={!!p.state}
            todayHours={Number(p.today_hours) || 0}
            weekHours={Number(p.week_hours) || 0}
            manualOverride={!!p.manual_override}
            autoFiltration={!!p.auto_filtration}
            waterTemp={Number(p.water_temp) || 0}
            recommendedHours={Number(p.recommended_hours) || 0}
            onToggle={(next) => toggleEquipment("filtration", next)}
            onClearOverride={async () => {
              try { await api.clearPumpOverride(); } catch {}
              reload();
            }}
          />
        );
      }
      case "temp":
        return <TempWaveCard value={sensors.temp?.value ?? 0} target={settings.temp_target ?? 28} />;
      case "ph":
        return (
          <MetricCard testID="widget-ph" label="pH" icon="water-outline" color={COLORS.metricPh}
            value={(sensors.ph?.value ?? 0).toFixed(1)} unit=""
            target={`Consigne : ${settings.ph_min} – ${settings.ph_max}`}
            min={6.8} max={7.6} current={sensors.ph?.value ?? 7} />
        );
      case "orp":
        return (
          <MetricCard testID="widget-orp" label="Redox (ORP)" icon="sync-circle" color={COLORS.metricOrp}
            value={sensors.orp?.value ?? 0} unit="mV"
            target={`Consigne : ${settings.orp_min} – ${settings.orp_max} mV`}
            min={450} max={850} current={sensors.orp?.value ?? 650} />
        );
      case "salinity":
        return (
          <MetricCard testID="widget-salinity" label="Sel (Salinité)" icon="sparkles" color={COLORS.metricSalinity}
            value={sensors.salinity?.value ?? 0} unit="ppm"
            target={`Consigne : ${settings.salinity_min} – ${settings.salinity_max} ppm`}
            min={2500} max={4500} current={sensors.salinity?.value ?? 3500} />
        );
      case "history":
        return <HistoryChartCard points={history} range={histRange} onRangeChange={setHistRange} />;
      case "pressure":
        return (
          <PressureCard
            pressure={sensors.pressure?.value ?? 0}
            min={settings.pressure_min ?? 0.5}
            max={settings.pressure_max ?? 1.5}
          />
        );
      case "equipment":
        return <EquipmentCard items={data.equipment || []} onToggle={toggleEquipment} />;
      case "schedule":
        return (
          <ScheduleCard
            schedules={data.schedules || []}
            totalHours={computeTotal(data.schedules || [])}
            recommended={data.recommended_filtration_hours}
          />
        );
      case "system":
        return (
          <SystemStateCard
            zigbee={data.system.zigbee}
            mqtt={data.system.mqtt}
            sensors={data.system.sensors}
            lastUpdate={data.system.last_update}
          />
        );
      case "alerts":
        return <AlertsCard alerts={data.latest_alerts || []} />;
      case "maintenance":
        return (
          <MaintenanceCard
            tasks={data.maintenance || []}
            onDone={async (id) => {
              try { await api.markMaintenanceDone(id); } catch {}
              reload();
            }}
            onManage={() => onNavigate?.("maintenance")}
          />
        );
    }
    return null;
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: COLORS.surface }}
      contentContainerStyle={s.wrap} testID="dashboard-screen">
      <View style={s.grid}>
        {orderedWidgets.map((w: any) => (
          <View
            key={w.id}
            style={{ minWidth: W[w.id] || 240, flexGrow: 1, flexBasis: W[w.id] || 240 }}
          >
            {renderWidget(w.id)}
          </View>
        ))}
      </View>
    </ScrollView>
  );
};

function computeTotal(scheds: any[]): number {
  let total = 0;
  for (const s of scheds) {
    if (!s.enabled) continue;
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    const a = sh + sm / 60;
    const b = eh + em / 60;
    total += b > a ? b - a : 24 - a + b;
  }
  return Math.round(total * 10) / 10;
}

const s = StyleSheet.create({
  wrap: { padding: SPACING.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.md },
});
