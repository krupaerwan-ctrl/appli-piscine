import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS, SPACING, FS } from "../lib/theme";

type Props = { waterTemp: number; onWake: () => void };

export const Screensaver: React.FC<Props> = ({ waterTemp, onWake }) => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const time = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return (
    <Pressable onPress={onWake} style={StyleSheet.absoluteFill} testID="screensaver">
      <LinearGradient
        colors={["#020617", "#0A1628", "#00253F", "#001428"]}
        locations={[0, 0.35, 0.7, 1]}
        style={s.bg}
      >
        <View style={s.overlay}>
          <Text style={s.time}>{time}</Text>
          <Text style={s.date}>{date}</Text>
          <View style={s.tempBox}>
            <Text style={s.tempLabel}>Température de l'eau</Text>
            <Text style={s.tempValue}>{waterTemp.toFixed(1)} °C</Text>
          </View>
          <Text style={s.hint}>Toucher l'écran pour réveiller</Text>
        </View>
      </LinearGradient>
    </Pressable>
  );
};

const s = StyleSheet.create({
  bg: { flex: 1, justifyContent: "center", alignItems: "center" },
  overlay: {
    flex: 1, justifyContent: "center", alignItems: "center", width: "100%",
    padding: SPACING.xxl,
  },
  time: { color: "#fff", fontSize: 96, fontWeight: "300", letterSpacing: 4 },
  date: { color: COLORS.textSecondary, fontSize: FS.lg, textTransform: "capitalize", marginTop: SPACING.sm },
  tempBox: { marginTop: SPACING.xxl, alignItems: "center" },
  tempLabel: { color: COLORS.textMuted, fontSize: FS.base },
  tempValue: { color: COLORS.brand, fontSize: 56, fontWeight: "600", marginTop: SPACING.sm },
  hint: { position: "absolute", bottom: 40, color: COLORS.textMuted, fontSize: FS.sm },
});
