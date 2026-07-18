import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, FS } from "../lib/theme";

type Props = { outdoorTemp?: number };

export const TopHeader: React.FC<Props> = ({ outdoorTemp = 28 }) => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  return (
    <View style={styles.wrap} testID="top-header">
      <Text style={styles.title}>Tableau de bord</Text>
      <View style={styles.right}>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.time}>{time}</Text>
          <Text style={styles.date}>{date}</Text>
        </View>
        <View style={styles.weather}>
          <Ionicons name="sunny" size={22} color={COLORS.warning} />
          <Text style={styles.weatherText}>{outdoorTemp} °C</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    height: 64,
    paddingHorizontal: SPACING.xl,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.surface,
  },
  title: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "600" },
  right: { flexDirection: "row", alignItems: "center", gap: SPACING.lg },
  time: { color: COLORS.text, fontSize: FS.xl, fontWeight: "600" },
  date: { color: COLORS.textMuted, fontSize: FS.sm },
  weather: { flexDirection: "row", alignItems: "center", gap: SPACING.xs },
  weatherText: { color: COLORS.text, fontSize: FS.lg, fontWeight: "500" },
});
