import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ImageBackground } from "react-native";
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
      <ImageBackground
        source={{ uri: "https://images.pexels.com/photos/9754666/pexels-photo-9754666.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940" }}
        style={s.bg}
        imageStyle={{ opacity: 0.55 }}
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
      </ImageBackground>
    </Pressable>
  );
};

const s = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center" },
  overlay: {
    flex: 1, justifyContent: "center", alignItems: "center", width: "100%",
    backgroundColor: "rgba(10,14,26,0.45)", padding: SPACING.xxl,
  },
  time: { color: "#fff", fontSize: 96, fontWeight: "300", letterSpacing: 4 },
  date: { color: COLORS.textSecondary, fontSize: FS.lg, textTransform: "capitalize", marginTop: SPACING.sm },
  tempBox: { marginTop: SPACING.xxl, alignItems: "center" },
  tempLabel: { color: COLORS.textMuted, fontSize: FS.base },
  tempValue: { color: COLORS.brand, fontSize: 56, fontWeight: "600", marginTop: SPACING.sm },
  hint: { position: "absolute", bottom: 40, color: COLORS.textMuted, fontSize: FS.sm },
});
