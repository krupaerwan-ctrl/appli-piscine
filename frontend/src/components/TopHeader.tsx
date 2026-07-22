import React, { useEffect, useState, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS, SPACING, FS } from "../lib/theme";
import { api } from "../lib/api";

type Props = { outdoorTemp?: number; title?: string };

type WifiStatus = {
  available: boolean;
  connected: boolean;
  ssid: string | null;
  signal_percent: number | null;
  signal_dbm: number | null;
  ip: string | null;
  iface: string | null;
};

const DEFAULT_WIFI: WifiStatus = {
  available: false,
  connected: false,
  ssid: null,
  signal_percent: null,
  signal_dbm: null,
  ip: null,
  iface: null,
};

function wifiIconName(w: WifiStatus): keyof typeof Ionicons.glyphMap {
  if (!w.available) return "wifi-outline";
  if (!w.connected) return "cloud-offline-outline";
  const p = w.signal_percent ?? 0;
  if (p >= 66) return "wifi";
  if (p >= 33) return "wifi";
  return "wifi-outline";
}

function wifiColor(w: WifiStatus): string {
  if (!w.available) return COLORS.textMuted;
  if (!w.connected) return COLORS.error;
  const p = w.signal_percent ?? 0;
  if (p >= 66) return COLORS.success;
  if (p >= 33) return COLORS.warning;
  return COLORS.error;
}

function wifiLabel(w: WifiStatus): string {
  if (!w.available) return "N/A";
  if (!w.connected) return "Hors-ligne";
  if (w.signal_percent == null) return "OK";
  return `${w.signal_percent}%`;
}

export const TopHeader: React.FC<Props> = ({ outdoorTemp = 28, title = "Tableau de bord" }) => {
  const [now, setNow] = useState(new Date());
  const [wifi, setWifi] = useState<WifiStatus>(DEFAULT_WIFI);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshWifi = useCallback(async () => {
    try {
      const w = await api.wifi();
      setWifi({ ...DEFAULT_WIFI, ...w });
    } catch {
      setWifi(DEFAULT_WIFI);
    }
  }, []);

  useEffect(() => {
    refreshWifi();
    const t = setInterval(refreshWifi, 10000);
    return () => clearInterval(t);
  }, [refreshWifi]);

  const time = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  return (
    <View style={styles.wrap} testID="top-header">
      <Text style={styles.title}>{title}</Text>
      <View style={styles.right}>
        <Pressable
          onPress={() => {
            refreshWifi();
            setDetailsOpen(true);
          }}
          style={({ pressed }) => [styles.wifi, pressed && { opacity: 0.7 }]}
          testID="wifi-indicator"
          hitSlop={8}
        >
          <Ionicons name={wifiIconName(wifi)} size={22} color={wifiColor(wifi)} />
          <Text style={[styles.wifiText, { color: wifiColor(wifi) }]}>{wifiLabel(wifi)}</Text>
        </Pressable>

        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.time}>{time}</Text>
          <Text style={styles.date}>{date}</Text>
        </View>
        <View style={styles.weather}>
          <Ionicons name="sunny" size={22} color={COLORS.warning} />
          <Text style={styles.weatherText}>{outdoorTemp} °C</Text>
        </View>
      </View>

      <Modal
        visible={detailsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDetailsOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setDetailsOpen(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.cardHeader}>
              <Ionicons name={wifiIconName(wifi)} size={28} color={wifiColor(wifi)} />
              <Text style={styles.cardTitle}>Réseau WiFi</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Statut</Text>
              <Text style={[styles.rowValue, { color: wifiColor(wifi) }]}>
                {wifi.available ? (wifi.connected ? "Connecté" : "Déconnecté") : "Indisponible"}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Réseau (SSID)</Text>
              <Text style={styles.rowValue}>{wifi.ssid || "—"}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Signal</Text>
              <Text style={styles.rowValue}>
                {wifi.signal_percent != null ? `${wifi.signal_percent} %` : "—"}
                {wifi.signal_dbm != null ? `  (${wifi.signal_dbm} dBm)` : ""}
              </Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Adresse IP</Text>
              <Text style={styles.rowValue}>{wifi.ip || "—"}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Interface</Text>
              <Text style={styles.rowValue}>{wifi.iface || "—"}</Text>
            </View>

            <View style={styles.cardActions}>
              <Pressable
                style={styles.actionBtn}
                onPress={refreshWifi}
                testID="wifi-refresh"
              >
                <Ionicons name="refresh" size={18} color={COLORS.text} />
                <Text style={styles.actionText}>Actualiser</Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: COLORS.brand }]}
                onPress={() => setDetailsOpen(false)}
                testID="wifi-close"
              >
                <Text style={[styles.actionText, { color: "#fff" }]}>Fermer</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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
  wifi: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: COLORS.surfaceSecondary,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  wifiText: { fontSize: FS.base, fontWeight: "600" },
  time: { color: COLORS.text, fontSize: FS.xl, fontWeight: "600" },
  date: { color: COLORS.textMuted, fontSize: FS.sm },
  weather: { flexDirection: "row", alignItems: "center", gap: SPACING.xs },
  weatherText: { color: COLORS.text, fontSize: FS.lg, fontWeight: "500" },

  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: SPACING.xl,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: SPACING.xl,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  cardTitle: { color: COLORS.text, fontSize: FS.xl, fontWeight: "700" },  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  rowLabel: { color: COLORS.textMuted, fontSize: FS.base },
  rowValue: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
  cardActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: SPACING.sm,
    marginTop: SPACING.lg,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceSecondary,
  },
  actionText: { color: COLORS.text, fontSize: FS.base, fontWeight: "600" },
});
