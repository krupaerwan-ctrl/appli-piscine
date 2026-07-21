import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";
import { EquipmentCard } from "../components/Widgets";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

type EqEvent = {
  id: string;
  equipment_id: string;
  action: "on" | "off";
  source: string;
  reason: string | null;
  ts: string;
};

const NAME_MAP: Record<string, string> = {
  filtration: "Filtration",
  electrolyseur: "Électrolyseur",
  heat_pump: "Pompe à chaleur",
  lighting: "Éclairage",
};

const SOURCE_MAP: Record<string, { label: string; color: string }> = {
  user: { label: "Utilisateur", color: COLORS.brand },
  safety: { label: "Sécurité", color: COLORS.error },
  coupling: { label: "Couplage auto", color: COLORS.warning },
  schedule: { label: "Programmation", color: COLORS.metricPh },
  mqtt: { label: "Zigbee", color: COLORS.metricSalinity },
};

export const EquipmentPage: React.FC<{ data: any; reload: () => void; onToggleEquipment: (id: string, next: boolean) => Promise<void> }> = ({ data, reload, onToggleEquipment }) => {
  const [events, setEvents] = useState<EqEvent[]>([]);
  const [filter, setFilter] = useState<string>("all");

  const loadEvents = useCallback(async () => {
    try {
      const q = filter === "all" ? "" : `?equipment_id=${filter}`;
      const r = await fetch(`${BASE}/api/equipment/events${q}`);
      const d = await r.json();
      setEvents(d.events || []);
    } catch {}
  }, [filter]);

  useEffect(() => {
    loadEvents();
    const t = setInterval(loadEvents, 8000);
    return () => clearInterval(t);
  }, [loadEvents]);

  async function toggle(id: string, next: boolean) {
    await onToggleEquipment(id, next);
    setTimeout(loadEvents, 700);
  }

  return (
    <ScrollView
      style={s.wrap}
      contentContainerStyle={{ padding: SPACING.xl, gap: SPACING.md, paddingBottom: SPACING.xxl * 2 }}
      testID="equipment-screen"
    >
      <EquipmentCard items={data.equipment || []} onToggle={toggle} />

      <View style={s.card} testID="equipment-events-card">
        <View style={s.headRow}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACING.sm }}>
            <Ionicons name="time" size={18} color={COLORS.textSecondary} />
            <Text style={s.title}>Journal des évènements</Text>
          </View>
          <Pressable onPress={loadEvents} style={s.refreshBtn} testID="events-refresh">
            <Ionicons name="refresh" size={16} color={COLORS.textSecondary} />
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: SPACING.xs, paddingVertical: SPACING.xs }}>
          {[
            { k: "all", l: "Tous" },
            { k: "filtration", l: "Filtration" },
            { k: "electrolyseur", l: "Électrolyseur" },
            { k: "heat_pump", l: "PAC" },
            { k: "lighting", l: "Éclairage" },
          ].map((f) => (
            <Pressable
              key={f.k}
              onPress={() => setFilter(f.k)}
              style={[s.chip, filter === f.k && s.chipActive]}
              testID={`events-filter-${f.k}`}
            >
              <Text style={[s.chipText, filter === f.k && s.chipTextActive]}>{f.l}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {events.length === 0 ? (
          <Text style={s.empty}>Aucun évènement enregistré pour le moment.</Text>
        ) : (
          events.map((e) => {
            const src = SOURCE_MAP[e.source] || { label: e.source, color: COLORS.textMuted };
            return (
              <View key={e.id} style={s.row} testID={`event-row-${e.id}`}>
                <View style={[
                  s.actionDot,
                  { backgroundColor: e.action === "on" ? COLORS.success : COLORS.textMuted },
                ]}>
                  <Ionicons
                    name={e.action === "on" ? "power" : "stop"}
                    size={14} color="#fff"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>
                    {NAME_MAP[e.equipment_id] || e.equipment_id}
                    {"  "}
                    <Text style={{ color: e.action === "on" ? COLORS.success : COLORS.textMuted }}>
                      {e.action === "on" ? "démarrage" : "arrêt"}
                    </Text>
                  </Text>
                  {e.reason && <Text style={s.rowSub}>{e.reason}</Text>}
                  <Text style={s.rowTs}>
                    {new Date(e.ts).toLocaleString("fr-FR")}
                  </Text>
                </View>
                <View style={[s.sourceBadge, { borderColor: src.color }]}>
                  <Text style={[s.sourceText, { color: src.color }]}>{src.label}</Text>
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
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.lg,
    borderWidth: 1, borderColor: COLORS.border,
  },
  headRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: SPACING.sm,
  },
  title: { color: COLORS.text, fontSize: FS.lg, fontWeight: "600" },
  refreshBtn: {
    padding: SPACING.sm, backgroundColor: COLORS.surfaceTertiary, borderRadius: RADIUS.md,
  },
  chip: {
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, borderRadius: RADIUS.pill,
    backgroundColor: COLORS.surfaceTertiary, borderWidth: 1, borderColor: COLORS.border,
    flexShrink: 0,
  },
  chipActive: { borderColor: COLORS.brand, backgroundColor: COLORS.brand + "22" },
  chipText: { color: COLORS.textMuted, fontSize: FS.sm },
  chipTextActive: { color: COLORS.brand, fontWeight: "600" },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.sm,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: SPACING.md,
  },
  actionDot: {
    width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center",
  },
  rowTitle: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
  rowSub: { color: COLORS.textSecondary, fontSize: FS.sm, marginTop: 2 },
  rowTs: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  sourceBadge: {
    paddingHorizontal: SPACING.sm, paddingVertical: 2, borderRadius: RADIUS.pill,
    borderWidth: 1, alignSelf: "flex-start",
  },
  sourceText: { fontSize: 10, fontWeight: "600" },
  empty: { color: COLORS.textMuted, fontSize: FS.sm, fontStyle: "italic", padding: SPACING.md },
});
