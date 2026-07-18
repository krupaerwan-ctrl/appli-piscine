import React, { useEffect, useState } from "react";
import { View, StyleSheet, ScrollView } from "react-native";
import { COLORS, SPACING } from "../lib/theme";
import {
  TempWaveCard, MetricCard, HistoryChartCard, PressureCard,
  EquipmentCard, ScheduleCard, SystemStateCard, AlertsCard,
} from "../components/Widgets";
import { api } from "../lib/api";

type Props = { data: any; reload: () => void };

export const DashboardScreen: React.FC<Props> = ({ data, reload }) => {
  const [history, setHistory] = useState<any[]>([]);
  useEffect(() => {
    api.history("temp", 24).then((r) => {
      const pts = r.points.map((p: any) => ({
        value: p.value,
        label: new Date(p.ts).getHours() + "h",
      }));
      setHistory(pts);
    }).catch(() => {});
  }, []);

  if (!data) return <View style={{ flex: 1, backgroundColor: COLORS.surface }} />;

  const settings = data.settings || {};
  const sensors: Record<string, any> = {};
  (data.sensors || []).forEach((r: any) => (sensors[r.metric] = r));
  const enabled = new Set((data.widgets || []).filter((w: any) => w.enabled).map((w: any) => w.id));

  async function toggleEquipment(id: string, next: boolean) {
    await api.toggleEquipment(id, next);
    reload();
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: COLORS.surface }} contentContainerStyle={s.wrap}
      testID="dashboard-screen">
      {/* Row 1: metrics */}
      <View style={s.row}>
        {enabled.has("temp") && (
          <TempWaveCard value={sensors.temp?.value ?? 0} target={settings.temp_target ?? 28} />
        )}
        {enabled.has("ph") && (
          <MetricCard testID="widget-ph" label="pH" icon="water-outline" color={COLORS.metricPh}
            value={(sensors.ph?.value ?? 0).toFixed(1)} unit=""
            target={`Consigne : ${settings.ph_min} – ${settings.ph_max}`}
            min={6.8} max={7.6} current={sensors.ph?.value ?? 7} />
        )}
        {enabled.has("orp") && (
          <MetricCard testID="widget-orp" label="Redox (ORP)" icon="sync-circle" color={COLORS.metricOrp}
            value={sensors.orp?.value ?? 0} unit="mV"
            target={`Consigne : ${settings.orp_min} – ${settings.orp_max} mV`}
            min={450} max={850} current={sensors.orp?.value ?? 650} />
        )}
        {enabled.has("salinity") && (
          <MetricCard testID="widget-salinity" label="Sel (Salinité)" icon="sparkles" color={COLORS.metricSalinity}
            value={sensors.salinity?.value ?? 0} unit="ppm"
            target={`Consigne : ${settings.salinity_min} – ${settings.salinity_max} ppm`}
            min={2500} max={4500} current={sensors.salinity?.value ?? 3500} />
        )}
      </View>

      {/* Row 2 */}
      <View style={s.row}>
        {enabled.has("history") && <HistoryChartCard points={history} />}
        {enabled.has("pressure") && (
          <PressureCard
            pressure={sensors.pressure?.value ?? 0}
            min={settings.pressure_min ?? 0.5}
            max={settings.pressure_max ?? 1.5}
          />
        )}
        {enabled.has("equipment") && (
          <EquipmentCard items={data.equipment || []} onToggle={toggleEquipment} />
        )}
      </View>

      {/* Row 3 */}
      <View style={s.row}>
        {enabled.has("schedule") && (
          <ScheduleCard
            schedules={data.schedules || []}
            totalHours={computeTotal(data.schedules || [])}
            recommended={data.recommended_filtration_hours}
          />
        )}
        {enabled.has("system") && (
          <SystemStateCard
            zigbee={data.system.zigbee}
            mqtt={data.system.mqtt}
            sensors={data.system.sensors}
            lastUpdate={data.system.last_update}
          />
        )}
        {enabled.has("alerts") && (
          <AlertsCard alerts={data.latest_alerts || []} />
        )}
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
  wrap: { padding: SPACING.md, gap: SPACING.md },
  row: { flexDirection: "row", gap: SPACING.md, flexWrap: "wrap" },
});
