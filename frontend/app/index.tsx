import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet, Pressable, Text, ScrollView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { COLORS, SPACING, FS } from "../src/lib/theme";
import { Sidebar } from "../src/components/Sidebar";
import { TopHeader } from "../src/components/TopHeader";
import { Screensaver } from "../src/components/Screensaver";
import { DashboardScreen } from "../src/screens/DashboardScreen";
import { ScheduleScreen } from "../src/screens/ScheduleScreen";
import { WidgetsScreen } from "../src/screens/WidgetsScreen";
import { AlertsScreen } from "../src/screens/AlertsScreen";
import { HistoryScreen } from "../src/screens/HistoryScreen";
import { SettingsScreen } from "../src/screens/SettingsScreen";
import {
  TempWaveCard, MetricCard, HistoryChartCard, EquipmentCard, PressureCard,
} from "../src/components/Widgets";
import { api } from "../src/lib/api";

// --- Kiosk touch/no-cursor styles (web build on Raspberry Pi) ---
if (Platform.OS === "web" && typeof document !== "undefined") {
  const styleId = "kiosk-touch-styles";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      html, body, #root, * {
        cursor: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        -webkit-tap-highlight-color: transparent !important;
        -webkit-touch-callout: none !important;
        touch-action: manipulation;
        overscroll-behavior: contain;
      }
      input, textarea {
        cursor: text !important;
        -webkit-user-select: text !important;
        user-select: text !important;
      }
      /* Smooth touch scroll on webkit */
      div[style*="overflow"] { -webkit-overflow-scrolling: touch !important; }
      /* Kill focus outlines that flash on touch */
      *:focus { outline: none !important; }
      /* Hide native scrollbars in kiosk mode */
      ::-webkit-scrollbar { width: 0; height: 0; }
    `;
    document.head.appendChild(style);
  }
}

function headerTitle(key: string): string {
  switch (key) {
    case "home": return "Tableau de bord";
    case "temperature": return "Température";
    case "water": return "Qualité de l'eau";
    case "equipment": return "Équipements";
    case "schedule": return "Programmation";
    case "history": return "Historique";
    case "alerts": return "Alertes";
    case "widgets": return "Widgets";
    case "settings": return "Paramètres";
    default: return "Tableau de bord";
  }
}

export default function Index() {
  const [active, setActive] = useState("home");
  const [data, setData] = useState<any>(null);
  const [idle, setIdle] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [history24, setHistory24] = useState<any[]>([]);
  const idleTimer = useRef<any>(null);

  // -------- Polling summary + alerts every 5s --------
  const reload = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([api.summary(), api.alerts()]);
      setData(d);
      setAlerts(a.alerts || []);
    } catch (e) {
      console.log("reload err", e);
    }
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);

  // temperature history for dashboard
  useEffect(() => {
    const load = () => api.history("temp", 24).then((r) => {
      setHistory24(r.points.map((p: any) => ({
        value: p.value, label: new Date(p.ts).getHours() + "h",
      })));
    }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // -------- Idle screensaver --------
  const sleepMin = (data?.settings?.screen_sleep_minutes ?? 5);
  const resetIdle = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), sleepMin * 60 * 1000);
  }, [sleepMin]);

  useEffect(() => {
    resetIdle();
    return () => idleTimer.current && clearTimeout(idleTimer.current);
  }, [resetIdle]);

  const handleWidgetsChange = (w: any[]) => setData({ ...data, widgets: w });
  const handleSettingsSaved = (s: any) => setData({ ...data, settings: s });

  const sensors: Record<string, any> = {};
  (data?.sensors || []).forEach((r: any) => (sensors[r.metric] = r));

  const renderContent = () => {
    if (!data) {
      return (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: COLORS.textMuted }}>Connexion MQTT…</Text>
        </View>
      );
    }
    switch (active) {
      case "home":
        return <DashboardScreen data={data} reload={reload} />;
      case "temperature":
        return (
          <ScrollView contentContainerStyle={{ padding: SPACING.xl, gap: SPACING.md }}
            testID="temperature-screen">
            <Text style={styles.pageTitle}>Température de l'eau</Text>
            <View style={{ flexDirection: "row", gap: SPACING.md }}>
              <TempWaveCard value={sensors.temp?.value ?? 0} target={data.settings.temp_target ?? 28} />
              <View style={{ flex: 2 }}>
                <HistoryChartCard points={history24} />
              </View>
            </View>
          </ScrollView>
        );
      case "water":
        return (
          <ScrollView contentContainerStyle={{ padding: SPACING.xl, gap: SPACING.md }}
            testID="water-screen">
            <Text style={styles.pageTitle}>Qualité de l'eau</Text>
            <View style={{ flexDirection: "row", gap: SPACING.md, flexWrap: "wrap" }}>
              <MetricCard label="pH" icon="water-outline" color={COLORS.metricPh}
                value={(sensors.ph?.value ?? 0).toFixed(2)} unit=""
                target={`Consigne : ${data.settings.ph_min} – ${data.settings.ph_max}`}
                min={6.8} max={7.6} current={sensors.ph?.value ?? 7} />
              <MetricCard label="Redox (ORP)" icon="sync-circle" color={COLORS.metricOrp}
                value={sensors.orp?.value ?? 0} unit="mV"
                target={`Consigne : ${data.settings.orp_min} – ${data.settings.orp_max} mV`}
                min={450} max={850} current={sensors.orp?.value ?? 650} />
              <MetricCard label="Sel (Salinité)" icon="sparkles" color={COLORS.metricSalinity}
                value={sensors.salinity?.value ?? 0} unit="ppm"
                target={`Consigne : ${data.settings.salinity_min} – ${data.settings.salinity_max} ppm`}
                min={2500} max={4500} current={sensors.salinity?.value ?? 3500} />
              <PressureCard
                pressure={sensors.pressure?.value ?? 0}
                min={data.settings.pressure_min ?? 0.5}
                max={data.settings.pressure_max ?? 1.5}
              />
            </View>
          </ScrollView>
        );
      case "equipment":
        return (
          <ScrollView contentContainerStyle={{ padding: SPACING.xl }} testID="equipment-screen">
            <Text style={styles.pageTitle}>Équipements</Text>
            <EquipmentCard
              items={data.equipment || []}
              onToggle={async (id, v) => { await api.toggleEquipment(id, v); reload(); }}
            />
          </ScrollView>
        );
      case "schedule":
        return (
          <ScheduleScreen
            schedules={data.schedules}
            totalHours={data.schedules.reduce((acc: number, s: any) => {
              if (!s.enabled) return acc;
              const [sh, sm] = s.start.split(":").map(Number);
              const [eh, em] = s.end.split(":").map(Number);
              const a = sh + sm / 60; const b = eh + em / 60;
              return acc + (b > a ? b - a : 24 - a + b);
            }, 0)}
            recommended={data.recommended_filtration_hours}
            waterTemp={sensors.temp?.value ?? 0}
            reload={reload}
          />
        );
      case "history":
        return <HistoryScreen />;
      case "alerts":
        return <AlertsScreen alerts={alerts} reload={reload} />;
      case "widgets":
        return <WidgetsScreen widgets={data.widgets || []} onChange={handleWidgetsChange} />;
      case "settings":
        return <SettingsScreen settings={data.settings} onSaved={handleSettingsSaved} />;
    }
    return null;
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={styles.root} onTouchStart={resetIdle}>
      <StatusBar style="light" />
      <View style={styles.shell}>
        <Sidebar
          active={active}
          onSelect={(k) => { setActive(k); resetIdle(); }}
          mqttOk={data?.system?.mqtt === "OK"}
          systemOk={data?.system?.sensors === "OK"}
        />
        <View style={{ flex: 1 }}>
          <TopHeader outdoorTemp={sensors.outdoor_temp?.value ?? 28} title={headerTitle(active)} />
          <View style={{ flex: 1 }}>{renderContent()}</View>
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              🍓 Appli piscine – Raspberry Pi
            </Text>
          </View>
        </View>
      </View>
      {idle && (
        <View style={StyleSheet.absoluteFill}>
          <Screensaver
            waterTemp={sensors.temp?.value ?? 0}
            onWake={resetIdle}
          />
        </View>
      )}
    </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.surface },
  shell: { flex: 1, flexDirection: "row" },
  pageTitle: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.md },
  footer: {
    height: 32, backgroundColor: COLORS.surface, borderTopWidth: 1, borderTopColor: COLORS.border,
    alignItems: "center", justifyContent: "center",
  },
  footerText: { color: COLORS.textMuted, fontSize: FS.sm },
});
