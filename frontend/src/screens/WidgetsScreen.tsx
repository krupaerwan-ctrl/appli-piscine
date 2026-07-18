import React from "react";
import { View, Text, StyleSheet, Switch, ScrollView } from "react-native";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";
import { api } from "../lib/api";

type Widget = { id: string; name: string; enabled: boolean; order: number };
type Props = { widgets: Widget[]; onChange: (w: Widget[]) => void };

export const WidgetsScreen: React.FC<Props> = ({ widgets, onChange }) => {
  async function toggle(w: Widget) {
    const next = widgets.map((it) => (it.id === w.id ? { ...it, enabled: !it.enabled } : it));
    onChange(next);
    await api.updateWidgets(next);
  }
  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ padding: SPACING.xl }} testID="widgets-screen">
      <Text style={s.title}>Gestion des widgets</Text>
      <Text style={s.sub}>Activez ou désactivez les widgets affichés sur le tableau de bord.</Text>
      <View style={s.card}>
        {widgets.map((w) => (
          <View key={w.id} style={s.row} testID={`widget-row-${w.id}`}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{w.name}</Text>
              <Text style={s.sub}>{w.enabled ? "Affiché" : "Masqué"}</Text>
            </View>
            <Switch
              testID={`widget-toggle-${w.id}`}
              value={w.enabled}
              onValueChange={() => toggle(w)}
              trackColor={{ false: COLORS.surfaceTertiary, true: COLORS.success }}
            />
          </View>
        ))}
      </View>
    </ScrollView>
  );
};

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: COLORS.surface },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.xs },
  sub: { color: COLORS.textMuted, fontSize: FS.sm, marginBottom: SPACING.lg },
  card: {
    backgroundColor: COLORS.surfaceSecondary, borderRadius: RADIUS.lg, padding: SPACING.lg,
    borderWidth: 1, borderColor: COLORS.border,
  },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  name: { color: COLORS.text, fontSize: FS.lg, fontWeight: "600" },
});
