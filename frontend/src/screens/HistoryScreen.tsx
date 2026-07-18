import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { LineChart } from "react-native-gifted-charts";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

const METRICS: { key: string; label: string; unit: string; color: string }[] = [
  { key: "temp", label: "Température", unit: "°C", color: COLORS.metricTemp },
  { key: "ph", label: "pH", unit: "", color: COLORS.metricPh },
  { key: "orp", label: "Redox (ORP)", unit: "mV", color: COLORS.metricOrp },
  { key: "salinity", label: "Salinité", unit: "ppm", color: COLORS.metricSalinity },
  { key: "pressure", label: "Pression", unit: "bar", color: COLORS.metricPressure },
];

const RANGES = [
  { label: "24h", hours: 24 },
  { label: "7 j", hours: 168 },
];

export const HistoryScreen: React.FC = () => {
  const [metric, setMetric] = useState("temp");
  const [hours, setHours] = useState(24);
  const [points, setPoints] = useState<any[]>([]);

  useEffect(() => {
    api.history(metric, hours).then((r) => {
      const data = r.points.map((p: any) => ({
        value: p.value,
        label: new Date(p.ts).getHours() + "h",
      }));
      setPoints(data);
    }).catch(() => setPoints([]));
  }, [metric, hours]);

  const m = METRICS.find((x) => x.key === metric)!;
  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="history-screen">
      <Text style={s.title}>Historique</Text>
      <View style={s.chips}>
        {METRICS.map((mt) => (
          <Pressable
            key={mt.key}
            onPress={() => setMetric(mt.key)}
            style={[s.chip, metric === mt.key && { borderColor: mt.color, backgroundColor: COLORS.surfaceTertiary }]}
            testID={`metric-chip-${mt.key}`}
          >
            <View style={[s.chipDot, { backgroundColor: mt.color }]} />
            <Text style={[s.chipText, metric === mt.key && { color: COLORS.text }]}>{mt.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.chips}>
        {RANGES.map((r) => (
          <Pressable
            key={r.hours}
            onPress={() => setHours(r.hours)}
            style={[s.chip, hours === r.hours && { borderColor: COLORS.brand, backgroundColor: COLORS.surfaceTertiary }]}
            testID={`range-chip-${r.hours}`}
          >
            <Text style={[s.chipText, hours === r.hours && { color: COLORS.text }]}>{r.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={s.card}>
        <Text style={{ color: COLORS.textSecondary, fontSize: FS.lg, marginBottom: SPACING.md }}>
          {m.label} {m.unit ? `(${m.unit})` : ""}
        </Text>
        {points.length > 1 ? (
          <LineChart
            data={points}
            height={280}
            width={720}
            adjustToWidth
            hideDataPoints
            thickness={2}
            color={m.color}
            areaChart
            startFillColor={m.color}
            endFillColor={m.color}
            startOpacity={0.35}
            endOpacity={0.02}
            initialSpacing={0}
            yAxisTextStyle={{ color: COLORS.textMuted, fontSize: 10 }}
            xAxisLabelTextStyle={{ color: COLORS.textMuted, fontSize: 10 }}
            rulesColor={COLORS.border}
            yAxisColor={COLORS.border}
            xAxisColor={COLORS.border}
            noOfSections={5}
          />
        ) : (
          <Text style={{ color: COLORS.textMuted, padding: SPACING.xl }}>Aucune donnée disponible</Text>
        )}
      </View>
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.lg },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm, marginBottom: SPACING.md },
  chip: {
    flexDirection: "row", alignItems: "center", gap: SPACING.xs,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.pill,
    borderWidth: 1, borderColor: COLORS.border,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: COLORS.textMuted, fontSize: FS.sm, fontWeight: "500" },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg,
    padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.border,
  },
});
