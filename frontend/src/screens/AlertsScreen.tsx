import React from "react";
import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type A = { id: string; level: string; title: string; message: string; acknowledged: boolean; ts: string };
type Props = { alerts: A[]; reload: () => void };

export const AlertsScreen: React.FC<Props> = ({ alerts, reload }) => {
  async function ack(id: string) { await api.ackAlert(id); reload(); }
  async function clear() { await api.clearAlerts(); reload(); }
  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="alerts-screen">
      <View style={s.head}>
        <Text style={s.title}>Alertes</Text>
        <Pressable style={s.clear} onPress={clear} testID="clear-alerts">
          <Ionicons name="trash" size={16} color={COLORS.textSecondary} />
          <Text style={{ color: COLORS.textSecondary }}>Tout effacer</Text>
        </Pressable>
      </View>
      {alerts.length === 0 ? (
        <View style={[s.card, { alignItems: "center" }]}>
          <Ionicons name="checkmark-circle" size={40} color={COLORS.success} />
          <Text style={{ color: COLORS.textSecondary, marginTop: SPACING.md, fontSize: FS.lg }}>
            Aucune alerte
          </Text>
        </View>
      ) : (
        <View style={s.card}>
          {alerts.map((a) => (
            <View key={a.id} style={s.row} testID={`alert-row-${a.id}`}>
              <Ionicons
                name={a.level === "error" ? "alert-circle" : a.level === "warning" ? "warning" : "information-circle"}
                size={22}
                color={a.level === "error" ? COLORS.error : a.level === "warning" ? COLORS.warning : COLORS.info}
              />
              <View style={{ flex: 1, marginLeft: SPACING.md }}>
                <Text style={s.rowTitle}>{a.title}</Text>
                <Text style={s.rowMsg}>{a.message}</Text>
                <Text style={s.rowTs}>{new Date(a.ts).toLocaleString("fr-FR")}</Text>
              </View>
              {!a.acknowledged && (
                <Pressable onPress={() => ack(a.id)} style={s.ackBtn} testID={`ack-${a.id}`}>
                  <Text style={{ color: "#fff", fontWeight: "600" }}>OK</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: SPACING.lg },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700" },
  clear: {
    flexDirection: "row", alignItems: "center", gap: SPACING.xs,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    backgroundColor: COLORS.surfaceTertiary, borderRadius: RADIUS.md,
  },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.lg,
    borderWidth: 1, borderColor: COLORS.border,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  rowTitle: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
  rowMsg: { color: COLORS.textMuted, fontSize: FS.sm, marginTop: 2 },
  rowTs: { color: COLORS.textMuted, fontSize: 10, marginTop: 4 },
  ackBtn: {
    backgroundColor: COLORS.success, paddingHorizontal: SPACING.lg, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
  },
});
