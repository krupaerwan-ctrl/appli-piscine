import React from "react";
import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, RADIUS, FS } from "../lib/theme";

export type NavItem = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
};

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "Accueil", icon: "home" },
  { key: "equipment", label: "Équipements", icon: "settings" },
  { key: "zigbee", label: "Appareils Zigbee", icon: "hardware-chip" },
  { key: "schedule", label: "Programmation", icon: "calendar" },
  { key: "history", label: "Historique", icon: "stats-chart" },
  { key: "alerts", label: "Alertes", icon: "notifications" },
  { key: "widgets", label: "Widgets", icon: "grid" },
  { key: "settings", label: "Paramètres", icon: "cog" },
];

type Props = {
  active: string;
  onSelect: (k: string) => void;
  mqttOk: boolean;
  systemOk: boolean;
};

export const Sidebar: React.FC<Props> = ({ active, onSelect, mqttOk, systemOk }) => {
  return (
    <View style={styles.wrap} testID="sidebar">
      <View style={styles.brand}>
        <Ionicons name="water" size={26} color={COLORS.brand} />
        <Text style={styles.brandText}>APPLI PISCINE</Text>
      </View>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {NAV_ITEMS.map((item) => {
          const isActive = active === item.key;
          return (
            <Pressable
              key={item.key}
              testID={`nav-${item.key}`}
              onPress={() => onSelect(item.key)}
              style={[styles.item, isActive && styles.itemActive]}
            >
              <Ionicons
                name={item.icon}
                size={20}
                color={isActive ? COLORS.brand : COLORS.textMuted}
              />
              <Text style={[styles.label, isActive && styles.labelActive]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.status}>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: systemOk ? COLORS.success : COLORS.error }]} />
          <Text style={styles.statusText}>Système opérationnel</Text>
        </View>
        <View style={styles.statusRow}>
          <Ionicons name="wifi" size={12} color={mqttOk ? COLORS.success : COLORS.error} />
          <Text style={styles.statusText}>MQTT {mqttOk ? "connecté" : "déconnecté"}</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    width: 220,
    backgroundColor: COLORS.surface,
    borderRightWidth: 1,
    borderRightColor: COLORS.border,
    paddingVertical: SPACING.lg,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.xl,
  },
  brandText: { color: COLORS.text, fontSize: FS.lg, fontWeight: "700", letterSpacing: 2 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    marginHorizontal: SPACING.md,
    borderRadius: RADIUS.md,
  },
  itemActive: { backgroundColor: COLORS.surfaceTertiary },
  label: { color: COLORS.textMuted, fontSize: FS.base, fontWeight: "500" },
  labelActive: { color: COLORS.text, fontWeight: "600" },
  status: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    gap: SPACING.xs,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: SPACING.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: COLORS.textMuted, fontSize: FS.sm },
});
