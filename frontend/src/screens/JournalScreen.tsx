import React, { useEffect, useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type EquipEvent = {
  id: string;
  equipment_id: string;
  action: "on" | "off" | string;
  source: string;
  reason: string | null;
  ts: string;
  water_temp: number | null;
  duration_seconds: number | null;
};

const EQUIPMENT_LABELS: Record<string, { label: string; icon: keyof typeof import("@expo/vector-icons/build/Ionicons").default.glyphMap }> = {
  filtration: { label: "Pompe filtration", icon: "cog" },
  electrolyseur: { label: "Électrolyseur", icon: "flash" },
  heat_pump: { label: "Pompe à chaleur", icon: "flame" },
  lighting: { label: "Éclairage", icon: "bulb" },
};

const SOURCE_LABEL: Record<string, string> = {
  user: "Manuel",
  scheduler: "Planning",
  safety: "Sécurité",
  coupling: "Couplage auto",
};

const FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: "Tous" },
  { key: "filtration", label: "Pompe" },
  { key: "electrolyseur", label: "Électro." },
  { key: "heat_pump", label: "PAC" },
  { key: "lighting", label: "Éclairage" },
];

function formatDuration(sec: number | null): string {
  if (sec == null || sec < 0) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

function formatTs(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString("fr-FR", {
      day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

export const JournalScreen: React.FC = () => {
  const [events, setEvents] = useState<EquipEvent[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.events(30, filter || undefined);
      setEvents(r.events || []);
    } catch { setEvents([]); }
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);
  // auto-refresh every 15s
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="journal-screen">
      <View style={s.headRow}>
        <Text style={s.title}>Journal d'événements</Text>
        <Pressable onPress={load} style={s.refreshBtn} testID="journal-refresh">
          <Ionicons name="refresh" size={18} color={COLORS.textSecondary} />
          <Text style={s.refreshText}>{loading ? "…" : "Actualiser"}</Text>
        </Pressable>
      </View>
      <Text style={s.subtitle}>
        Les 30 derniers événements équipement (démarrages, arrêts) avec heure, durée du cycle et
        température de l'eau au moment de l'événement.
      </Text>

      <View style={s.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key ?? "all"}
            onPress={() => setFilter(f.key)}
            style={[
              s.chip,
              filter === f.key && { borderColor: COLORS.brand, backgroundColor: COLORS.surfaceTertiary },
            ]}
            testID={`journal-filter-${f.key ?? "all"}`}
          >
            <Text style={[s.chipText, filter === f.key && { color: COLORS.text }]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={s.list}>
        {events.length === 0 ? (
          <Text style={s.empty}>Aucun événement à afficher.</Text>
        ) : (
          events.map((ev) => {
            const isOn = ev.action === "on";
            const meta = EQUIPMENT_LABELS[ev.equipment_id] || { label: ev.equipment_id, icon: "cog" as const };
            return (
              <View key={ev.id} style={s.row} testID={`journal-row-${ev.id}`}>
                <View style={[
                  s.badge,
                  { backgroundColor: isOn ? COLORS.success : COLORS.error },
                ]}>
                  <Ionicons
                    name={isOn ? "play" : "stop"}
                    size={14}
                    color="#fff"
                  />
                </View>

                <View style={{ flex: 1, marginLeft: SPACING.md }}>
                  <View style={s.rowTitle}>
                    <Ionicons name={meta.icon as any} size={16} color={COLORS.textSecondary} />
                    <Text style={s.rowName}>
                      {meta.label} — {isOn ? "démarrage" : "arrêt"}
                    </Text>
                  </View>
                  <Text style={s.rowMeta}>
                    {formatTs(ev.ts)}
                    {"   ·   "}
                    <Text style={{ color: COLORS.textSecondary }}>
                      {SOURCE_LABEL[ev.source] || ev.source}
                    </Text>
                  </Text>
                  {ev.reason && (
                    <Text style={s.rowReason} numberOfLines={2}>{ev.reason}</Text>
                  )}
                </View>

                <View style={s.stats}>
                  {!isOn && ev.duration_seconds != null && (
                    <View style={s.stat}>
                      <Text style={s.statLabel}>Durée</Text>
                      <Text style={s.statValue}>{formatDuration(ev.duration_seconds)}</Text>
                    </View>
                  )}
                  {ev.water_temp != null && (
                    <View style={s.stat}>
                      <Text style={s.statLabel}>Eau</Text>
                      <Text style={[s.statValue, { color: COLORS.metricTemp }]}>
                        {ev.water_temp.toFixed(1)}°C
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  headRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: SPACING.sm,
  },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700" },
  refreshBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceTertiary,
  },
  refreshText: { color: COLORS.textSecondary, fontSize: FS.sm, fontWeight: "600" },
  subtitle: { color: COLORS.textMuted, fontSize: FS.sm, marginBottom: SPACING.lg },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACING.sm, marginBottom: SPACING.lg },
  chip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceSecondary,
  },
  chipText: { color: COLORS.textMuted, fontSize: FS.sm, fontWeight: "600" },
  list: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg,
    padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border,
  },
  empty: { color: COLORS.textMuted, padding: SPACING.md, textAlign: "center" },
  row: {
    flexDirection: "row", alignItems: "flex-start",
    paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  badge: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center", marginTop: 2,
  },
  rowTitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
  rowMeta: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  rowReason: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2, fontStyle: "italic" },
  stats: { flexDirection: "row", gap: SPACING.md, alignItems: "center" },
  stat: {
    minWidth: 70, alignItems: "center", paddingHorizontal: 8,
  },
  statLabel: { color: COLORS.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  statValue: { color: COLORS.text, fontSize: FS.base, fontWeight: "700", marginTop: 2 },
});
