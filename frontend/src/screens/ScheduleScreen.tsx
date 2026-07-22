import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ScrollView, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Sched = { id: string; start: string; end: string; enabled: boolean };
type Props = {
  schedules: Sched[];
  totalHours: number;
  recommended?: number | null;
  waterTemp: number;
  reload: () => void;
};

export const ScheduleScreen: React.FC<Props> = ({ schedules, totalHours, recommended, waterTemp, reload }) => {
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("12:00");
  const [applying, setApplying] = useState(false);

  async function add() {
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return;
    await api.addSchedule({ start, end, enabled: true });
    reload();
  }
  async function toggle(sc: Sched) {
    await api.updateSchedule(sc.id, { ...sc, enabled: !sc.enabled });
    reload();
  }
  async function del(id: string) {
    await api.deleteSchedule(id);
    reload();
  }
  async function applyAuto() {
    setApplying(true);
    try {
      await api.autoApplySchedule();
      reload();
    } catch {}
    setApplying(false);
  }

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="schedule-screen">
      <Text style={s.title}>Programmation filtration</Text>

      <View style={s.info}>
        <View style={s.infoBox}>
          <Text style={s.infoLabel}>Total programmé</Text>
          <Text style={s.infoVal}>{totalHours} h / jour</Text>
        </View>
        <View style={s.infoBox}>
          <Text style={s.infoLabel}>Recommandé (T° / 2)</Text>
          <Text style={[s.infoVal, { color: COLORS.metricTemp }]}>
            {recommended != null ? `${recommended} h` : "—"}
          </Text>
          <Text style={s.infoLabel}>Eau : {waterTemp.toFixed(1)} °C</Text>
        </View>
        <View style={[s.infoBox, { justifyContent: "center", alignItems: "flex-start" }]}>
          <Text style={s.infoLabel}>Auto-planning (chaque nuit)</Text>
          <Pressable
            onPress={applyAuto}
            disabled={applying}
            style={[s.autoBtn, applying && { opacity: 0.6 }]}
            testID="apply-auto-schedule"
          >
            <Ionicons name="sparkles" size={18} color="#fff" />
            <Text style={s.autoBtnText}>{applying ? "Application…" : "Appliquer maintenant"}</Text>
          </Pressable>
          <Text style={s.hint}>Remplace les créneaux par le calcul temp/2.</Text>
        </View>
      </View>

      <Text style={s.section}>Plages horaires</Text>
      <View style={s.card}>
        {schedules.map((sc) => (
          <View key={sc.id} style={s.row} testID={`sched-row-${sc.id}`}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowText}>{sc.start} – {sc.end}</Text>
              <Text style={s.sub}>{sc.enabled ? "Actif" : "Désactivé"}</Text>
            </View>
            <Switch
              value={sc.enabled}
              onValueChange={() => toggle(sc)}
              trackColor={{ false: COLORS.surfaceTertiary, true: COLORS.success }}
              testID={`sched-toggle-${sc.id}`}
            />
            <Pressable onPress={() => del(sc.id)} style={s.trash} testID={`sched-del-${sc.id}`}>
              <Ionicons name="trash" size={18} color={COLORS.error} />
            </Pressable>
          </View>
        ))}
      </View>

      <Text style={s.section}>Ajouter une plage</Text>
      <View style={[s.card, { flexDirection: "row", alignItems: "center", gap: SPACING.md }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.sub}>Début</Text>
          <TextInput value={start} onChangeText={setStart} style={s.input} placeholder="HH:MM"
            placeholderTextColor={COLORS.textMuted} testID="input-start" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.sub}>Fin</Text>
          <TextInput value={end} onChangeText={setEnd} style={s.input} placeholder="HH:MM"
            placeholderTextColor={COLORS.textMuted} testID="input-end" />
        </View>
        <Pressable onPress={add} style={s.addBtn} testID="add-schedule">
          <Ionicons name="add" size={22} color="#fff" />
          <Text style={{ color: "#fff", fontWeight: "600" }}>Ajouter</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.lg },
  section: { color: COLORS.textSecondary, fontSize: FS.lg, marginTop: SPACING.xl, marginBottom: SPACING.md, fontWeight: "600" },
  info: { flexDirection: "row", gap: SPACING.md },
  infoBox: {
    flex: 1, backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg,
    padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.border,
  },
  infoLabel: { color: COLORS.textMuted, fontSize: FS.sm },
  infoVal: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginVertical: SPACING.xs },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.lg,
    borderWidth: 1, borderColor: COLORS.border,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.sm,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, gap: SPACING.md,
  },
  rowText: { color: COLORS.text, fontSize: FS.lg, fontWeight: "600" },
  sub: { color: COLORS.textMuted, fontSize: FS.sm },
  trash: { padding: SPACING.sm },
  input: {
    backgroundColor: COLORS.surfaceTertiary, color: COLORS.text, borderRadius: RADIUS.md,
    padding: SPACING.md, marginTop: SPACING.xs, borderWidth: 1, borderColor: COLORS.border,
  },
  addBtn: {
    backgroundColor: COLORS.brand, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, flexDirection: "row", alignItems: "center", gap: SPACING.xs,
    alignSelf: "flex-end",
  },
  autoBtn: {
    backgroundColor: COLORS.brand, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
    borderRadius: RADIUS.md, flexDirection: "row", alignItems: "center", gap: SPACING.xs,
    marginTop: SPACING.sm,
  },
  autoBtnText: { color: "#fff", fontSize: FS.base, fontWeight: "700" },
  hint: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: SPACING.xs },
});
