import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, StyleSheet, Pressable, Text, ScrollView, Platform, useWindowDimensions, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
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
import { ZigbeeScreen } from "../src/screens/ZigbeeScreen";
import { EquipmentPage } from "../src/screens/EquipmentPage";
import { MaintenanceScreen } from "../src/screens/MaintenanceScreen";
import { JournalScreen } from "../src/screens/JournalScreen";
import { TouchScrollbar } from "../src/components/TouchScrollbar";
import {
  TempWaveCard, MetricCard, HistoryChartCard, EquipmentCard, PressureCard,
} from "../src/components/Widgets";
import { api } from "../src/lib/api";
import { usePushRegistration } from "../src/lib/push";

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
      }
      input, textarea {
        cursor: text !important;
        -webkit-user-select: text !important;
        user-select: text !important;
      }
      /* Enable smooth touch scroll everywhere (Raspberry Pi Chromium/Wayland) */
      html, body {
        -webkit-overflow-scrolling: touch !important;
        overscroll-behavior: contain;
        touch-action: pan-y !important;
      }
      /* React Native Web ScrollView renders as a div with inline overflow.
         Force touch-action to allow both axes so drag-to-scroll always works. */
      div[style*="overflow-y"], div[style*="overflow: auto"],
      div[style*="overflow: scroll"], div[style*="overflow: hidden scroll"] {
        touch-action: pan-x pan-y !important;
        -webkit-overflow-scrolling: touch !important;
      }
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
    case "equipment": return "Équipements";
    case "schedule": return "Programmation";
    case "maintenance": return "Maintenance";
    case "journal": return "Journal d'événements";
    case "history": return "Historique";
    case "alerts": return "Alertes";
    case "widgets": return "Widgets";
    case "settings": return "Paramètres";
    case "zigbee": return "Appareils Zigbee";
    default: return "Tableau de bord";
  }
}

export default function Index() {
  const [active, setActive] = useState("home");
  const [data, setData] = useState<any>(null);
  const [idle, setIdle] = useState(false);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [history24, setHistory24] = useState<any[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const idleTimer = useRef<any>(null);
  const toastTimer = useRef<any>(null);
  const { width } = useWindowDimensions();
  const isMobile = width < 720;

  // Register this phone with the push relay (no-op on web / no-op on Pi kiosk)
  usePushRegistration(process.env.EXPO_PUBLIC_BACKEND_URL || "");

  // Central equipment toggle with OPTIMISTIC UI + coupling mirrored client-side
  const handleToggleEquipment = useCallback(async (id: string, next: boolean) => {
    setData((prev: any) => {
      if (!prev?.equipment) return prev;
      const equipment = prev.equipment.map((e: any) => {
        if (e.id === id) return { ...e, state: next };
        // Coupling: stopping pump also stops electrolyseur instantly
        if (id === "filtration" && !next && e.id === "electrolyseur")
          return { ...e, state: false };
        return e;
      });
      return { ...prev, equipment };
    });
    try {
      await api.toggleEquipment(id, next);
    } catch (e: any) {
      // Backend refused (e.g. electro without pump) — show a toast, reload will revert UI
      const msg = String(e?.message || "").includes("électrolyseur")
        ? "L'électrolyseur ne peut pas fonctionner sans la pompe. Démarrez d'abord la filtration."
        : "Action refusée par le système.";
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(msg);
      toastTimer.current = setTimeout(() => setToast(null), 4500);
    }
    reload();
  }, []);

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
        return <DashboardScreen data={data} reload={reload} onToggleEquipment={handleToggleEquipment} onNavigate={setActive} />;
      case "equipment":
        return <EquipmentPage data={data} reload={reload} onToggleEquipment={handleToggleEquipment} />;
      case "maintenance":
        return <MaintenanceScreen />;
      case "journal":
        return <JournalScreen />;
      case "schedule":
        return (
          <ScheduleScreen
            schedules={data.schedules}
            totalHours={Math.round(data.schedules.reduce((acc: number, s: any) => {
              if (!s.enabled) return acc;
              const [sh, sm] = s.start.split(":").map(Number);
              const [eh, em] = s.end.split(":").map(Number);
              const a = sh + sm / 60; const b = eh + em / 60;
              return acc + (b > a ? b - a : 24 - a + b);
            }, 0) * 10) / 10}
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
      case "zigbee":
        return <ZigbeeScreen />;
    }
    return null;
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={styles.root} onTouchStart={resetIdle}>
      <StatusBar style="light" />
      <View style={[styles.shell, isMobile && { flexDirection: "column" }]}>
        {/* Desktop / kiosque : sidebar fixe */}
        {!isMobile && (
          <Sidebar
            active={active}
            onSelect={(k) => { setActive(k); resetIdle(); }}
            mqttOk={data?.system?.mqtt === "OK"}
            systemOk={data?.system?.sensors === "OK"}
          />
        )}
        {/* Mobile : drawer coulissant (via Modal) */}
        {isMobile && (
          <Modal
            visible={drawerOpen}
            transparent
            animationType="slide"
            onRequestClose={() => setDrawerOpen(false)}
          >
            <Pressable style={styles.drawerBackdrop} onPress={() => setDrawerOpen(false)}>
              <Pressable style={styles.drawerPanel} onPress={() => {}}>
                <Sidebar
                  active={active}
                  onSelect={(k) => { setActive(k); resetIdle(); setDrawerOpen(false); }}
                  mqttOk={data?.system?.mqtt === "OK"}
                  systemOk={data?.system?.sensors === "OK"}
                />
              </Pressable>
            </Pressable>
          </Modal>
        )}

        <View style={{ flex: 1 }}>
          <TopHeader
            outdoorTemp={sensors.outdoor_temp?.value ?? 28}
            title={headerTitle(active)}
            compact={isMobile}
            leftAdornment={isMobile ? (
              <Pressable
                onPress={() => setDrawerOpen(true)}
                style={styles.hamburger}
                hitSlop={10}
                testID="mobile-menu"
              >
                <Ionicons name="menu" size={26} color={COLORS.text} />
              </Pressable>
            ) : null}
          />
          <View style={{ flex: 1, paddingRight: (!isMobile && Platform.OS === "web") ? 56 : 0 }}>{renderContent()}</View>
          {!isMobile && <TouchScrollbar />}
          {toast && (
            <View style={[styles.toast, isMobile && styles.toastMobile]} testID="global-toast">
              <Text style={styles.toastText}>{toast}</Text>
            </View>
          )}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              🍓 Appli piscine – Raspberry Pi
            </Text>
          </View>
        </View>
      </View>
      {idle && !isMobile && (
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
  hamburger: {
    width: 44, height: 44, alignItems: "center", justifyContent: "center",
    borderRadius: 22, marginLeft: -6,
  },
  drawerBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.5)",
  },
  drawerPanel: {
    width: 260, height: "100%", backgroundColor: COLORS.surface,
    borderRightWidth: 1, borderRightColor: COLORS.border,
  },
  pageTitle: { color: COLORS.text, fontSize: FS.xxl, fontWeight: "700", marginBottom: SPACING.md },
  footer: {
    height: 32, backgroundColor: COLORS.surface, borderTopWidth: 1, borderTopColor: COLORS.border,
    alignItems: "center", justifyContent: "center",
  },
  footerText: { color: COLORS.textMuted, fontSize: FS.sm },
  toast: {
    position: "absolute", bottom: 60, left: "50%", transform: [{ translateX: -220 }],
    width: 440, backgroundColor: COLORS.error, paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md, borderRadius: 12, zIndex: 200,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  toastMobile: {
    width: "90%", left: "5%", transform: [{ translateX: 0 }], bottom: 100,
  },
  toastText: { color: "#fff", fontSize: FS.base, textAlign: "center", fontWeight: "600" },
});
